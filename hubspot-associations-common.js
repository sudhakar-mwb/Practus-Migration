/**
 * Shared library for HubSpot-to-HubSpot Contact/Company/Deal association
 * migration. Required by migrate-contact-associations.js,
 * migrate-company-associations.js, and migrate-deal-associations.js - those
 * three files are thin entry points that each call migratePrimaryObjectAssociations()
 * below with a different "primary" object type. Keeping the HTTP client,
 * pagination, mapping, association-type resolution, batching, and logging
 * logic in one place avoids maintaining three near-identical copies of the
 * same ~700 lines.
 *
 * HubSpot API surfaces used (verified against HubSpot's official developer
 * docs before writing this):
 *   - CRM object list:      GET  /crm/v3/objects/{objectType}                              (paginated, results+paging.next.after)
 *   - Associations (read):  GET  /crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/{toObjectType}   (paginated)
 *   - Associations (batch read):  POST /crm/v4/associations/{fromObjectType}/{toObjectType}/batch/read          (<=1000 inputs)
 *   - Associations (batch create, labeled): POST /crm/v4/associations/{fromObjectType}/{toObjectType}/batch/create (<=2000 inputs)
 *   - Association label definitions: GET /crm/v4/associations/{fromObjectType}/{toObjectType}/labels
 *
 * KEY FACTS THAT SHAPE THIS DESIGN (from HubSpot's docs):
 *   1. HUBSPOT_DEFINED association typeIds (e.g. 279 = contact->company
 *      unlabeled, 1 = contact->primary company, 4 = contact->deal, ...) are
 *      part of a single global table and are IDENTICAL across every HubSpot
 *      portal. They can be reused as-is without any lookup.
 *   2. USER_DEFINED (custom) association labels get a portal-specific
 *      numeric typeId when created. The same label name can (and usually
 *      will) have a DIFFERENT typeId in the destination portal, so custom
 *      labels must be resolved by matching the label TEXT against the
 *      destination portal's label definitions for that object pair - never
 *      by reusing the source typeId.
 *   3. HubSpot's own docs warn that calling the labeled-associate endpoint
 *      with a subset of the labels that already exist between two records
 *      REPLACES the existing set rather than adding to it. To guarantee we
 *      never strip a label that's already on a destination pair (whether
 *      from a prior migration run or something set manually), every create
 *      call in this library first reads the destination pair's current
 *      types and sends the UNION of (existing + newly resolved) types.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration shared by all three entry scripts
// ---------------------------------------------------------------------------

const HUBSPOT_API_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
const REQUEST_DELAY_MS = Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 200;
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES, 10) || 5;
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

// Threshold at which a batch/read "to" list for one record is treated as
// possibly-truncated and re-fetched via the paginated single-record endpoint
// to guarantee completeness (see fetchRecordAssociationsPaginated below).
// HubSpot does not publicly document a hard per-record cap on batch/read, so
// this is a conservative safety margin, not a known exact limit.
const BATCH_READ_COMPLETENESS_THRESHOLD = 90;

const OBJECT_TYPES = ['contacts', 'companies', 'deals'];

const MIGRATION_PROPERTY_BY_TYPE = {
  contacts: 'tm_contact_record_id',
  companies: 'tm_company_record_id',
  deals: 'tm_deal_record_id',
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[warn] Could not read/parse ${filePath}, starting fresh (${err.message})`);
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// HubSpot HTTP client - retries on 429/5xx, respects Retry-After, throws a
// typed error carrying the HTTP status and parsed body for every other
// non-2xx response so callers can log full detail rather than swallowing it.
// ---------------------------------------------------------------------------

class HubSpotApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HubSpotApiError';
    this.status = status ?? null;
    this.body = body ?? null;
  }
}

function createHubSpotClient(token, label) {
  async function request(method, urlPath, jsonBody) {
    if (typeof fetch !== 'function') {
      throw new Error('Global fetch is not available. Run this script with Node.js 18 or newer.');
    }
    const url = `${HUBSPOT_API_BASE}${urlPath}`;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);

      let response;
      try {
        response = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
        });
      } catch (networkErr) {
        if (attempt > MAX_RETRIES) {
          throw new HubSpotApiError(`[${label}] Network error calling ${method} ${urlPath}: ${networkErr.message}`, {});
        }
        const backoffMs = Math.min(2000 * 2 ** (attempt - 1), 30000);
        console.warn(`[warn][${label}] Network error on ${method} ${urlPath} (attempt ${attempt}), retrying in ${backoffMs}ms: ${networkErr.message}`);
        await sleep(backoffMs);
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt > MAX_RETRIES) {
          const body = await safeReadBody(response);
          throw new HubSpotApiError(`[${label}] ${method} ${urlPath} failed after ${MAX_RETRIES} retries with status ${response.status}`, { status: response.status, body });
        }
        const retryAfterHeader = response.headers.get('retry-after');
        const backoffMs = retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))
          ? Number(retryAfterHeader) * 1000
          : Math.min(1000 * 2 ** (attempt - 1), 30000);
        console.warn(`[warn][${label}] ${response.status} from ${method} ${urlPath} (attempt ${attempt}/${MAX_RETRIES}), waiting ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }

      if (!response.ok) {
        const body = await safeReadBody(response);
        throw new HubSpotApiError(`[${label}] ${method} ${urlPath} responded with ${response.status}`, { status: response.status, body });
      }

      if (response.status === 204) return null;
      return safeReadBody(response);
    }
  }

  return { request, label };
}

async function safeReadBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Record listing / destination ID mapping
// ---------------------------------------------------------------------------

/** Pages through every (non-archived) record of objectType, returning just their IDs. */
async function fetchAllRecordIds(client, objectType) {
  const ids = [];
  let after;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    const page = await client.request('GET', `/crm/v3/objects/${objectType}?${query.toString()}`);
    const results = page && Array.isArray(page.results) ? page.results : [];
    for (const r of results) ids.push(String(r.id));
    after = page && page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : undefined;
  } while (after);
  return ids;
}

