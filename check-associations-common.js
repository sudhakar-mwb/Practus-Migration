/**
 * Shared library for the check-all-*-records-associations.js diagnostic
 * scripts. For every record already listed in destination_record_ids.json's
 * mapping for one primary object type, reads that record's Contact/Company/
 * Deal associations from the SOURCE portal and checks whether each
 * associated record has already been migrated to the DESTINATION portal -
 * using the destination_record_ids.json snapshot (tm_contact_record_id /
 * tm_company_record_id / tm_deal_record_id), rather than one live
 * destination search per association.
 *
 * This is a read-only spot-check across the whole dataset - it never
 * creates, updates, or deletes anything in either portal.
 *
 * REQUIRED ENV VAR: SOURCE_HUBSPOT_TOKEN
 *   (DESTINATION_HUBSPOT_TOKEN is NOT required - destination lookups are
 *   answered from destination_record_ids.json, not a live API call, so run
 *   fetch-destination-record-ids.js first to refresh that snapshot.)
 * OPTIONAL ENV VARS:
 *   REQUEST_DELAY_MS   Delay between outbound HubSpot API calls, in ms. Defaults to 200.
 *   MAX_RETRIES        Max retry attempts for 429/5xx responses. Defaults to 5.
 *   HUBSPOT_API_BASE   Override the API base URL (used for local testing against a mock server).
 *   MAPPING_FILE       Path to destination_record_ids.json. Defaults to ./destination_record_ids.json.
 *   OUTPUT_DIR         Directory to write the report JSON file into. Defaults to cwd.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HUBSPOT_API_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
const REQUEST_DELAY_MS = Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 200;
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES, 10) || 5;
const MAPPING_FILE = process.env.MAPPING_FILE || path.join(process.cwd(), 'destination_record_ids.json');
const OUTPUT_DIR = process.env.OUTPUT_DIR || process.cwd();

const OBJECT_TYPES = ['contacts', 'companies', 'deals'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

class HubSpotApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HubSpotApiError';
    this.status = status ?? null;
    this.body = body ?? null;
  }
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

/** Minimal HubSpot client with 429/5xx retry + backoff. */
function createClient(token, label) {
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
        if (attempt > MAX_RETRIES) throw new HubSpotApiError(`[${label}] Network error calling ${method} ${urlPath}: ${networkErr.message}`, {});
        const backoffMs = Math.min(2000 * 2 ** (attempt - 1), 30000);
        console.warn(`[warn][${label}] Network error on ${method} ${urlPath} (attempt ${attempt}), retrying in ${backoffMs}ms`);
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

/**
 * Batch-reads associations for many "from" records at once. Returns
 * Map<fromId, Array<{toObjectId, associationTypes}>>.
 */
async function batchReadAssociations(client, fromObjectType, toObjectType, fromIds) {
  const resultMap = new Map();
  for (const chunk of chunkArray(fromIds, 1000)) {
    if (chunk.length === 0) continue;
    const body = { inputs: chunk.map((id) => ({ id })) };
    const response = await client.request('POST', `/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/read`, body);
    const results = response && Array.isArray(response.results) ? response.results : [];
    for (const entry of results) {
      const fromId = String(entry.from.id);
      const to = (entry.to || []).map((t) => ({ toObjectId: String(t.toObjectId), associationTypes: t.associationTypes || [] }));
      resultMap.set(fromId, to);
    }
  }
  return resultMap;
}

function loadDestinationMapping() {
  if (!fs.existsSync(MAPPING_FILE)) {
    throw new Error(`Mapping file not found: ${MAPPING_FILE}. Run fetch-destination-record-ids.js first.`);
  }
  const data = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
  const maps = {};
  for (const objectType of OBJECT_TYPES) {
    maps[objectType] = new Map(Object.entries((data[objectType] && data[objectType].mapping) || {}));
  }
  return maps;
}

/**
 * Runs the full check for one primary object type and writes the report to
 * `<OUTPUT_DIR>/<outputFileName>`.
 */
async function runAssociationCheck(primaryObjectType, outputFileName) {
  const sourceToken = process.env.SOURCE_HUBSPOT_TOKEN;
  if (!sourceToken) {
    console.error('[fatal] SOURCE_HUBSPOT_TOKEN environment variable is required.');
    process.exitCode = 1;
    return;
  }
  if (!OBJECT_TYPES.includes(primaryObjectType)) {
    throw new Error(`Unknown object type "${primaryObjectType}". Must be one of: ${OBJECT_TYPES.join(', ')}`);
  }

  const outputPath = path.join(OUTPUT_DIR, outputFileName);
  const destinationMaps = loadDestinationMapping();
  const primaryIds = [...destinationMaps[primaryObjectType].keys()];
  if (primaryIds.length === 0) {
    console.error(`[fatal] No entries found in ${primaryObjectType}.mapping in ${MAPPING_FILE}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`[info] Checking ${primaryIds.length} ${primaryObjectType} record(s) from ${MAPPING_FILE}...`);

  const sourceClient = createClient(sourceToken, 'source');

  const perRecordReports = new Map(primaryIds.map((id) => [id, {
    sourceRecordId: id,
    destinationRecordId: destinationMaps[primaryObjectType].get(id),
    associations: [],
  }]));

  const counters = { totalAssociations: 0, foundInDestination: 0, notFoundInDestination: 0 };

  for (const targetObjectType of OBJECT_TYPES) {
    console.log(`[info] Reading ${primaryObjectType} -> ${targetObjectType} associations from the source portal...`);
    let assocMap;
    try {
      assocMap = await batchReadAssociations(sourceClient, primaryObjectType, targetObjectType, primaryIds);
    } catch (err) {
      console.error(`[error] Failed to read ${primaryObjectType} -> ${targetObjectType} associations: ${err.message}`);
      continue;
    }

    for (const [sourceFromId, toEntries] of assocMap.entries()) {
      for (const toEntry of toEntries) {
        counters.totalAssociations += 1;
        const destinationId = destinationMaps[targetObjectType].get(toEntry.toObjectId) || null;
        if (destinationId) counters.foundInDestination += 1;
        else counters.notFoundInDestination += 1;

        perRecordReports.get(sourceFromId).associations.push({
          associatedSourceObjectType: targetObjectType,
          associatedSourceRecordId: toEntry.toObjectId,
          associationTypes: toEntry.associationTypes,
          foundInDestination: Boolean(destinationId),
          destinationRecordId: destinationId,
        });
      }
    }
  }

  const report = [...perRecordReports.values()];
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');

  const recordsWithMissingAssociations = report.filter((r) => r.associations.some((a) => !a.foundInDestination)).length;

  console.log(`\n${capitalize(primaryObjectType)} association check completed\n`);
  console.log(`Primary object type: ${primaryObjectType}`);
  console.log(`${primaryObjectType} checked: ${primaryIds.length}`);
  console.log(`Associations found in source: ${counters.totalAssociations}`);
  console.log(`Already present in destination: ${counters.foundInDestination}`);
  console.log(`NOT yet present in destination: ${counters.notFoundInDestination}`);
  console.log(`${primaryObjectType} with at least one not-yet-migrated association: ${recordsWithMissingAssociations}`);
  console.log(`\nDetailed report written to:\n${outputPath}`);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = {
  OBJECT_TYPES,
  createClient,
  batchReadAssociations,
  loadDestinationMapping,
  runAssociationCheck,
  HubSpotApiError,
};