/**
 * Scans every record of objectType in the destination portal and builds a
 * sourceId -> destinationId map from the migration property that stores the
 * original source record ID (tm_contact_record_id / tm_company_record_id /
 * tm_deal_record_id). This is the ONLY way source and destination records
 * are correlated - destination record IDs must never be assumed equal to
 * source record IDs.
 */
async function buildDestinationIdMap(destClient, objectType) {
  const migrationProperty = MIGRATION_PROPERTY_BY_TYPE[objectType];
  const map = new Map();
  let after;
  do {
    const query = new URLSearchParams({ limit: '100', properties: migrationProperty });
    if (after) query.set('after', after);
    const page = await destClient.request('GET', `/crm/v3/objects/${objectType}?${query.toString()}`);
    const results = page && Array.isArray(page.results) ? page.results : [];
    for (const r of results) {
      const sourceId = r.properties && r.properties[migrationProperty];
      if (sourceId) map.set(String(sourceId), String(r.id));
    }
    after = page && page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : undefined;
  } while (after);
  return map;
}

// ---------------------------------------------------------------------------
// Association reads
// ---------------------------------------------------------------------------

/** Fully paginated association read for a single record - the completeness fallback. */
async function fetchRecordAssociationsPaginated(client, fromObjectType, fromId, toObjectType) {
  const results = [];
  let after;
  do {
    const query = new URLSearchParams({ limit: '500' });
    if (after) query.set('after', after);
    const page = await client.request('GET', `/crm/v4/objects/${fromObjectType}/${fromId}/associations/${toObjectType}?${query.toString()}`);
    const pageResults = page && Array.isArray(page.results) ? page.results : [];
    results.push(...pageResults);
    after = page && page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : undefined;
  } while (after);
  return results.map((r) => ({ toObjectId: String(r.toObjectId), associationTypes: r.associationTypes || [] }));
}

/**
 * Batch-reads associations for many "from" records at once (fast path), then
 * - because HubSpot doesn't document a per-record pagination guarantee on
 * batch/read - falls back to the fully-paginated single-record read for any
 * "from" record whose "to" list is large enough that it might have been
 * truncated. Returns Map<fromId, Array<{toObjectId, associationTypes}>>.
 */
async function batchReadAssociations(client, fromObjectType, toObjectType, fromIds) {
  const resultMap = new Map();
  const needsFallback = [];

  for (const chunk of chunkArray(fromIds, 1000)) {
    if (chunk.length === 0) continue;
    const body = { inputs: chunk.map((id) => ({ id })) };
    const response = await client.request('POST', `/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/read`, body);
    const results = response && Array.isArray(response.results) ? response.results : [];
    for (const entry of results) {
      const fromId = String(entry.from.id);
      const to = (entry.to || []).map((t) => ({ toObjectId: String(t.toObjectId), associationTypes: t.associationTypes || [] }));
      resultMap.set(fromId, to);
      if (to.length >= BATCH_READ_COMPLETENESS_THRESHOLD) needsFallback.push(fromId);
    }
  }

  for (const fromId of needsFallback) {
    console.warn(`[warn] ${fromObjectType}/${fromId} has a large number of ${toObjectType} associations; re-fetching with full pagination to guarantee completeness.`);
    resultMap.set(fromId, await fetchRecordAssociationsPaginated(client, fromObjectType, fromId, toObjectType));
  }

  return resultMap;
}

// ---------------------------------------------------------------------------
// Association label / type resolution
// ---------------------------------------------------------------------------

const labelDefinitionCache = new Map(); // key: `${client.label}:${from}:${to}` -> definitions array

async function getAssociationLabelDefinitions(client, fromObjectType, toObjectType) {
  const cacheKey = `${client.label}:${fromObjectType}:${toObjectType}`;
  if (labelDefinitionCache.has(cacheKey)) return labelDefinitionCache.get(cacheKey);
  const response = await client.request('GET', `/crm/v4/associations/${fromObjectType}/${toObjectType}/labels`);
  const definitions = (response && response.results) || [];
  labelDefinitionCache.set(cacheKey, definitions);
  return definitions;
}

/**
 * Resolves each source association type to its destination-portal
 * equivalent:
 *   - HUBSPOT_DEFINED types reuse the same typeId as-is (these are
 *     standardized across all HubSpot portals).
 *   - USER_DEFINED (and any other non-HUBSPOT_DEFINED category) types are
 *     resolved by matching the source `label` text against the destination
 *     portal's label definitions for the same object pair. If no match
 *     exists, the type is reported as unsupported rather than guessed at.
 */
function resolveDestinationTypes({ sourceTypes, destLabelDefs }) {
  const resolved = [];
  const unsupported = [];

  for (const sourceType of sourceTypes) {
    if (sourceType.category === 'HUBSPOT_DEFINED') {
      resolved.push({ category: 'HUBSPOT_DEFINED', typeId: sourceType.typeId, label: sourceType.label ?? null });
      continue;
    }
    const match = destLabelDefs.find((d) => d.category !== 'HUBSPOT_DEFINED' && d.label === sourceType.label);
    if (match) {
      resolved.push({ category: match.category, typeId: match.typeId, label: match.label ?? null });
    } else {
      unsupported.push({
        sourceCategory: sourceType.category,
        sourceTypeId: sourceType.typeId,
        sourceLabel: sourceType.label ?? null,
        reason: `No association label named "${sourceType.label}" exists between these object types in the destination portal.`,
      });
    }
  }

  return { resolved, unsupported };
}

// ---------------------------------------------------------------------------
// Association writes
// ---------------------------------------------------------------------------

/**
 * Batch-creates labeled associations. `inputs` is an array of
 * { fromId, toId, types: [{category, typeId}] } where `types` MUST already
 * be the full desired set (existing + new) for that pair - see the
 * module-level doc comment on why partial type lists are unsafe.
 * On a 207 (partial failure) response, the whole chunk is resubmitted one
 * pair at a time so every failure can be attributed to its specific pair
 * rather than lost inside an opaque batch error.
 */
async function batchCreateAssociations(client, fromObjectType, toObjectType, inputs) {
  const succeeded = []; // { fromId, toId, labels }
  const failed = []; // { fromId, toId, status, body }

  for (const chunk of chunkArray(inputs, 2000)) {
    if (chunk.length === 0) continue;
    const body = {
      inputs: chunk.map((i) => ({
        from: { id: i.fromId },
        to: { id: i.toId },
        types: i.types.map((t) => ({ associationCategory: t.category, associationTypeId: t.typeId })),
      })),
    };

    try {
      const response = await client.request('POST', `/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/create`, body);
      const results = (response && response.results) || [];
      for (const r of results) succeeded.push({ fromId: String(r.fromObjectId), toId: String(r.toObjectId), labels: r.labels || [] });

      if (response && Array.isArray(response.errors) && response.errors.length > 0) {
        // 207: isolate the failures by resubmitting this chunk one pair at a
        // time so each failure can be logged with its own from/to/error.
        const succeededKeys = new Set(succeeded.map((s) => `${s.fromId}:${s.toId}`));
        const retryTargets = chunk.filter((i) => !succeededKeys.has(`${i.fromId}:${i.toId}`));
        await createIndividually(client, fromObjectType, toObjectType, retryTargets, succeeded, failed);
      }
    } catch (err) {
      // The whole chunk failed outright (e.g. a single malformed input can
      // reject an entire batch) - fall back to one-at-a-time so we still get
      // per-pair attribution instead of losing the whole chunk's results.
      await createIndividually(client, fromObjectType, toObjectType, chunk, succeeded, failed);
    }
  }

  return { succeeded, failed };
}

async function createIndividually(client, fromObjectType, toObjectType, items, succeeded, failed) {
  for (const item of items) {
    try {
      const body = item.types.map((t) => ({ associationCategory: t.category, associationTypeId: t.typeId }));
      const result = await client.request(
        'PUT',
        `/crm/v4/objects/${fromObjectType}/${item.fromId}/associations/${toObjectType}/${item.toId}`,
        body
      );
      succeeded.push({ fromId: item.fromId, toId: item.toId, labels: (result && result.labels) || [] });
    } catch (err) {
      failed.push({
        fromId: item.fromId,
        toId: item.toId,
        status: err instanceof HubSpotApiError ? err.status : null,
        body: err instanceof HubSpotApiError ? err.body : String(err.message || err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestrator - shared by all three entry scripts. Each one only differs by
// which object type is "primary" (the one whose full record list drives the
// migration) and which log-file directory to use.
// ---------------------------------------------------------------------------

const OUTPUT_DIR = process.env.OUTPUT_DIR || process.cwd();
const SUCCESS_LOG_PATH = path.join(OUTPUT_DIR, 'association_migration_success.json');
const ERROR_LOG_PATH = path.join(OUTPUT_DIR, 'association_migration_errors.json');
const MAPPING_LOG_PATH = path.join(OUTPUT_DIR, 'association_migration_mapping.json');

function loadLogState() {
  return {
    successLog: readJsonFile(SUCCESS_LOG_PATH, []),
    errorLog: readJsonFile(ERROR_LOG_PATH, []),
  };
}

function saveLogState(state) {
  writeJsonFile(SUCCESS_LOG_PATH, state.successLog);
  writeJsonFile(ERROR_LOG_PATH, state.errorLog);
}

function keyOf(category, typeId) {
  return `${category}:${typeId}`;
}

async function fetchPortalId(client) {
  try {
    const details = await client.request('GET', '/account-info/v3/details');
    return details ? details.portalId : null;
  } catch {
    return null;
  }
}

async function migratePrimaryObjectAssociations(primaryObjectType) {
  const sourceToken = process.env.SOURCE_HUBSPOT_TOKEN;
  const destToken = process.env.DESTINATION_HUBSPOT_TOKEN;

  if (!sourceToken || !destToken) {
    console.error('[fatal] SOURCE_HUBSPOT_TOKEN and DESTINATION_HUBSPOT_TOKEN environment variables are both required.');
    process.exitCode = 1;
    return;
  }
  if (sourceToken === destToken) {
    console.error('[fatal] SOURCE_HUBSPOT_TOKEN and DESTINATION_HUBSPOT_TOKEN are identical. Refusing to run.');
    process.exitCode = 1;
    return;
  }

  const sourceClient = createHubSpotClient(sourceToken, 'source');
  const destClient = createHubSpotClient(destToken, 'destination');

  const [sourcePortalId, destPortalId] = await Promise.all([fetchPortalId(sourceClient), fetchPortalId(destClient)]);
  if (sourcePortalId && destPortalId) {
    console.log(`[info] Source portal ID: ${sourcePortalId} | Destination portal ID: ${destPortalId}`);
    if (sourcePortalId === destPortalId) {
      console.error('[fatal] Source and destination tokens both resolve to the same HubSpot portal ID. Aborting.');
      process.exitCode = 1;
      return;
    }
  } else {
    console.log('[info] Could not verify source/destination portal IDs - proceeding anyway.');
  }
  if (DRY_RUN) console.log('[info] DRY_RUN=true - no associations will be created in the destination portal.');

  const state = loadLogState();
  const counters = {
    found: 0, created: 0, alreadyExisted: 0, skipped: 0, failed: 0,
    destNotFound: 0, unsupportedTypes: 0, validationFailures: 0,
  };
  const recordsProcessed = { contacts: new Set(), companies: new Set(), deals: new Set() };

  // --- Build source->destination ID maps for ALL three object types, since
  //     a primary record's associations can point at any of the three. ---
  console.log('[info] Building destination record ID maps (via tm_*_record_id properties)...');
  const destIdMaps = {};
  for (const objectType of OBJECT_TYPES) {
    destIdMaps[objectType] = await buildDestinationIdMap(destClient, objectType);
    console.log(`[info] Destination ${objectType}: ${destIdMaps[objectType].size} record(s) with a source-ID mapping.`);
  }

  // Persist the mapping snapshot immediately - it's derived purely from a
  // live destination scan, so it's safe/expected to overwrite on every run.
  const mappingSnapshot = {};
  for (const objectType of OBJECT_TYPES) mappingSnapshot[objectType] = Object.fromEntries(destIdMaps[objectType]);
  writeJsonFile(MAPPING_LOG_PATH, mappingSnapshot);

  console.log(`[info] Fetching all ${primaryObjectType} from the source portal...`);
  const primaryIds = await fetchAllRecordIds(sourceClient, primaryObjectType);
  console.log(`[info] Found ${primaryIds.length} ${primaryObjectType} record(s) in the source portal.`);
  for (const id of primaryIds) recordsProcessed[primaryObjectType].add(id);

  // Processes one (primaryObjectType -> targetObjectType) relationship pass
  // in full: read source associations, resolve destination IDs/types, fetch
  // existing destination associations, create what's missing, validate.
  // Extracted into its own function (rather than inlined in the loop below)
  // so the loop can wrap each pass in try/catch - a problem processing one
  // relationship type (e.g. deals) must not prevent the others (e.g.
  // contacts, companies) from being migrated.
  async function processObjectPair(targetObjectType) {
    const sourceAssocMap = await batchReadAssociations(sourceClient, primaryObjectType, targetObjectType, primaryIds);
    const destLabelDefs = await getAssociationLabelDefinitions(destClient, primaryObjectType, targetObjectType);

    // --- Resolve every discovered pair to destination IDs + destination
    //     association types before touching the destination portal. ---
    const pairIntents = []; // { destFromId, destToId, resolvedTypes, sourceRecordId, associatedSourceRecordId, sourceTypes }

    // Self-referencing pairs (contacts-contacts, companies-companies,
    // deals-deals) are inherently bidirectional in HubSpot: if A and B are
    // associated, that single relationship is returned from BOTH A's and
    // B's association list. Since the primary-record loop visits both A and
    // B, the same relationship would otherwise be discovered (and queued
    // for creation) twice. Dedupe by an order-independent key so it's
    // processed once.
    const selfPairSeen = primaryObjectType === targetObjectType ? new Set() : null;

    for (const [sourceFromId, toEntries] of sourceAssocMap.entries()) {
      for (const toEntry of toEntries) {
        if (selfPairSeen) {
          const normalizedKey = [sourceFromId, toEntry.toObjectId].sort().join(':');
          if (selfPairSeen.has(normalizedKey)) continue;
          selfPairSeen.add(normalizedKey);
        }

        counters.found += 1;
        recordsProcessed[targetObjectType].add(toEntry.toObjectId);

        const destFromId = destIdMaps[primaryObjectType].get(sourceFromId);
        const destToId = destIdMaps[targetObjectType].get(toEntry.toObjectId);

        if (!destFromId || !destToId) {
          counters.destNotFound += 1;
          state.errorLog.push({
            sourceObjectType: primaryObjectType,
            sourceRecordId: sourceFromId,
            associatedSourceObjectType: targetObjectType,
            associatedSourceRecordId: toEntry.toObjectId,
            destinationRecordId: destToId || null,
            associationType: `${primaryObjectType}_to_${targetObjectType}`,
            errorType: 'DESTINATION_RECORD_NOT_FOUND',
            errorMessage: !destFromId
              ? `No destination ${primaryObjectType} record found with ${MIGRATION_PROPERTY_BY_TYPE[primaryObjectType]} = ${sourceFromId}.`
              : `No destination ${targetObjectType} record found with ${MIGRATION_PROPERTY_BY_TYPE[targetObjectType]} = ${toEntry.toObjectId}.`,
            httpStatus: null,
            timestamp: nowIso(),
          });
          continue;
        }

        const { resolved, unsupported } = resolveDestinationTypes({ sourceTypes: toEntry.associationTypes, destLabelDefs });

        for (const u of unsupported) {
          counters.unsupportedTypes += 1;
          state.errorLog.push({
            sourceObjectType: primaryObjectType,
            sourceRecordId: sourceFromId,
            associatedSourceObjectType: targetObjectType,
            associatedSourceRecordId: toEntry.toObjectId,
            destinationRecordId: destToId,
            associationType: `${primaryObjectType}_to_${targetObjectType}`,
            errorType: 'UNSUPPORTED_ASSOCIATION_TYPE',
            errorMessage: u.reason,
            httpStatus: null,
            sourceAssociationCategory: u.sourceCategory,
            sourceAssociationTypeId: u.sourceTypeId,
            sourceAssociationLabel: u.sourceLabel,
            timestamp: nowIso(),
          });
        }

        if (resolved.length === 0) {
          counters.skipped += 1;
          continue;
        }

        pairIntents.push({
          destFromId, destToId, resolvedTypes: resolved,
          sourceRecordId: sourceFromId, associatedSourceRecordId: toEntry.toObjectId,
        });
      }
    }

    if (pairIntents.length === 0) return;

    // --- Fetch EXISTING destination associations for the "from" records
    //     we're about to touch, so we (a) never send a subset that would
    //     strip an existing label, and (b) can log already_exists cleanly. ---
    const destFromIdsToCheck = [...new Set(pairIntents.map((p) => p.destFromId))];
    const existingDestAssocMap = DRY_RUN ? new Map() : await batchReadAssociations(destClient, primaryObjectType, targetObjectType, destFromIdsToCheck);

    const createInputs = []; // { fromId, toId, types } - full union set
    const intentByPairKey = new Map(); // `${destFromId}:${destToId}` -> intent, for logging after create

    for (const intent of pairIntents) {
      const existingToList = existingDestAssocMap.get(intent.destFromId) || [];
      const existingEntry = existingToList.find((e) => e.toObjectId === intent.destToId);
      const existingTypes = existingEntry ? existingEntry.associationTypes : [];
      const existingKeys = new Set(existingTypes.map((t) => keyOf(t.category, t.typeId)));

      const newTypes = intent.resolvedTypes.filter((t) => !existingKeys.has(keyOf(t.category, t.typeId)));

      if (newTypes.length === 0) {
        counters.alreadyExisted += 1;
        for (const t of intent.resolvedTypes) {
          state.successLog.push(buildSuccessEntry(primaryObjectType, targetObjectType, intent, t, 'already_exists'));
        }
        continue;
      }

      const unionTypes = [...existingTypes.map((t) => ({ category: t.category, typeId: t.typeId })), ...newTypes];
      const pairKey = `${intent.destFromId}:${intent.destToId}`;
      intentByPairKey.set(pairKey, { intent, newTypes });

      if (!DRY_RUN) {
        createInputs.push({ fromId: intent.destFromId, toId: intent.destToId, types: unionTypes });
      } else {
        counters.created += 1;
        for (const t of newTypes) state.successLog.push(buildSuccessEntry(primaryObjectType, targetObjectType, intent, t, 'dry_run'));
      }
    }

    if (DRY_RUN || createInputs.length === 0) return;

    const { succeeded, failed } = await batchCreateAssociations(destClient, primaryObjectType, targetObjectType, createInputs);

    for (const s of succeeded) {
      const pairKey = `${s.fromId}:${s.toId}`;
      const entry = intentByPairKey.get(pairKey);
      if (!entry) continue;
      counters.created += 1;
      for (const t of entry.newTypes) state.successLog.push(buildSuccessEntry(primaryObjectType, targetObjectType, entry.intent, t, 'success'));
    }

    for (const f of failed) {
      const pairKey = `${f.fromId}:${f.toId}`;
      const entry = intentByPairKey.get(pairKey);
      counters.failed += 1;
      state.errorLog.push({
        sourceObjectType: primaryObjectType,
        sourceRecordId: entry ? entry.intent.sourceRecordId : null,
        associatedSourceObjectType: targetObjectType,
        associatedSourceRecordId: entry ? entry.intent.associatedSourceRecordId : null,
        destinationRecordId: f.toId,
        associationType: `${primaryObjectType}_to_${targetObjectType}`,
        errorType: 'ASSOCIATION_CREATE_FAILED',
        errorMessage: `Failed to create association between destination ${primaryObjectType} ${f.fromId} and ${targetObjectType} ${f.toId}.`,
        httpStatus: f.status,
        apiResponse: f.body,
        timestamp: nowIso(),
      });
    }

    // --- Validation: re-read the destination pairs we just created and
    //     confirm every intended type is actually present now. ---
    if (succeeded.length > 0) {
      const verifyFromIds = [...new Set(succeeded.map((s) => s.fromId))];
      const verifyMap = await batchReadAssociations(destClient, primaryObjectType, targetObjectType, verifyFromIds);
      for (const s of succeeded) {
        const pairKey = `${s.fromId}:${s.toId}`;
        const entry = intentByPairKey.get(pairKey);
        if (!entry) continue;
        const verifyToList = verifyMap.get(s.fromId) || [];
        const verifyEntry = verifyToList.find((e) => e.toObjectId === s.toId);
        const verifyKeys = new Set((verifyEntry ? verifyEntry.associationTypes : []).map((t) => keyOf(t.category, t.typeId)));
        const missing = entry.newTypes.filter((t) => !verifyKeys.has(keyOf(t.category, t.typeId)));
        if (missing.length > 0) {
          counters.validationFailures += 1;
          state.errorLog.push({
            sourceObjectType: primaryObjectType,
            sourceRecordId: entry.intent.sourceRecordId,
            associatedSourceObjectType: targetObjectType,
            associatedSourceRecordId: entry.intent.associatedSourceRecordId,
            destinationRecordId: s.toId,
            associationType: `${primaryObjectType}_to_${targetObjectType}`,
            errorType: 'VALIDATION_MISMATCH',
            errorMessage: 'Association create call succeeded but a post-create read did not confirm all expected types.',
            httpStatus: null,
            apiResponse: { missingTypes: missing },
            timestamp: nowIso(),
          });
        }
      }
    }

    saveLogState(state);
  }

  for (const targetObjectType of OBJECT_TYPES) {
    console.log(`\n[info] Processing ${primaryObjectType} -> ${targetObjectType} associations...`);
    try {
      await processObjectPair(targetObjectType);
    } catch (err) {
      console.error(`[error] Failed while processing ${primaryObjectType} -> ${targetObjectType} associations: ${err.message}`);
      state.errorLog.push({
        sourceObjectType: primaryObjectType,
        sourceRecordId: null,
        associatedSourceObjectType: targetObjectType,
        associatedSourceRecordId: null,
        destinationRecordId: null,
        associationType: `${primaryObjectType}_to_${targetObjectType}`,
        errorType: 'RELATIONSHIP_TYPE_PROCESSING_FAILED',
        errorMessage: err.message,
        httpStatus: err instanceof HubSpotApiError ? err.status : null,
        apiResponse: err instanceof HubSpotApiError ? err.body : null,
        timestamp: nowIso(),
      });
      saveLogState(state);
    }
  }

  saveLogState(state);

  console.log('\nHubSpot Association Migration Completed\n');
  console.log(`Contacts processed: ${recordsProcessed.contacts.size}`);
  console.log(`Companies processed: ${recordsProcessed.companies.size}`);
  console.log(`Deals processed: ${recordsProcessed.deals.size}\n`);
  console.log(`Associations found in source: ${counters.found}`);
  console.log(`Associations created: ${counters.created}`);
  console.log(`Associations already existed: ${counters.alreadyExisted}`);
  console.log(`Associations skipped: ${counters.skipped}`);
  console.log(`Associations failed: ${counters.failed}`);
  console.log(`Destination records not found: ${counters.destNotFound}`);
  console.log(`Unsupported association types: ${counters.unsupportedTypes}`);
  console.log(`Validation failures: ${counters.validationFailures}`);
  console.log('\nSuccess log:');
  console.log(SUCCESS_LOG_PATH);
  console.log('\nError log:');
  console.log(ERROR_LOG_PATH);
  console.log('\nMapping:');
  console.log(MAPPING_LOG_PATH);
}

function buildSuccessEntry(primaryObjectType, targetObjectType, intent, type, status) {
  return {
    sourceObjectType: primaryObjectType,
    sourceRecordId: intent.sourceRecordId,
    associatedSourceObjectType: targetObjectType,
    associatedSourceRecordId: intent.associatedSourceRecordId,
    destinationObjectType: targetObjectType,
    destinationRecordId: intent.destToId,
    destinationFromRecordId: intent.destFromId,
    associationType: `${primaryObjectType}_to_${targetObjectType}`,
    associationCategory: type.category,
    associationTypeId: type.typeId,
    associationLabel: type.label ?? null,
    status,
    timestamp: nowIso(),
  };
}

module.exports = {
  HUBSPOT_API_BASE,
  DRY_RUN,
  OBJECT_TYPES,
  MIGRATION_PROPERTY_BY_TYPE,
  HubSpotApiError,
  createHubSpotClient,
  nowIso,
  sleep,
  chunkArray,
  readJsonFile,
  writeJsonFile,
  fetchAllRecordIds,
  buildDestinationIdMap,
  fetchRecordAssociationsPaginated,
  batchReadAssociations,
  getAssociationLabelDefinitions,
  resolveDestinationTypes,
  batchCreateAssociations,
  migratePrimaryObjectAssociations,
};
