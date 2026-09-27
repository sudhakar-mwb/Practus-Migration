#!/usr/bin/env node
/**
 * migrate-calls.js
 *
 * Migrates every Call activity from a SOURCE HubSpot portal to a DESTINATION
 * HubSpot portal: properties, owner, and Contact/Company/Deal associations
 * (including association labels). Idempotent, resumable and duplicate-safe.
 *
 * ---------------------------------------------------------------------------
 * HUBSPOT API SURFACES USED (verified against developers.hubspot.com on
 * 2026-09-26; legacy /crm/v3 + /crm/v4 paths, same as the other scripts in
 * this project):
 *   Account          GET  /account-info/v3/details                      -> portalId
 *   Call properties  GET  /crm/v3/properties/calls                      (schema, modificationMetadata.readOnlyValue)
 *                    GET  /crm/v3/properties/{objectType}/{name}
 *                    GET  /crm/v3/properties/calls/groups
 *                    POST /crm/v3/properties/calls                      (hasUniqueValue supported, max 10 unique props/object)
 *   Calls            GET  /crm/v3/objects/calls?limit=100&after=        (paging.next.after)
 *                    POST /crm/v3/objects/calls/batch/read              (<=100; idProperty for unique custom props)
 *                    POST /crm/v3/objects/calls/search                  (5 req/s, 200/page, 10,000 result cap)
 *                    POST /crm/v3/objects/calls/batch/create            (<=100)
 *                    POST /crm/v3/objects/calls/batch/update            (<=100)
 *                    POST /crm/v3/objects/calls  / PATCH /crm/v3/objects/calls/{id}
 *   Owners           GET  /crm/v3/owners?archived=true|false
 *   Outcomes         GET  /calling/v1/dispositions                      -> [{id,label}]
 *   Associations v4  POST /crm/v4/associations/calls/{to}/batch/read    (<=1000 inputs)
 *                    POST /crm/v4/associations/calls/{to}/batch/create  (<=2000 inputs)
 *                    PUT  /crm/v4/objects/calls/{id}/associations/{to}/{toId}
 *                    GET  /crm/v4/associations/calls/{to}/labels
 *
 * KEY DOCUMENTED FACTS THIS DESIGN RELIES ON
 *   - HUBSPOT_DEFINED association type IDs are a single global table shared
 *     by every portal: call->contact 194, call->company 182, call->deal 206.
 *     USER_DEFINED labels get portal-specific type IDs, so they are resolved
 *     by label TEXT against the destination's label definitions.
 *   - "If you want to append labels ... include both labels in your
 *     request" - creating a labeled association with only the new label
 *     REPLACES existing labels. Every association write here therefore sends
 *     the UNION of the destination pair's existing types + the new types.
 *   - hs_timestamp is required when creating a call.
 *   - hs_call_disposition holds an outcome GUID. Default GUIDs are shared,
 *     custom outcomes are portal-specific -> mapped by label.
 *   - The destination record's `source_call_record_id` (configurable) is the
 *     ONLY migration identity. Source and destination call IDs are never
 *     assumed to be equal, and local files are never used to decide whether
 *     a call was already migrated.
 *
 * USAGE
 *   node --env-file=.env migrate-calls.js            # DRY_RUN defaults to true
 *   DRY_RUN=false node --env-file=.env migrate-calls.js
 *   node --env-file=.env migrate-calls.js --setup    # only create the tracking property
 *
 * REQUIRED PRIVATE APP SCOPES
 *   Source:      crm.objects.contacts.read (calls API), crm.objects.companies.read,
 *                crm.objects.deals.read, crm.schemas.calls.read
 *   Destination: crm.objects.contacts.read+write, crm.objects.companies.read+write,
 *                crm.objects.deals.read+write, crm.schemas.calls.read+write,
 *                crm.schemas.contacts/companies/deals.read, crm.objects.owners.read
 *
 * See the ENVIRONMENT section in CONFIG below for every option.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ===========================================================================
// Configuration
// ===========================================================================

function envBool(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return defaultValue;
  return String(raw).trim().toLowerCase() === 'true';
}

function envInt(name, defaultValue) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const CONFIG = {
  apiBase: process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com',
  sourceToken: String(process.env.SOURCE_HUBSPOT_TOKEN || '').trim(),
  destinationToken: String(process.env.DESTINATION_HUBSPOT_TOKEN || '').trim(),
  sourcePortalId: String(process.env.SOURCE_PORTAL_ID || '').trim(),
  destinationPortalId: String(process.env.DESTINATION_PORTAL_ID || '').trim(),
  // Writes happen ONLY when DRY_RUN is exactly "false". Missing/typo => dry run.
  dryRun: String(process.env.DRY_RUN ?? 'true').trim().toLowerCase() !== 'false',
  defaultOwnerId: String(process.env.DEFAULT_DESTINATION_OWNER_ID || '').trim(),
  trackingProperty: String(process.env.CALL_SOURCE_ID_PROPERTY || 'source_call_record_id').trim(),
  trackingPropertyGroup: String(process.env.CALL_PROPERTY_GROUP || '').trim(),
  logDir: path.resolve(process.env.LOG_DIR || path.join(process.cwd(), 'logs')),
  requestDelayMs: envInt('REQUEST_DELAY_MS', 110), // per portal; ~9 req/s, under the 100-150 per 10s burst limit
  searchDelayMs: envInt('SEARCH_DELAY_MS', 250), // search API: 5 requests/second/account
  maxRetries: envInt('MAX_RETRIES', 6),
  sourceCallIds: envList('SOURCE_CALL_IDS'), // migrate only these source call IDs (testing)
  maxCalls: envInt('MAX_CALLS', 0), // 0 = no limit
  resume: envBool('RESUME', true),
  rebuildMappingCache: envBool('REBUILD_MAPPING_CACHE', false),
  mappingCacheMaxAgeHours: envInt('MAPPING_CACHE_MAX_AGE_HOURS', 24),
  liveLookupOnCacheMiss: envBool('LIVE_LOOKUP_ON_CACHE_MISS', true),
  // How destination Contact/Company/Deal IDs are resolved:
  //   scan   - page through every destination record once and cache the map
  //   search - look up only the IDs referenced by the calls (CRM search, IN)
  //   auto   - search when the source has <= MAPPING_SCAN_MIN_CALLS calls, else scan
  mappingStrategy: String(process.env.MAPPING_STRATEGY || 'auto').trim().toLowerCase(),
  mappingScanMinCalls: envInt('MAPPING_SCAN_MIN_CALLS', 5000),
  excludeProperties: new Set(envList('EXCLUDE_PROPERTIES')),
  logRequestPayloads: envBool('LOG_REQUEST_PAYLOADS', true),
  ambiguousWriteWaitMs: envInt('AMBIGUOUS_WRITE_WAIT_MS', 5000),
  requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', 90000),
  // Destination calls that do NOT carry the tracking property (logged natively
  // in the destination, or migrated earlier by another tool) cannot be matched
  // to source calls. A live run refuses to start while any exist unless this
  // is set, because they could be duplicates of source calls.
  allowUntrackedDestinationCalls: envBool('ALLOW_UNTRACKED_DESTINATION_CALLS', false),
  // A property the destination rejects this many times (and never accepts)
  // is excluded for the rest of the run instead of costing extra requests per call.
  propertyAutoExcludeThreshold: envInt('PROPERTY_AUTO_EXCLUDE_THRESHOLD', 5),
  setupOnly: process.argv.includes('--setup'),
};

// Source owner ID -> destination owner ID.
const OWNER_ID_MAPPING = {
  '3763203': '18525422',
  '8723786': '8723786',
  '9173446': '9173446',
  '27694956': '27694956',
  '45451065': '181577832',
  '46408374': '211744580',
  '47151327': '230064129',
  '50253463': '352206340',
  '60730063': '550455864',
  '60935026': '560319513',
  '61676858': '601290148',
  '63179672': '672850242',
  '64491847': '751955723',
  '67008404': '1936566360',
  '67855975': '1404151225',
  '69123696': '1117200836',
  '69259141': '69259141',
  '71024339': '71024339',
  '72068007': '72068007',
  '79411216': '79411216',
  '84059163': '2029241262',
  '86254828': '86254828',
  '88490010': '88490010',
  '88495508': '88495508',
  '89103420': '89103420',
  '90007237': '90007237',
  '90242737': '90242737',
  '90889758': '1168039153',
  '91525249': '1021226174',
  '279435637': '88104500',
  '337849529': '76181927',
  '340707348': '402013449',
  '387987833': '70401043',
  '400765253': '214905858',
  '429491177': '39887254',
  '527530834': '77766607',
  '640129291': '164227621',
  '793589287': '468788581',
  '837124165': '468788581',
  '1003211342': '468788581',
  '1113666268': '179031424',
  '1120336442': '1411093930',
  '1173555779': '134876914',
  '1214949576': '95116677',
  '1310999875': '398423594',
  '1567814466': '1732582595',
  '1756593623': '445394756',
  '1773655144': '453548113',
  '2074721972': '417500287',
  '2098187823': '592363878',
  '2114582877': '672850241',
};

const PAGE_SIZE = 100; // CRM object list + batch read/create/update limit
const ASSOC_BATCH_READ_LIMIT = 1000;
const ASSOC_BATCH_CREATE_LIMIT = 2000;
const SEARCH_PAGE_LIMIT = 200;
const SEARCH_MAX_RESULTS = 10000;
// HubSpot does not document a maximum number of values for the IN operator;
// 50 keeps each search well inside the 3,000-character query limit.
const SEARCH_IN_CHUNK = 50;
// HubSpot does not document a per-record cap on v4 batch/read; records at or
// above this many associations are re-read with full pagination (same
// safeguard as hubspot-associations-common.js).
const BATCH_READ_COMPLETENESS_THRESHOLD = 90;

const ASSOCIATED_OBJECT_TYPES = ['contacts', 'companies', 'deals'];
const RECORD_MAPPING_PROPERTY = {
  contacts: 'tm_contact_record_id',
  companies: 'tm_company_record_id',
  deals: 'tm_deal_record_id',
};
const OBJECT_LABEL = { contacts: 'CONTACT', companies: 'COMPANY', deals: 'DEAL' };
const DEFAULT_CALL_ASSOCIATION_TYPE_ID = { contacts: 194, companies: 182, deals: 206 };

// Properties never copied even if the destination reports them writable,
// because their values are portal-specific IDs or system bookkeeping that
// this script cannot remap.
const ALWAYS_EXCLUDED_PROPERTIES = new Map([
  ['hs_object_id', 'HubSpot internal record ID; the destination assigns its own'],
  ['hs_createdate', 'system-managed creation timestamp'],
  ['hs_lastmodifieddate', 'system-managed modification timestamp'],
  ['hs_object_source', 'system-managed record source'],
  ['hs_object_source_id', 'system-managed record source'],
  ['hs_object_source_label', 'system-managed record source'],
  ['hs_object_source_user_id', 'source-portal user ID'],
  ['hs_object_source_detail_1', 'system-managed record source'],
  ['hs_object_source_detail_2', 'system-managed record source'],
  ['hs_object_source_detail_3', 'system-managed record source'],
  ['hs_created_by', 'source-portal user ID'],
  ['hs_created_by_user_id', 'source-portal user ID'],
  ['hs_modified_by', 'source-portal user ID'],
  ['hs_updated_by_user_id', 'source-portal user ID'],
  ['hubspot_team_id', 'team IDs are portal-specific and not mapped'],
  ['hs_all_owner_ids', 'derived from hubspot_owner_id by HubSpot'],
  ['hs_all_team_ids', 'team IDs are portal-specific'],
  ['hs_all_accessible_team_ids', 'team IDs are portal-specific'],
  ['hs_user_ids_of_all_owners', 'source-portal user IDs'],
  ['hs_user_ids_of_all_notification_followers', 'source-portal user IDs'],
  ['hs_user_ids_of_all_notification_unfollowers', 'source-portal user IDs'],
  ['hs_at_mentioned_owner_ids', 'owner IDs embedded in @mentions are not remapped'],
  ['hs_attachment_ids', 'file IDs are portal-specific; files are not migrated by this script'],
  ['hs_call_source', 'docs: if set it must be INTEGRATIONS_PLATFORM, which enrols the call in a calling-app recording pipeline'],
  ['hs_unique_creation_key', 'HubSpot uniqueness key; copying it could collide'],
  ['hs_merged_object_ids', 'source-portal record IDs'],
]);

const CALLEE_OBJECT_TYPE_MAP = { CONTACT: 'contacts', COMPANY: 'companies' };

// ===========================================================================
// Small utilities
// ===========================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isEmpty(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function truncate(value, max = 6000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text;
}

function preview(value) {
  return truncate(String(value), 200);
}

const SENSITIVE_KEY = /authorization|token|secret|password|apikey|api_key/i;

/** Deep copy with any credential-looking keys removed. */
function sanitize(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : sanitize(v, depth + 1);
  return out;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn(`[WARN] Could not read ${filePath}: ${err.message}`);
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function lowestId(ids) {
  return [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))[0];
}

// ===========================================================================
// Logging
// ===========================================================================

const LOG = {
  main: path.join(CONFIG.logDir, 'call-migration.log'),
  success: path.join(CONFIG.logDir, 'call-migration-success.log'),
  errors: path.join(CONFIG.logDir, 'call-migration-errors.log'),
  summary: path.join(CONFIG.logDir, 'call-migration-summary.json'),
  propertyReport: path.join(CONFIG.logDir, 'call-migration-property-report.json'),
  ownerReport: path.join(CONFIG.logDir, 'call-migration-owner-validation.json'),
  checkpoint: path.join(CONFIG.logDir, 'call-migration-checkpoint.json'),
  cacheDir: path.join(CONFIG.logDir, 'call-migration-cache'),
};

const stats = {
  startedAt: new Date(),
  finishedAt: null,
  estimatedSourceTotal: null,
  sourceCallsFound: 0,
  created: 0,
  updated: 0,
  alreadyCurrent: 0,
  failed: 0,
  callsWithAssociationErrors: 0,
  associationsCreated: { contacts: 0, companies: 0, deals: 0 },
  associationsAlreadyPresent: { contacts: 0, companies: 0, deals: 0 },
  associationsFailed: { contacts: 0, companies: 0, deals: 0 },
  mappingMissing: { contacts: 0, companies: 0, deals: 0 },
  mappingPropertyMissing: { contacts: 0, companies: 0, deals: 0 },
  propertiesSkipped: 0,
  ownerMappingMissing: 0,
  ownerMappingInvalid: 0,
  ownerUnassigned: 0,
  rateLimitRetries: 0,
  otherRetries: 0,
  errorCodes: {},
  errorSamples: {},
  fatalError: null,
  stoppedEarly: false,
};

function ensureLogDir() {
  fs.mkdirSync(CONFIG.logDir, { recursive: true });
  fs.mkdirSync(LOG.cacheDir, { recursive: true });
}

function append(file, text) {
  try {
    fs.appendFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  } catch (err) {
    console.error(`[LOG-WRITE-FAILED] ${file}: ${err.message}`);
  }
}

function formatFields(fields) {
  if (!fields) return '';
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? truncate(v, 1000) : v}`)
    .join(' ');
}

/** One line to console + call-migration.log. */
function log(level, tag, message, fields) {
  const line = `${nowIso()} [${tag}] ${message}${fields ? ` ${formatFields(fields)}` : ''}`;
  append(LOG.main, `${level === 'INFO' ? '' : `${level} `}${line}`);
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

/** Debug detail only written to the main log file (not the console). */
function logFileOnly(tag, message, fields) {
  append(LOG.main, `${nowIso()} [${tag}] ${message}${fields ? ` ${formatFields(fields)}` : ''}`);
}

function countIssue(code, sample) {
  stats.errorCodes[code] = (stats.errorCodes[code] || 0) + 1;
  if (!stats.errorSamples[code]) stats.errorSamples[code] = [];
  if (sample && stats.errorSamples[code].length < 5) stats.errorSamples[code].push(sanitize(sample));
}

const ERROR_FIELD_ORDER = [
  'sourceCallId', 'destinationCallId', 'operation', 'httpStatus', 'method', 'endpoint', 'retryCount',
  'associatedObjectType', 'associatedSourceRecordId', 'associatedDestinationRecordId',
  'property', 'value', 'reason', 'message', 'requestPayload', 'responseBody',
];

/**
 * Records a failed operation: counted under `code`, written as a multi-line
 * block to call-migration-errors.log and as one line to the main log.
 */
function logError(code, fields) {
  const entry = sanitize(fields || {});
  countIssue(code, entry);
  const lines = [`${nowIso()} [ERROR] code=${code}`];
  const keys = [...ERROR_FIELD_ORDER, ...Object.keys(entry).filter((k) => !ERROR_FIELD_ORDER.includes(k))];
  for (const key of keys) {
    const v = entry[key];
    if (v === undefined || v === null || v === '') continue;
    lines.push(`  ${key}=${typeof v === 'object' ? truncate(v) : v}`);
  }
  append(LOG.errors, `${lines.join('\n')}\n`);
  log('ERROR', code, entry.message || '', {
    sourceCall: entry.sourceCallId,
    destinationCall: entry.destinationCallId,
    operation: entry.operation,
    status: entry.httpStatus,
  });
}

/** Records a non-fatal, expected issue (skipped property, missing mapping...). */
function logIssue(code, message, fields, { toErrorLog = false, console: toConsole = false } = {}) {
  countIssue(code, { message, ...fields });
  if (toErrorLog) {
    const lines = [`${nowIso()} [WARN] code=${code}`, `  message=${message}`];
    for (const [k, v] of Object.entries(sanitize(fields || {}))) {
      if (v !== undefined && v !== null && v !== '') lines.push(`  ${k}=${typeof v === 'object' ? truncate(v) : v}`);
    }
    append(LOG.errors, `${lines.join('\n')}\n`);
  }
  if (toConsole) log('WARN', code, message, fields);
  else logFileOnly(code, message, fields);
}

function apiErrorFields(err) {
  if (!(err instanceof HubSpotApiError)) return { message: String((err && err.message) || err) };
  return {
    httpStatus: err.status,
    method: err.method,
    endpoint: err.endpoint,
    retryCount: err.retries,
    requestPayload: err.requestPayload,
    responseBody: err.body,
    message: err.message,
  };
}

// ===========================================================================
// HubSpot HTTP client
// ===========================================================================

class HubSpotApiError extends Error {
  constructor(message, { status = null, body = null, method = null, endpoint = null, retries = 0, requestPayload, ambiguous = false } = {}) {
    super(message);
    this.name = 'HubSpotApiError';
    this.status = status;
    this.body = body;
    this.method = method;
    this.endpoint = endpoint;
    this.retries = retries;
    this.requestPayload = requestPayload;
    // true when a non-idempotent write may or may not have been applied
    // (network error / 5xx). Callers must re-check the destination.
    this.ambiguous = ambiguous;
  }
}

/** Configuration / authentication problems that must stop the migration. */
class FatalMigrationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'FatalMigrationError';
    this.details = details || null;
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

function backoffMs(attempt) {
  return Math.min(1000 * 2 ** (attempt - 1), 60000) + Math.floor(Math.random() * 250);
}

function createClient(token, label) {
  let nextAllowedAt = 0;
  let nextSearchAllowedAt = 0;

  async function throttle(isSearch) {
    const now = Date.now();
    let wait = Math.max(0, nextAllowedAt - now);
    if (isSearch) wait = Math.max(wait, nextSearchAllowedAt - now);
    if (wait > 0) await sleep(wait);
    const t = Date.now();
    nextAllowedAt = t + CONFIG.requestDelayMs;
    if (isSearch) nextSearchAllowedAt = t + CONFIG.searchDelayMs;
  }

  /**
   * @param {object} opts
   *   idempotent      false for creates: a network error / 5xx is NOT retried
   *                   blindly (it may have been applied) - it throws an
   *                   `ambiguous` error so the caller re-checks first.
   *   authErrorsFatal false to receive 401/403 as a normal HubSpotApiError.
   */
  async function request(method, urlPath, body, opts = {}) {
    const { idempotent = true, authErrorsFatal = true } = opts;
    const isSearch = /\/search(\?|$)/.test(urlPath);
    const endpoint = urlPath.split('?')[0];
    const requestPayload = CONFIG.logRequestPayloads && body !== undefined ? truncate(sanitize(body)) : undefined;
    const errMeta = (extra) => ({ method, endpoint, requestPayload, ...extra });
    let retries = 0;

    if (typeof fetch !== 'function') throw new FatalMigrationError('Global fetch is unavailable - run with Node.js 18 or newer.');

    for (;;) {
      await throttle(isSearch);
      let response;
      try {
        response = await fetch(`${CONFIG.apiBase}${urlPath}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
        });
      } catch (networkErr) {
        if (!idempotent) {
          throw new HubSpotApiError(`[${label}] network error on ${method} ${endpoint}: ${networkErr.message}`, errMeta({ retries, ambiguous: true }));
        }
        if (retries >= CONFIG.maxRetries) {
          throw new HubSpotApiError(`[${label}] network error on ${method} ${endpoint} after ${retries} retries: ${networkErr.message}`, errMeta({ retries }));
        }
        retries += 1;
        stats.otherRetries += 1;
        const wait = backoffMs(retries);
        log('WARN', 'RETRY', `[${label}] network error, retrying in ${wait}ms`, { method, endpoint, attempt: retries, error: networkErr.message });
        await sleep(wait);
        continue;
      }

      const { status } = response;

      if (status === 429) {
        const errBody = await safeReadBody(response);
        if (errBody && typeof errBody === 'object' && String(errBody.policyName || '').toUpperCase() === 'DAILY') {
          throw new FatalMigrationError(`[${label}] HubSpot DAILY API limit reached - re-run after the limit resets (the migration resumes safely).`, { endpoint, body: errBody });
        }
        if (retries >= CONFIG.maxRetries) {
          throw new HubSpotApiError(`[${label}] ${method} ${endpoint} still rate-limited after ${retries} retries`, errMeta({ status, body: errBody, retries }));
        }
        retries += 1;
        stats.rateLimitRetries += 1;
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(retries);
        log('WARN', 'RATE_LIMIT', `[${label}] 429, waiting ${wait}ms`, { method, endpoint, attempt: retries });
        await sleep(wait);
        continue;
      }

      if (status >= 500) {
        const errBody = await safeReadBody(response);
        if (!idempotent) {
          throw new HubSpotApiError(`[${label}] ${method} ${endpoint} returned ${status}`, errMeta({ status, body: errBody, retries, ambiguous: true }));
        }
        if (retries >= CONFIG.maxRetries) {
          throw new HubSpotApiError(`[${label}] ${method} ${endpoint} returned ${status} after ${retries} retries`, errMeta({ status, body: errBody, retries }));
        }
        retries += 1;
        stats.otherRetries += 1;
        const wait = backoffMs(retries);
        log('WARN', 'RETRY', `[${label}] ${status}, retrying in ${wait}ms`, { method, endpoint, attempt: retries });
        await sleep(wait);
        continue;
      }

      if (!response.ok) {
        const errBody = await safeReadBody(response);
        if (authErrorsFatal && status === 401) {
          throw new FatalMigrationError(`[${label}] 401 Unauthorized on ${method} ${endpoint} - the ${label} token is invalid or expired.`, { status, endpoint, body: errBody });
        }
        if (authErrorsFatal && status === 403) {
          throw new FatalMigrationError(
            `[${label}] 403 Forbidden on ${method} ${endpoint} - the ${label} private app is missing a required scope. ` +
              'SOURCE needs: crm.objects.contacts.read (calls API), crm.objects.companies.read, crm.objects.deals.read, crm.schemas.calls.read. ' +
              'DESTINATION needs: crm.objects.contacts.read+write, crm.objects.companies.read+write, crm.objects.deals.read+write, ' +
              'crm.schemas.calls.read+write (tracking property), crm.schemas.contacts/companies/deals.read, crm.objects.owners.read.',
            { status, endpoint, body: errBody }
          );
        }
        throw new HubSpotApiError(`[${label}] ${method} ${endpoint} responded ${status}`, errMeta({ status, body: errBody, retries }));
      }

      if (status === 204) return null;
      return safeReadBody(response);
    }
  }

  return { request, label };
}

/** Pages through a CRM search, respecting HubSpot's 10,000-result cap. */
async function searchAll(client, objectType, body) {
  const results = [];
  let after;
  for (;;) {
    const page = await client.request('POST', `/crm/v3/objects/${objectType}/search`, { ...body, limit: SEARCH_PAGE_LIMIT, ...(after ? { after } : {}) });
    results.push(...((page && page.results) || []));
    after = page && page.paging && page.paging.next && page.paging.next.after;
    if (!after) break;
    if (results.length >= SEARCH_MAX_RESULTS) {
      logIssue('SEARCH_RESULT_CAP_REACHED', `Search on ${objectType} hit HubSpot's 10,000 result cap`, { objectType }, { toErrorLog: true, console: true });
      break;
    }
  }
  return results;
}

async function batchReadObjects(client, objectType, ids, properties, idProperty) {
  if (ids.length === 0) return [];
  const body = { inputs: ids.map((id) => ({ id: String(id) })), properties, propertiesWithHistory: [] };
  if (idProperty) body.idProperty = idProperty;
  try {
    const res = await client.request('POST', `/crm/v3/objects/${objectType}/batch/read?archived=false`, body);
    return (res && res.results) || [];
  } catch (err) {
    // Batch read by idProperty reports "not found" inputs as errors; a batch
    // where nothing matches may come back as 404.
    if (err instanceof HubSpotApiError && err.status === 404) return [];
    throw err;
  }
}

// ===========================================================================
// Environment / portal safety
// ===========================================================================

function validateEnvironment() {
  const problems = [];
  if (!CONFIG.sourceToken) problems.push('SOURCE_HUBSPOT_TOKEN is not set');
  if (!CONFIG.destinationToken) problems.push('DESTINATION_HUBSPOT_TOKEN is not set');
  if (!CONFIG.sourcePortalId) problems.push('SOURCE_PORTAL_ID is not set');
  if (!CONFIG.destinationPortalId) problems.push('DESTINATION_PORTAL_ID is not set');
  if (CONFIG.sourcePortalId && !/^\d+$/.test(CONFIG.sourcePortalId)) problems.push('SOURCE_PORTAL_ID must be numeric');
  if (CONFIG.destinationPortalId && !/^\d+$/.test(CONFIG.destinationPortalId)) problems.push('DESTINATION_PORTAL_ID must be numeric');
  if (CONFIG.defaultOwnerId && !/^\d+$/.test(CONFIG.defaultOwnerId)) problems.push('DEFAULT_DESTINATION_OWNER_ID must be numeric');
  if (!/^[a-z][a-z0-9_]*$/.test(CONFIG.trackingProperty)) problems.push('CALL_SOURCE_ID_PROPERTY must be a lowercase HubSpot internal property name');
  if (CONFIG.sourceCallIds.some((id) => !/^\d+$/.test(id))) problems.push('SOURCE_CALL_IDS must be a comma-separated list of numeric IDs');
  if (!['auto', 'scan', 'search'].includes(CONFIG.mappingStrategy)) problems.push('MAPPING_STRATEGY must be auto, scan or search');
  if (problems.length) throw new FatalMigrationError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);

  if (CONFIG.sourceToken === CONFIG.destinationToken) {
    throw new FatalMigrationError('SOURCE_HUBSPOT_TOKEN and DESTINATION_HUBSPOT_TOKEN are identical - refusing to run (source-to-source migration).');
  }
  if (CONFIG.sourcePortalId === CONFIG.destinationPortalId) {
    throw new FatalMigrationError('SOURCE_PORTAL_ID and DESTINATION_PORTAL_ID are identical - refusing to run.');
  }
}

async function getPortalInfo(client) {
  const details = await client.request('GET', '/account-info/v3/details');
  if (!details || details.portalId === undefined || details.portalId === null) {
    throw new FatalMigrationError(`[${client.label}] /account-info/v3/details did not return a portalId.`);
  }
  return { portalId: String(details.portalId), accountType: details.accountType || null, uiDomain: details.uiDomain || null };
}

async function verifyPortals(sourceClient, destClient) {
  const [sourceInfo, destInfo] = await Promise.all([getPortalInfo(sourceClient), getPortalInfo(destClient)]);
  if (sourceInfo.portalId !== CONFIG.sourcePortalId) {
    throw new FatalMigrationError(`SOURCE_HUBSPOT_TOKEN belongs to portal ${sourceInfo.portalId}, but SOURCE_PORTAL_ID is ${CONFIG.sourcePortalId}.`);
  }
  if (destInfo.portalId !== CONFIG.destinationPortalId) {
    throw new FatalMigrationError(`DESTINATION_HUBSPOT_TOKEN belongs to portal ${destInfo.portalId}, but DESTINATION_PORTAL_ID is ${CONFIG.destinationPortalId}.`);
  }
  if (sourceInfo.portalId === destInfo.portalId) {
    throw new FatalMigrationError(`Both tokens resolve to the same portal (${sourceInfo.portalId}) - refusing to run.`);
  }
  return { sourceInfo, destInfo };
}

// ===========================================================================
// Properties
// ===========================================================================

async function getObjectProperties(client, objectType) {
  const res = await client.request('GET', `/crm/v3/properties/${objectType}`);
  return (res && res.results) || [];
}

async function getPropertyDefinition(client, objectType, name) {
  try {
    return await client.request('GET', `/crm/v3/properties/${objectType}/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 404) return null;
    throw err;
  }
}

function isWritableProperty(def) {
  if (!def) return false;
  if (def.modificationMetadata && def.modificationMetadata.readOnlyValue) return false;
  if (def.calculated) return false;
  if (String(def.fieldType || '').startsWith('calculation')) return false;
  return true;
}

/**
 * Makes sure the destination Call object has the tracking property holding
 * the source call ID. Creates it (unique, text) when missing - unless this
 * is a dry run, which only reports what it would do.
 * Returns { exists, unique, created, simulated }.
 */
async function ensureSourceCallIdProperty(destClient, destPropsByName) {
  const name = CONFIG.trackingProperty;
  const existing = destPropsByName.get(name);
  if (existing) {
    if (!['string', 'number'].includes(existing.type)) {
      throw new FatalMigrationError(`Destination call property "${name}" exists but has type "${existing.type}" - it must be a single-line text (string) property.`);
    }
    if (!isWritableProperty(existing)) throw new FatalMigrationError(`Destination call property "${name}" exists but is read-only.`);
    log('INFO', 'TRACKING_PROPERTY', `Destination call property "${name}" exists`, { type: existing.type, hasUniqueValue: Boolean(existing.hasUniqueValue) });
    if (!existing.hasUniqueValue) {
      log('WARN', 'TRACKING_PROPERTY_NOT_UNIQUE', `"${name}" is not a unique-value property; duplicate detection will use the CRM search API (eventually consistent) instead of an exact unique-ID read.`);
    }
    return { exists: true, unique: Boolean(existing.hasUniqueValue), created: false, simulated: false };
  }

  if (CONFIG.dryRun && !CONFIG.setupOnly) {
    log('INFO', 'DRY RUN', `Would create destination call property "${name}" (string/text, hasUniqueValue=true). Until it exists every source call is treated as new.`);
    return { exists: false, unique: false, created: false, simulated: true };
  }

  const groupsRes = await destClient.request('GET', '/crm/v3/properties/calls/groups');
  const groupNames = ((groupsRes && groupsRes.results) || []).filter((g) => !g.archived).map((g) => g.name);
  let groupName;
  if (CONFIG.trackingPropertyGroup) {
    if (!groupNames.includes(CONFIG.trackingPropertyGroup)) {
      throw new FatalMigrationError(`CALL_PROPERTY_GROUP "${CONFIG.trackingPropertyGroup}" does not exist on destination calls. Available: ${groupNames.join(', ')}`);
    }
    groupName = CONFIG.trackingPropertyGroup;
  } else {
    groupName = groupNames.includes('callinformation') ? 'callinformation' : groupNames[0];
  }
  if (!groupName) throw new FatalMigrationError('Destination call object has no property groups; set CALL_PROPERTY_GROUP.');

  const base = {
    name,
    label: 'Source Call Record ID',
    description: `Call record ID in source HubSpot portal ${CONFIG.sourcePortalId}. Written by migrate-calls.js and used for duplicate-safe re-runs. Do not edit.`,
    groupName,
    type: 'string',
    fieldType: 'text',
    formField: false,
  };

  let created = null;
  try {
    created = await destClient.request('POST', '/crm/v3/properties/calls', { ...base, hasUniqueValue: true });
    log('INFO', 'TRACKING_PROPERTY_CREATED', `Created destination call property "${name}" (unique)`, { groupName });
  } catch (err) {
    if (err instanceof FatalMigrationError) throw err;
    if (err instanceof HubSpotApiError && err.status === 409) {
      created = await getPropertyDefinition(destClient, 'calls', name);
    } else if (err instanceof HubSpotApiError && err.status === 400) {
      logIssue('UNIQUE_PROPERTY_NOT_SUPPORTED', `Creating "${name}" with hasUniqueValue=true was rejected; retrying as a non-unique property`, { responseBody: err.body }, { toErrorLog: true, console: true });
      created = await destClient.request('POST', '/crm/v3/properties/calls', base);
      log('INFO', 'TRACKING_PROPERTY_CREATED', `Created destination call property "${name}" (non-unique)`, { groupName });
    } else {
      throw err;
    }
  }
  const confirmed = (await getPropertyDefinition(destClient, 'calls', name)) || created;
  if (!confirmed) throw new FatalMigrationError(`Could not confirm destination call property "${name}" after creating it.`);
  destPropsByName.set(name, confirmed);
  return { exists: true, unique: Boolean(confirmed.hasUniqueValue), created: true, simulated: false };
}

/**
 * Builds the SOURCE -> DESTINATION property plan (same internal name on
 * both sides). Every source property ends up either writable or skipped
 * with a reason code - nothing is dropped silently.
 */
function buildPropertyPlan(sourceProps, destPropsByName) {
  const writable = new Map();
  const skipped = new Map();
  const readProperties = [];

  for (const src of sourceProps) {
    const { name } = src;
    readProperties.push(name);
    const dest = destPropsByName.get(name);
    let code = null;
    let reason = null;

    if (name === CONFIG.trackingProperty) {
      code = 'PROPERTY_RESERVED';
      reason = 'migration tracking property; set by this script';
    } else if (ALWAYS_EXCLUDED_PROPERTIES.has(name)) {
      code = 'PROPERTY_EXCLUDED';
      reason = ALWAYS_EXCLUDED_PROPERTIES.get(name);
    } else if (CONFIG.excludeProperties.has(name)) {
      code = 'PROPERTY_EXCLUDED';
      reason = 'listed in EXCLUDE_PROPERTIES';
    } else if (!dest) {
      code = 'PROPERTY_NOT_IN_DESTINATION';
      reason = 'destination property does not exist';
    } else if (!isWritableProperty(dest)) {
      code = 'PROPERTY_NOT_WRITABLE';
      reason = dest.calculated ? 'calculated property' : 'destination API marks this property read-only';
    } else if (dest.type !== src.type) {
      code = 'PROPERTY_TYPE_MISMATCH';
      reason = `source type "${src.type}" vs destination type "${dest.type}"`;
    }

    if (code) {
      // "expected" skips are system/bookkeeping properties: reported once in
      // the property report and per call in the main log, but not counted
      // as issues (they would otherwise dominate the error summary).
      const expected = code === 'PROPERTY_RESERVED' || code === 'PROPERTY_EXCLUDED' || (code === 'PROPERTY_NOT_WRITABLE' && Boolean(dest && dest.hubspotDefined));
      skipped.set(name, { code, reason, expected });
      continue;
    }
    writable.set(name, {
      name,
      type: dest.type,
      fieldType: dest.fieldType,
      isOwner: name === 'hubspot_owner_id' || dest.referencedObjectType === 'OWNER',
      multi: dest.type === 'enumeration' && dest.fieldType === 'checkbox',
      options: dest.type === 'enumeration' && Array.isArray(dest.options) && dest.options.length > 0
        ? new Set(dest.options.map((o) => String(o.value)))
        : null,
    });
  }

  if (!writable.has('hs_timestamp')) {
    throw new FatalMigrationError(`hs_timestamp (required to create calls) is not writable in the destination: ${JSON.stringify(skipped.get('hs_timestamp') || 'missing')}`);
  }
  return { writable, skipped, readProperties };
}

function writePropertyReport(plan, sourceProps, destPropsByName, tracking) {
  const report = {
    generatedAt: nowIso(),
    sourcePortalId: CONFIG.sourcePortalId,
    destinationPortalId: CONFIG.destinationPortalId,
    trackingProperty: { name: CONFIG.trackingProperty, ...tracking },
    sourcePropertyCount: sourceProps.length,
    destinationPropertyCount: destPropsByName.size,
    writable: [...plan.writable.values()].map((w) => ({ name: w.name, type: w.type, fieldType: w.fieldType, ownerMapped: w.isOwner, optionValidated: Boolean(w.options) })),
    skipped: [...plan.skipped.entries()].map(([name, s]) => ({ name, ...s })),
    note: 'expected=true skips are system/bookkeeping properties and are not counted as issues in the summary.',
  };
  writeJsonAtomic(LOG.propertyReport, report);
  const byCode = {};
  for (const s of plan.skipped.values()) byCode[s.code] = (byCode[s.code] || 0) + 1;
  log('INFO', 'PROPERTY_PLAN', `${plan.writable.size} writable call properties, ${plan.skipped.size} skipped`, { ...byCode, report: LOG.propertyReport });
  for (const [name, s] of plan.skipped) {
    if (s.code === 'PROPERTY_NOT_IN_DESTINATION' || s.code === 'PROPERTY_TYPE_MISMATCH') {
      log('WARN', s.code, `Source call property "${name}" will not be migrated`, { reason: s.reason });
    }
  }
}

// ===========================================================================
// Owners
// ===========================================================================

async function fetchAllOwners(client, archived) {
  const owners = [];
  let after;
  do {
    const q = new URLSearchParams({ limit: '100', archived: String(archived) });
    if (after) q.set('after', after);
    const page = await client.request('GET', `/crm/v3/owners?${q.toString()}`);
    owners.push(...((page && page.results) || []));
    after = page && page.paging && page.paging.next && page.paging.next.after;
  } while (after);
  return owners;
}

/**
 * Validates every destination owner referenced by OWNER_ID_MAPPING (and the
 * default owner). Only ACTIVE (non-archived) destination owners are used.
 */
async function validateOwners(destClient) {
  const [active, archived] = await Promise.all([fetchAllOwners(destClient, false), fetchAllOwners(destClient, true)]);
  const statusById = new Map();
  for (const o of archived) statusById.set(String(o.id), 'ARCHIVED');
  for (const o of active) statusById.set(String(o.id), 'ACTIVE');

  const valid = new Map();
  const invalid = new Map();
  const report = [];
  for (const [sourceOwnerId, destinationOwnerId] of Object.entries(OWNER_ID_MAPPING)) {
    const status = statusById.get(destinationOwnerId) || 'NOT_FOUND';
    report.push({ sourceOwnerId, destinationOwnerId, validationResult: status });
    if (status === 'ACTIVE') {
      valid.set(sourceOwnerId, destinationOwnerId);
    } else {
      invalid.set(sourceOwnerId, { destinationOwnerId, status });
      logIssue('OWNER_MAPPING_ERROR', 'Mapped destination owner is not an active owner', { sourceOwnerId, destinationOwnerId, validationResult: status }, { toErrorLog: true, console: true });
    }
  }

  let defaultOwnerId = null;
  let defaultOwnerStatus = 'NOT_CONFIGURED';
  if (CONFIG.defaultOwnerId) {
    defaultOwnerStatus = statusById.get(CONFIG.defaultOwnerId) || 'NOT_FOUND';
    if (defaultOwnerStatus !== 'ACTIVE') {
      throw new FatalMigrationError(`DEFAULT_DESTINATION_OWNER_ID ${CONFIG.defaultOwnerId} is ${defaultOwnerStatus} in the destination portal. Fix it or unset it.`);
    }
    defaultOwnerId = CONFIG.defaultOwnerId;
  } else {
    log('WARN', 'DEFAULT_OWNER_NOT_CONFIGURED',
      'DEFAULT_DESTINATION_OWNER_ID is not set. Safe fallback: calls whose source owner is unmapped/invalid are migrated WITHOUT an owner (hubspot_owner_id left empty) and logged.');
  }

  writeJsonAtomic(LOG.ownerReport, {
    generatedAt: nowIso(),
    destinationPortalId: CONFIG.destinationPortalId,
    destinationActiveOwners: active.length,
    destinationArchivedOwners: archived.length,
    defaultOwner: { id: CONFIG.defaultOwnerId || null, validationResult: defaultOwnerStatus },
    mappings: report,
  });
  log('INFO', 'OWNER_VALIDATION', `${valid.size}/${report.length} owner mappings valid`, { invalid: invalid.size, defaultOwner: defaultOwnerId || 'none', report: LOG.ownerReport });
  return { valid, invalid, defaultOwnerId };
}

function resolveOwner(sourceOwnerId, owners, sourceCallId) {
  if (isEmpty(sourceOwnerId)) return { sourceOwnerId: null, destinationOwnerId: null, status: 'NO_SOURCE_OWNER' };
  const src = String(sourceOwnerId);
  if (owners.valid.has(src)) return { sourceOwnerId: src, destinationOwnerId: owners.valid.get(src), status: 'MAPPED' };

  if (owners.invalid.has(src)) {
    stats.ownerMappingInvalid += 1;
    const { destinationOwnerId, status } = owners.invalid.get(src);
    logIssue('OWNER_MAPPING_INVALID', 'Mapped destination owner is not active', { sourceCallId, sourceOwnerId: src, destinationOwnerId, validationResult: status, fallback: owners.defaultOwnerId || 'UNASSIGNED' });
  } else {
    stats.ownerMappingMissing += 1;
    logIssue('OWNER_MAPPING_NOT_FOUND', 'Source owner is not in the owner mapping', { sourceCallId, sourceOwnerId: src, fallback: owners.defaultOwnerId || 'UNASSIGNED' });
  }
  if (owners.defaultOwnerId) return { sourceOwnerId: src, destinationOwnerId: owners.defaultOwnerId, status: 'DEFAULT_OWNER' };
  stats.ownerUnassigned += 1;
  return { sourceOwnerId: src, destinationOwnerId: null, status: 'UNASSIGNED' };
}

// ===========================================================================
// Call outcomes (hs_call_disposition)
// ===========================================================================

async function buildDispositionMapping(sourceClient, destClient) {
  try {
    const [src, dst] = await Promise.all([
      sourceClient.request('GET', '/calling/v1/dispositions', undefined, { authErrorsFatal: false }),
      destClient.request('GET', '/calling/v1/dispositions', undefined, { authErrorsFatal: false }),
    ]);
    const srcList = Array.isArray(src) ? src : [];
    const dstList = Array.isArray(dst) ? dst : [];
    const dstIds = new Set(dstList.map((d) => String(d.id)));
    const dstByLabel = new Map();
    for (const d of dstList) {
      const key = String(d.label);
      dstByLabel.set(key, dstByLabel.has(key) ? null : String(d.id)); // null = ambiguous label
    }
    const map = new Map();
    const unmatched = [];
    for (const s of srcList) {
      const id = String(s.id);
      if (dstIds.has(id)) map.set(id, id);
      else if (dstByLabel.get(String(s.label))) map.set(id, dstByLabel.get(String(s.label)));
      else unmatched.push({ id, label: s.label });
    }
    const srcLabels = new Map(srcList.map((s) => [String(s.id), s.label]));
    log('INFO', 'CALL_OUTCOMES', `${map.size}/${srcList.length} source call outcomes resolved in destination`, { unmatched: unmatched.map((u) => u.label).join('|') || 'none' });
    for (const u of unmatched) {
      logIssue('CALL_OUTCOME_NOT_IN_DESTINATION', `Source call outcome "${u.label}" has no destination outcome with the same label; hs_call_disposition will be skipped for those calls`, u, { toErrorLog: true, console: true });
    }
    return { available: true, map, srcLabels };
  } catch (err) {
    if (err instanceof FatalMigrationError) throw err;
    logIssue('CALL_OUTCOME_LOOKUP_UNAVAILABLE', 'Could not read /calling/v1/dispositions; hs_call_disposition values are copied as-is and dropped per call if the destination rejects them', apiErrorFields(err), { toErrorLog: true, console: true });
    return { available: false, map: new Map(), srcLabels: new Map() };
  }
}

// ===========================================================================
// Contact / Company / Deal mappings (tm_*_record_id)
// ===========================================================================

class RecordMapping {
  constructor(objectType) {
    this.objectType = objectType;
    this.label = OBJECT_LABEL[objectType];
    this.property = RECORD_MAPPING_PROPERTY[objectType];
    this.map = new Map();
    this.ambiguous = new Map();
    this.knownMissing = new Set();
    this.available = false;
    this.status = 'NOT_BUILT';
    this.dirty = false;
  }

  get cachePath() {
    return path.join(LOG.cacheDir, `${this.objectType}-mapping-${CONFIG.sourcePortalId}-to-${CONFIG.destinationPortalId}.json`);
  }

  addEntry(sourceId, destId) {
    const s = String(sourceId).trim();
    const d = String(destId);
    if (!s) return;
    if (this.ambiguous.has(s)) {
      if (!this.ambiguous.get(s).includes(d)) this.ambiguous.get(s).push(d);
    } else if (this.map.has(s) && this.map.get(s) !== d) {
      this.ambiguous.set(s, [this.map.get(s), d]);
      this.map.delete(s);
    } else {
      this.map.set(s, d);
    }
    this.knownMissing.delete(s);
  }

  async build(destClient, useScan) {
    const def = await getPropertyDefinition(destClient, this.objectType, this.property);
    if (!def) {
      this.available = false;
      this.status = 'PROPERTY_MISSING';
      logIssue(`${this.label}_MAPPING_PROPERTY_MISSING`,
        `Destination ${this.objectType} property "${this.property}" does not exist. Call -> ${this.label} associations cannot be resolved until it exists and is populated. (Not created automatically.)`,
        { objectType: this.objectType, property: this.property }, { toErrorLog: true, console: true });
      return;
    }
    this.available = true;
    const populatedRes = await destClient.request('POST', `/crm/v3/objects/${this.objectType}/search`, {
      filterGroups: [{ filters: [{ propertyName: this.property, operator: 'HAS_PROPERTY' }] }],
      properties: ['hs_object_id'],
      limit: 1,
    });
    this.populatedCount = populatedRes && Number.isFinite(populatedRes.total) ? populatedRes.total : null;
    if (!useScan) {
      // On-demand: resolveMany() searches exactly the IDs each page references.
      this.status = this.populatedCount === 0 ? 'PROPERTY_NOT_POPULATED' : 'ON_DEMAND';
    } else if (!CONFIG.rebuildMappingCache && this.loadCache()) {
      this.status = 'CACHE';
    } else {
      await this.fullScan(destClient);
      this.status = 'SCANNED';
      this.saveCache();
    }
    if (this.populatedCount === 0 || (useScan && this.map.size === 0 && this.ambiguous.size === 0)) {
      this.status = 'PROPERTY_NOT_POPULATED';
      logIssue(`${this.label}_MAPPING_PROPERTY_NOT_POPULATED`,
        `No destination ${this.objectType} has "${this.property}" populated. Call -> ${this.label} associations will not resolve until it is populated.`,
        { objectType: this.objectType, property: this.property }, { toErrorLog: true, console: true });
    }
    if (this.ambiguous.size > 0) {
      logIssue(`${this.label}_MAPPING_DUPLICATES`,
        `${this.ambiguous.size} source ${this.objectType} IDs map to more than one destination record; associations to those records are skipped (never guessed)`,
        { sample: [...this.ambiguous.entries()].slice(0, 5) }, { toErrorLog: true, console: true });
    }
    log('INFO', 'RECORD_MAPPING', `${this.objectType}: ${this.property} populated on ${this.populatedCount ?? '?'} destination records`, { mode: this.status, cached: this.map.size, ambiguous: this.ambiguous.size });
  }

  async fullScan(destClient) {
    this.map.clear();
    this.ambiguous.clear();
    let after;
    let scanned = 0;
    let pages = 0;
    do {
      const q = new URLSearchParams({ limit: '100', properties: this.property, archived: 'false' });
      if (after) q.set('after', after);
      const page = await destClient.request('GET', `/crm/v3/objects/${this.objectType}?${q.toString()}`);
      for (const r of (page && page.results) || []) {
        scanned += 1;
        const sourceId = r.properties && r.properties[this.property];
        if (!isEmpty(sourceId)) this.addEntry(sourceId, r.id);
      }
      pages += 1;
      if (pages % 20 === 0) log('INFO', 'RECORD_MAPPING', `Scanning destination ${this.objectType}...`, { scanned, mapped: this.map.size });
      after = page && page.paging && page.paging.next && page.paging.next.after;
    } while (after);
    log('INFO', 'RECORD_MAPPING', `Scanned ${scanned} destination ${this.objectType}`, { mapped: this.map.size });
  }

  loadCache() {
    const cache = readJson(this.cachePath);
    if (!cache) return false;
    const m = cache.metadata || {};
    const reject = (why) => {
      log('WARN', 'CACHE_REJECTED', `Ignoring ${path.basename(this.cachePath)}: ${why}`);
      return false;
    };
    if (m.sourcePortalId !== CONFIG.sourcePortalId || m.destinationPortalId !== CONFIG.destinationPortalId) return reject('portal IDs do not match this run');
    if (m.objectType !== this.objectType || m.mappingProperty !== this.property) return reject('object type / mapping property mismatch');
    const ageHours = (Date.now() - Date.parse(m.generatedAt)) / 3600000;
    if (!Number.isFinite(ageHours) || ageHours > CONFIG.mappingCacheMaxAgeHours) return reject(`older than ${CONFIG.mappingCacheMaxAgeHours}h`);
    this.map = new Map(Object.entries(cache.entries || {}));
    this.ambiguous = new Map(Object.entries(cache.ambiguous || {}));
    return true;
  }

  saveCache() {
    if (!this.available) return;
    writeJsonAtomic(this.cachePath, {
      metadata: {
        sourcePortalId: CONFIG.sourcePortalId,
        destinationPortalId: CONFIG.destinationPortalId,
        generatedAt: nowIso(),
        objectType: this.objectType,
        mappingProperty: this.property,
      },
      entries: Object.fromEntries(this.map),
      ambiguous: Object.fromEntries(this.ambiguous),
    });
    this.dirty = false;
  }

  /** Live-searches destination for any source IDs not yet in the mapping. */
  async resolveMany(destClient, sourceIds) {
    if (!this.available || (!CONFIG.liveLookupOnCacheMiss && this.status !== 'ON_DEMAND')) return;
    const misses = [...new Set(sourceIds.map(String))].filter((id) => !this.map.has(id) && !this.ambiguous.has(id) && !this.knownMissing.has(id));
    for (const part of chunk(misses, SEARCH_IN_CHUNK)) {
      const results = await searchAll(destClient, this.objectType, {
        filterGroups: [{ filters: [{ propertyName: this.property, operator: 'IN', values: part }] }],
        properties: [this.property],
      });
      for (const r of results) {
        const s = r.properties && r.properties[this.property];
        if (!isEmpty(s)) {
          this.addEntry(s, r.id);
          this.dirty = true;
        }
      }
      for (const id of part) if (!this.map.has(id) && !this.ambiguous.has(id)) this.knownMissing.add(id);
    }
  }

  lookup(sourceId) {
    if (!this.available) return { status: 'UNAVAILABLE' };
    const s = String(sourceId);
    if (this.map.has(s)) return { status: 'FOUND', destId: this.map.get(s) };
    if (this.ambiguous.has(s)) return { status: 'AMBIGUOUS', destIds: this.ambiguous.get(s) };
    return { status: 'NOT_FOUND' };
  }
}

// ===========================================================================
// Source calls
// ===========================================================================

async function estimateSourceCallTotal(sourceClient) {
  try {
    const res = await sourceClient.request('POST', '/crm/v3/objects/calls/search', { limit: 1, properties: ['hs_object_id'] });
    return res && Number.isFinite(res.total) ? res.total : null;
  } catch (err) {
    if (err instanceof FatalMigrationError) throw err;
    return null;
  }
}

/**
 * Yields pages of source calls with every source call property. Listing
 * uses the paginated GET (IDs only) and the full property set is fetched
 * with batch/read, so long property lists never go into the URL.
 */
async function* getSourceCalls(sourceClient, readProperties, startAfter) {
  if (CONFIG.sourceCallIds.length > 0) {
    for (const ids of chunk(CONFIG.sourceCallIds, PAGE_SIZE)) {
      const calls = await batchReadObjects(sourceClient, 'calls', ids, readProperties);
      const found = new Set(calls.map((c) => String(c.id)));
      for (const id of ids) {
        if (!found.has(id)) logError('SOURCE_CALL_NOT_FOUND', { sourceCallId: id, operation: 'READ_SOURCE_CALL', message: 'SOURCE_CALL_IDS entry was not found in the source portal' });
      }
      yield { calls, requestAfter: null, nextAfter: null };
    }
    return;
  }

  let after = startAfter || undefined;
  do {
    const q = new URLSearchParams({ limit: String(PAGE_SIZE), properties: 'hs_object_id', archived: 'false' });
    if (after) q.set('after', after);
    const page = await sourceClient.request('GET', `/crm/v3/objects/calls?${q.toString()}`);
    const listedIds = ((page && page.results) || []).map((r) => String(r.id));
    const fetched = await batchReadObjects(sourceClient, 'calls', listedIds, readProperties);
    const byId = new Map(fetched.map((c) => [String(c.id), c]));
    const calls = listedIds.filter((id) => byId.has(id)).map((id) => byId.get(id));
    for (const id of listedIds) {
      if (!byId.has(id)) logIssue('SOURCE_CALL_VANISHED', 'Source call was listed but could not be read (deleted mid-run?)', { sourceCallId: id }, { toErrorLog: true });
    }
    const nextAfter = page && page.paging && page.paging.next && page.paging.next.after;
    yield { calls, requestAfter: after || null, nextAfter: nextAfter || null };
    after = nextAfter;
  } while (after);
}

/**
 * Counts destination calls that do not carry the tracking property. Those
 * can never be matched to a source call, so if any of them are copies of
 * source calls (e.g. migrated earlier by another tool) this script would
 * create duplicates. Live runs refuse to start unless explicitly allowed.
 */
async function checkUntrackedDestinationCalls(destClient, trackingPropertyExists) {
  const body = trackingPropertyExists
    ? { filterGroups: [{ filters: [{ propertyName: CONFIG.trackingProperty, operator: 'NOT_HAS_PROPERTY' }] }], properties: ['hs_object_id'], limit: 1 }
    : { properties: ['hs_object_id'], limit: 1 };
  const res = await destClient.request('POST', '/crm/v3/objects/calls/search', body);
  const total = res && Number.isFinite(res.total) ? res.total : 0;
  if (total === 0) {
    log('INFO', 'PREFLIGHT', 'No untracked calls in the destination portal');
    return 0;
  }
  const message = `Destination portal already has ${total} call(s) WITHOUT ${CONFIG.trackingProperty}. ` +
    'They cannot be matched to source calls; if any were migrated earlier by another tool, this run would duplicate them. ' +
    'Verify, then set ALLOW_UNTRACKED_DESTINATION_CALLS=true to proceed (those calls are never modified).';
  if (!CONFIG.dryRun && !CONFIG.allowUntrackedDestinationCalls) throw new FatalMigrationError(message);
  logIssue('UNTRACKED_DESTINATION_CALLS', message, { count: total, allowed: CONFIG.allowUntrackedDestinationCalls }, { toErrorLog: true, console: true });
  return total;
}

// ===========================================================================
// Destination call lookup (duplicate detection via tracking property)
// ===========================================================================

/** Returns Map<sourceCallId, destinationCallId[]> for calls already migrated. */
async function getDestinationCallsBySourceIds(destClient, sourceIds, tracking) {
  const found = new Map();
  if (!tracking.exists || sourceIds.length === 0) return found;
  const prop = CONFIG.trackingProperty;
  const add = (record) => {
    const s = record.properties && record.properties[prop];
    if (isEmpty(s)) return;
    const key = String(s);
    if (!found.has(key)) found.set(key, []);
    if (!found.get(key).includes(String(record.id))) found.get(key).push(String(record.id));
  };

  if (tracking.unique) {
    // Exact, strongly-consistent read by the unique property value.
    for (const ids of chunk(sourceIds, PAGE_SIZE)) {
      for (const r of await batchReadObjects(destClient, 'calls', ids, [prop], prop)) add(r);
    }
  } else {
    for (const ids of chunk(sourceIds, SEARCH_IN_CHUNK)) {
      const results = await searchAll(destClient, 'calls', {
        filterGroups: [{ filters: [{ propertyName: prop, operator: 'IN', values: ids }] }],
        properties: [prop],
      });
      for (const r of results) add(r);
    }
  }
  return found;
}

async function getDestinationCallDetails(destClient, destIds, properties) {
  const out = new Map();
  for (const ids of chunk(destIds, PAGE_SIZE)) {
    for (const r of await batchReadObjects(destClient, 'calls', ids, properties)) out.set(String(r.id), r.properties || {});
  }
  return out;
}

// ===========================================================================
// Property transformation / comparison
// ===========================================================================

/**
 * Builds the destination property payload for one source call.
 * Returns { properties, skipped[], owner, fatalReason }.
 */
function transformCallProperties(sourceCall, ctx) {
  const sourceCallId = String(sourceCall.id);
  const src = sourceCall.properties || {};
  const out = {};
  const skipped = [];
  const skip = (name, value, code, reason) => skipped.push({ name, value: preview(value), code, reason });
  let owner = { sourceOwnerId: null, destinationOwnerId: null, status: 'NO_SOURCE_OWNER' };

  for (const [name, value] of Object.entries(src)) {
    if (isEmpty(value)) continue;
    const planned = ctx.plan.skipped.get(name);
    if (planned) {
      skipped.push({ name, value: preview(value), code: planned.code, reason: planned.reason, expected: planned.expected });
      continue;
    }
    if (autoExcludedProperties.has(name)) {
      skip(name, value, 'PROPERTY_AUTO_EXCLUDED', 'destination repeatedly rejected this property earlier in this run');
      continue;
    }
    const w = ctx.plan.writable.get(name);
    if (!w) {
      skip(name, value, 'PROPERTY_NOT_IN_SOURCE_SCHEMA', 'returned by the API but missing from the source property list');
      continue;
    }
    if (name === 'hs_call_callee_object_id' || name === 'hs_call_callee_object_type') continue; // handled below

    if (name === 'hubspot_owner_id') {
      owner = resolveOwner(value, ctx.owners, sourceCallId);
      if (owner.destinationOwnerId) out[name] = owner.destinationOwnerId;
      else skip(name, value, 'OWNER_UNASSIGNED', `owner ${owner.status}; no valid DEFAULT_DESTINATION_OWNER_ID`);
      continue;
    }

    if (w.isOwner) {
      // Secondary owner-type properties: mapped strictly, no default fallback.
      const parts = String(value).split(';').filter(Boolean);
      const mapped = parts.map((p) => ctx.owners.valid.get(p));
      if (mapped.every(Boolean)) out[name] = mapped.join(';');
      else skip(name, value, 'OWNER_REFERENCE_UNMAPPED', 'owner-type property contains an owner without a valid mapping');
      continue;
    }

    if (name === 'hs_call_disposition') {
      if (!ctx.dispositions.available) {
        out[name] = value;
      } else if (ctx.dispositions.map.has(String(value))) {
        out[name] = ctx.dispositions.map.get(String(value));
      } else {
        skip(name, value, 'CALL_OUTCOME_NOT_IN_DESTINATION', `no destination call outcome labelled "${ctx.dispositions.srcLabels.get(String(value)) || 'unknown'}"`);
      }
      continue;
    }

    if (w.options) {
      const values = w.multi ? String(value).split(';').filter(Boolean) : [String(value)];
      const invalid = values.filter((v) => !w.options.has(v));
      if (invalid.length) {
        skip(name, value, 'PROPERTY_VALUE_NOT_ALLOWED', `destination option(s) missing: ${invalid.join(', ')}`);
        continue;
      }
    }
    out[name] = value;
  }

  // Callee (hs_call_callee_object_id) is a source-portal record ID: remap it.
  const calleeId = src.hs_call_callee_object_id;
  const calleeType = src.hs_call_callee_object_type;
  if (!isEmpty(calleeId) && ctx.plan.writable.has('hs_call_callee_object_id') && ctx.plan.writable.has('hs_call_callee_object_type')) {
    const objectType = CALLEE_OBJECT_TYPE_MAP[String(calleeType || '').toUpperCase()];
    const result = objectType ? ctx.mappings[objectType].lookup(calleeId) : null;
    if (result && result.status === 'FOUND') {
      out.hs_call_callee_object_id = result.destId;
      out.hs_call_callee_object_type = calleeType;
    } else {
      skip('hs_call_callee_object_id', calleeId, 'CALLEE_MAPPING_NOT_FOUND', objectType ? `callee ${calleeType} ${calleeId}: ${result.status}` : `unsupported callee object type "${calleeType}"`);
    }
  } else if (!isEmpty(calleeId) && !ctx.plan.skipped.has('hs_call_callee_object_id')) {
    skip('hs_call_callee_object_id', calleeId, 'PROPERTY_NOT_WRITABLE', 'hs_call_callee_object_type is not writable in the destination, so the callee cannot be set');
  }

  let fatalReason = null;
  if (isEmpty(out.hs_timestamp)) {
    if (!isEmpty(src.hs_createdate)) {
      out.hs_timestamp = src.hs_createdate;
      logIssue('HS_TIMESTAMP_FALLBACK', 'Source call has no hs_timestamp; using hs_createdate', { sourceCallId, hs_createdate: src.hs_createdate });
    } else {
      fatalReason = 'source call has neither hs_timestamp nor hs_createdate (hs_timestamp is required to create a call)';
    }
  }

  out[CONFIG.trackingProperty] = sourceCallId;
  return { properties: out, skipped, owner, fatalReason };
}

function toMillis(value) {
  const s = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return Date.parse(s);
}

function valuesEqual(desired, current, def) {
  if (isEmpty(current)) return isEmpty(desired);
  const type = def ? def.type : 'string';
  const a = String(desired);
  const b = String(current);
  if (a === b) return true;
  switch (type) {
    case 'number':
      return Number(a) === Number(b);
    case 'datetime':
      return toMillis(a) === toMillis(b);
    case 'date':
      return new Date(toMillis(a)).toISOString().slice(0, 10) === new Date(toMillis(b)).toISOString().slice(0, 10);
    case 'bool':
      return a.toLowerCase() === b.toLowerCase();
    case 'enumeration':
      if (def && def.multi) return [...a.split(';')].filter(Boolean).sort().join(';') === [...b.split(';')].filter(Boolean).sort().join(';');
      return false;
    default:
      return false;
  }
}

/** Only the properties whose destination value differs from the source. */
function diffProperties(desired, current, plan) {
  const changed = {};
  for (const [name, value] of Object.entries(desired)) {
    const def = plan.writable.get(name);
    let equal;
    try {
      equal = valuesEqual(value, current[name], def);
    } catch {
      equal = false;
    }
    if (!equal) changed[name] = value;
  }
  return changed;
}

// ===========================================================================
// Destination writes: create / update calls
// ===========================================================================

/** Property names HubSpot reports as invalid in a 400 VALIDATION_ERROR body. */
function extractRejectedProperties(body) {
  const names = new Set();
  let message = '';
  if (body && typeof body === 'object') {
    for (const e of body.errors || []) {
      const context = e.context || {};
      for (const key of ['propertyName', 'properties', 'name']) {
        const v = context[key];
        if (Array.isArray(v)) v.forEach((n) => names.add(String(n)));
        else if (typeof v === 'string') names.add(v);
      }
      if (e.message) message += ` ${e.message}`;
    }
    message += ` ${body.message || ''}`;
  } else if (body) {
    message = String(body);
  }
  for (const m of message.matchAll(/\\?"name\\?"\s*:\s*\\?"([a-z0-9_]+)\\?"/gi)) names.add(m[1]);
  for (const m of message.matchAll(/Property \\?"([a-z0-9_]+)\\?" does not exist/gi)) names.add(m[1]);
  return [...names];
}

const propertyRejections = new Map();
const propertiesAccepted = new Set();
const autoExcludedProperties = new Set();

function markAccepted(props) {
  for (const name of Object.keys(props || {})) propertiesAccepted.add(name);
}

function recordRejection(name, sampleReason) {
  const count = (propertyRejections.get(name) || 0) + 1;
  propertyRejections.set(name, count);
  if (count >= CONFIG.propertyAutoExcludeThreshold && !propertiesAccepted.has(name) && !autoExcludedProperties.has(name)) {
    autoExcludedProperties.add(name);
    logIssue('PROPERTY_AUTO_EXCLUDED', `Destination rejected "${name}" ${count} times and never accepted it; excluding it for the rest of this run`,
      { property: name, reason: sampleReason }, { toErrorLog: true, console: true });
  }
}

function stripAutoExcluded(props, dropped) {
  for (const name of Object.keys(props)) {
    if (autoExcludedProperties.has(name)) {
      dropped.push({ name, value: preview(props[name]), code: 'PROPERTY_AUTO_EXCLUDED', reason: 'destination repeatedly rejected this property earlier in this run' });
      delete props[name];
    }
  }
}

function looksLikeUniqueConflict(err) {
  if (!(err instanceof HubSpotApiError)) return false;
  if (err.status === 409) return true;
  const text = JSON.stringify(err.body || '').toLowerCase();
  return text.includes(CONFIG.trackingProperty) && /(already|unique|duplicate|conflict)/.test(text);
}

/**
 * Creates one call. Invalid individual properties reported by HubSpot are
 * dropped and logged, and the create is retried (the call itself is never
 * lost because of one bad property value).
 * Returns { destId, dropped, existing?, error? }.
 */
async function createSingleCall(destClient, item, ctx) {
  let props = { ...item.properties };
  const dropped = [];
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    stripAutoExcluded(props, dropped);
    try {
      const res = await destClient.request('POST', '/crm/v3/objects/calls', { properties: props, associations: [] }, { idempotent: false });
      markAccepted(props);
      return { destId: String(res.id), dropped };
    } catch (err) {
      if (err instanceof FatalMigrationError) throw err;
      lastError = err;
      if (err.ambiguous || looksLikeUniqueConflict(err)) {
        // The create may have been applied (or the call already exists): check before retrying.
        if (!ctx.tracking.unique) await sleep(CONFIG.ambiguousWriteWaitMs);
        const existing = (await getDestinationCallsBySourceIds(destClient, [item.sourceId], ctx.tracking)).get(item.sourceId);
        if (existing && existing.length) return { destId: lowestId(existing), dropped, existing: !err.ambiguous, recovered: true };
        if (err.ambiguous) continue;
        return { error: err, dropped };
      }
      if (err instanceof HubSpotApiError && err.status === 400) {
        const droppable = extractRejectedProperties(err.body).filter((n) => n in props && n !== CONFIG.trackingProperty && n !== 'hs_timestamp');
        if (droppable.length) {
          for (const n of droppable) {
            dropped.push({ name: n, value: preview(props[n]), code: 'PROPERTY_REJECTED_BY_DESTINATION', reason: truncate(err.body, 500) });
            recordRejection(n, truncate(err.body, 500));
            delete props[n];
          }
          props = { ...props };
          continue;
        }
      }
      return { error: err, dropped };
    }
  }
  return { error: lastError, dropped };
}

/**
 * Batch-creates calls (100 per request). Anything the batch did not
 * confirm is re-checked against the destination first (so a create that
 * was applied but not acknowledged is never repeated), then created
 * individually.
 * Returns Map<sourceId, { destId, dropped, existing?, error? }>.
 */
async function createDestinationCalls(destClient, items, ctx) {
  const results = new Map();
  const prop = CONFIG.trackingProperty;

  for (const part of chunk(items, PAGE_SIZE)) {
    const wanted = new Set(part.map((i) => i.sourceId));
    let batchError = null;
    try {
      const res = await destClient.request('POST', '/crm/v3/objects/calls/batch/create',
        { inputs: part.map((i) => ({ properties: i.properties, associations: [] })) }, { idempotent: false });
      for (const r of (res && res.results) || []) {
        const s = r.properties && r.properties[prop];
        if (s && wanted.has(String(s))) results.set(String(s), { destId: String(r.id), dropped: [] });
      }
      for (const i of part) if (results.has(i.sourceId)) markAccepted(i.properties);
    } catch (err) {
      if (err instanceof FatalMigrationError) throw err;
      batchError = err;
      logFileOnly('BATCH_CREATE_FALLBACK', 'Batch create failed; verifying and creating calls individually', { status: err.status, message: err.message });
    }

    const unresolved = part.filter((i) => !results.has(i.sourceId));
    if (unresolved.length === 0) continue;

    // Search-based lookup is eventually consistent: give just-created calls
    // time to be indexed before deciding they do not exist.
    if (!ctx.tracking.unique && (!batchError || batchError.ambiguous)) await sleep(CONFIG.ambiguousWriteWaitMs);
    const already = await getDestinationCallsBySourceIds(destClient, unresolved.map((i) => i.sourceId), ctx.tracking);
    for (const item of unresolved) {
      const existing = already.get(item.sourceId);
      if (existing && existing.length) {
        results.set(item.sourceId, { destId: lowestId(existing), dropped: [], recovered: true });
        continue;
      }
      results.set(item.sourceId, await createSingleCall(destClient, item, ctx));
    }
  }
  return results;
}

async function updateSingleCall(destClient, item) {
  let props = { ...item.properties };
  const dropped = [];
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    stripAutoExcluded(props, dropped);
    if (Object.keys(props).length === 0) return { ok: true, dropped };
    try {
      await destClient.request('PATCH', `/crm/v3/objects/calls/${item.destId}`, { properties: props });
      markAccepted(props);
      return { ok: true, dropped };
    } catch (err) {
      if (err instanceof FatalMigrationError) throw err;
      lastError = err;
      if (err instanceof HubSpotApiError && err.status === 400) {
        const droppable = extractRejectedProperties(err.body).filter((n) => n in props && n !== CONFIG.trackingProperty);
        if (droppable.length) {
          for (const n of droppable) {
            dropped.push({ name: n, value: preview(props[n]), code: 'PROPERTY_REJECTED_BY_DESTINATION', reason: truncate(err.body, 500) });
            recordRejection(n, truncate(err.body, 500));
            delete props[n];
          }
          props = { ...props };
          continue;
        }
      }
      return { ok: false, error: err, dropped };
    }
  }
  return { ok: false, error: lastError, dropped };
}

/** Batch-updates calls; falls back to one-by-one PATCH for failures. */
async function updateDestinationCalls(destClient, items) {
  const results = new Map();
  for (const part of chunk(items, PAGE_SIZE)) {
    const okIds = new Set();
    try {
      const res = await destClient.request('POST', '/crm/v3/objects/calls/batch/update',
        { inputs: part.map((i) => ({ id: i.destId, properties: i.properties })) });
      for (const r of (res && res.results) || []) okIds.add(String(r.id));
      for (const i of part) if (okIds.has(i.destId)) markAccepted(i.properties);
    } catch (err) {
      if (err instanceof FatalMigrationError) throw err;
      logFileOnly('BATCH_UPDATE_FALLBACK', 'Batch update failed; updating calls individually', { status: err.status, message: err.message });
    }
    for (const item of part) {
      results.set(item.sourceId, okIds.has(item.destId) ? { ok: true, dropped: [] } : await updateSingleCall(destClient, item));
    }
  }
  return results;
}

// ===========================================================================
// Associations
// ===========================================================================

async function readRecordAssociationsPaginated(client, fromType, fromId, toType) {
  const out = [];
  let after;
  do {
    const q = new URLSearchParams({ limit: '500' });
    if (after) q.set('after', after);
    const page = await client.request('GET', `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}?${q.toString()}`);
    for (const r of (page && page.results) || []) out.push({ toObjectId: String(r.toObjectId), associationTypes: r.associationTypes || [] });
    after = page && page.paging && page.paging.next && page.paging.next.after;
  } while (after);
  return out;
}

/** Map<fromId, [{ toObjectId, associationTypes:[{category,typeId,label}] }]> */
async function batchReadAssociations(client, fromType, toType, fromIds) {
  const out = new Map();
  const needsFullRead = [];
  for (const ids of chunk([...new Set(fromIds)], ASSOC_BATCH_READ_LIMIT)) {
    let res;
    try {
      res = await client.request('POST', `/crm/v4/associations/${fromType}/${toType}/batch/read`, { inputs: ids.map((id) => ({ id: String(id) })) });
    } catch (err) {
      if (err instanceof HubSpotApiError && err.status === 404) continue; // none of these records has associations
      throw err;
    }
    for (const entry of (res && res.results) || []) {
      const fromId = String(entry.from && entry.from.id);
      const to = (entry.to || []).map((t) => ({ toObjectId: String(t.toObjectId), associationTypes: t.associationTypes || [] }));
      out.set(fromId, to);
      if ((entry.paging && entry.paging.next) || to.length >= BATCH_READ_COMPLETENESS_THRESHOLD) needsFullRead.push(fromId);
    }
  }
  for (const fromId of needsFullRead) out.set(fromId, await readRecordAssociationsPaginated(client, fromType, fromId, toType));
  return out;
}

const labelCache = new Map();
async function getAssociationLabels(client, toType) {
  const key = `${client.label}:${toType}`;
  if (!labelCache.has(key)) {
    const res = await client.request('GET', `/crm/v4/associations/calls/${toType}/labels`);
    labelCache.set(key, (res && res.results) || []);
  }
  return labelCache.get(key);
}

const typeKey = (t) => `${t.category}:${t.typeId}`;

/**
 * Resolves source association types to destination types:
 *   HUBSPOT_DEFINED -> same typeId (global table)
 *   USER_DEFINED    -> destination label with identical label text
 * The default unlabeled type is always included (HubSpot requires it).
 */
function resolveAssociationTypes(sourceTypes, destLabels, toType) {
  const types = new Map();
  const unsupported = [];
  const def = { category: 'HUBSPOT_DEFINED', typeId: DEFAULT_CALL_ASSOCIATION_TYPE_ID[toType] };
  types.set(typeKey(def), def);
  for (const t of sourceTypes) {
    if (t.category === 'HUBSPOT_DEFINED') {
      const r = { category: 'HUBSPOT_DEFINED', typeId: Number(t.typeId) };
      types.set(typeKey(r), r);
      continue;
    }
    const match = destLabels.find((d) => d.category !== 'HUBSPOT_DEFINED' && d.label === t.label);
    if (match) {
      const r = { category: match.category, typeId: Number(match.typeId) };
      types.set(typeKey(r), r);
    } else {
      unsupported.push({ sourceCategory: t.category, sourceTypeId: t.typeId, sourceLabel: t.label ?? null });
    }
  }
  return { types: [...types.values()], unsupported };
}

/** Sanity check that the documented default call association types exist in the destination. */
async function verifyAssociationDefinitions(destClient) {
  for (const toType of ASSOCIATED_OBJECT_TYPES) {
    const labels = await getAssociationLabels(destClient, toType);
    const expected = DEFAULT_CALL_ASSOCIATION_TYPE_ID[toType];
    const present = labels.some((l) => l.category === 'HUBSPOT_DEFINED' && Number(l.typeId) === expected);
    if (!present) {
      log('WARN', 'ASSOCIATION_DEFINITION_CHECK', `Destination call->${toType} label list does not include HUBSPOT_DEFINED ${expected}; relying on HubSpot's documented default`, { returned: labels.map((l) => `${l.category}:${l.typeId}:${l.label}`).join('|') });
    }
    const custom = labels.filter((l) => l.category !== 'HUBSPOT_DEFINED');
    log('INFO', 'ASSOCIATION_DEFINITIONS', `call->${toType}: default typeId ${expected}`, { customLabels: custom.map((l) => l.label).join('|') || 'none' });
  }
}

async function createAssociationsIndividually(destClient, toType, items, succeeded, failed) {
  for (const item of items) {
    const body = item.types.map((t) => ({ associationCategory: t.category, associationTypeId: t.typeId }));
    try {
      await destClient.request('PUT', `/crm/v4/objects/calls/${item.destCallId}/associations/${toType}/${item.destToId}`, body);
      succeeded.push(item);
    } catch (err) {
      if (err instanceof FatalMigrationError) throw err;
      failed.push({ item, err });
    }
  }
}

/**
 * Creates the given associations. Each item's `types` is already the UNION
 * of existing + new types for that pair, so no existing label is removed.
 */
async function createMissingAssociations(destClient, toType, items) {
  const succeeded = [];
  const failed = [];
  for (const part of chunk(items, ASSOC_BATCH_CREATE_LIMIT)) {
    const body = {
      inputs: part.map((i) => ({
        from: { id: i.destCallId },
        to: { id: i.destToId },
        types: i.types.map((t) => ({ associationCategory: t.category, associationTypeId: t.typeId })),
      })),
    };
    let retryItems = part;
    try {
      const res = await destClient.request('POST', `/crm/v4/associations/calls/${toType}/batch/create`, body);
      const ok = new Set(((res && res.results) || []).map((r) => `${r.fromObjectId}:${r.toObjectId}`));
      for (const i of part) if (ok.has(`${i.destCallId}:${i.destToId}`)) succeeded.push(i);
      retryItems = part.filter((i) => !ok.has(`${i.destCallId}:${i.destToId}`));
    } catch (err) {
      if (err instanceof FatalMigrationError) throw err;
      logFileOnly('BATCH_ASSOCIATION_FALLBACK', `Batch association create failed for call->${toType}; retrying individually`, { status: err.status, message: err.message });
    }
    if (retryItems.length) await createAssociationsIndividually(destClient, toType, retryItems, succeeded, failed);
  }
  return { succeeded, failed };
}

/**
 * For every call in `results` (already created/updated/unchanged), resolves
 * the source associations to destination records, reads what already
 * exists on the destination, and creates only what is missing.
 */
async function reconcileAssociations(ctx, results) {
  const { destClient } = ctx;
  for (const toType of ASSOCIATED_OBJECT_TYPES) {
    const mapping = ctx.mappings[toType];
    const label = OBJECT_LABEL[toType];
    const destLabels = await getAssociationLabels(destClient, toType);
    const desired = [];

    for (const r of results) {
      const sourceAssocs = ctx.sourceAssociations[toType].get(r.sourceCallId) || [];
      for (const a of sourceAssocs) {
        const res = mapping.lookup(a.toObjectId);
        if (res.status === 'UNAVAILABLE') {
          stats.mappingPropertyMissing[toType] += 1;
          r.assoc[toType].blocked += 1;
          countIssue(`${label}_MAPPING_PROPERTY_MISSING`);
          continue;
        }
        if (res.status !== 'FOUND') {
          stats.mappingMissing[toType] += 1;
          r.assoc[toType].mappingMissing += 1;
          logIssue(res.status === 'AMBIGUOUS' ? `${label}_MAPPING_AMBIGUOUS` : `${label}_MAPPING_NOT_FOUND`,
            `No unique destination ${toType} with ${mapping.property}=${a.toObjectId}`,
            { sourceCallId: r.sourceCallId, destinationCallId: r.destCallId, associatedSourceRecordId: a.toObjectId, candidates: res.destIds }, { toErrorLog: true });
          continue;
        }
        const { types, unsupported } = resolveAssociationTypes(a.associationTypes, destLabels, toType);
        for (const u of unsupported) {
          logIssue('ASSOCIATION_LABEL_NOT_FOUND', `Destination has no call->${toType} label "${u.sourceLabel}"; associating with the default type only`,
            { sourceCallId: r.sourceCallId, associatedSourceRecordId: a.toObjectId, associatedDestinationRecordId: res.destId, ...u }, { toErrorLog: true });
        }
        desired.push({ result: r, destCallId: r.destCallId, destToId: res.destId, sourceToId: a.toObjectId, types });
      }
    }
    if (desired.length === 0) continue;

    // Existing associations on calls that existed before this run.
    const existingCallIds = [...new Set(desired.filter((d) => d.destCallId && !d.result.isNewCall).map((d) => d.destCallId))];
    const existing = existingCallIds.length ? await batchReadAssociations(destClient, 'calls', toType, existingCallIds) : new Map();

    const toCreate = [];
    const seen = new Set();
    for (const d of desired) {
      const pairKey = `${d.destCallId || `new:${d.result.sourceCallId}`}:${d.destToId}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const current = ((existing.get(d.destCallId) || []).find((x) => x.toObjectId === d.destToId) || { associationTypes: [] }).associationTypes
        .map((t) => ({ category: t.category, typeId: Number(t.typeId) }));
      const currentKeys = new Set(current.map(typeKey));
      const missing = d.types.filter((t) => !currentKeys.has(typeKey(t)));
      if (missing.length === 0) {
        d.result.assoc[toType].alreadyPresent += 1;
        stats.associationsAlreadyPresent[toType] += 1;
        continue;
      }
      toCreate.push({ ...d, types: [...current, ...missing], missing });
    }
    if (toCreate.length === 0) continue;

    if (CONFIG.dryRun) {
      for (const d of toCreate) {
        log('INFO', 'DRY RUN', `ASSOCIATE CALL ${d.destCallId || `(new, source ${d.result.sourceCallId})`} → ${label} ${d.destToId}`,
          { sourceRecord: d.sourceToId, types: d.types.map(typeKey).join(',') });
        d.result.assoc[toType].created += 1;
        stats.associationsCreated[toType] += 1;
      }
      continue;
    }

    const { succeeded, failed } = await createMissingAssociations(destClient, toType, toCreate);
    for (const d of succeeded) {
      d.result.assoc[toType].created += 1;
      stats.associationsCreated[toType] += 1;
      logFileOnly('ASSOCIATED', `CALL ${d.destCallId} → ${label} ${d.destToId}`, { sourceCall: d.result.sourceCallId, sourceRecord: d.sourceToId, types: d.types.map(typeKey).join(',') });
    }
    for (const { item: d, err } of failed) {
      d.result.assoc[toType].failed += 1;
      d.result.hadAssociationError = true;
      stats.associationsFailed[toType] += 1;
      logError('ASSOCIATION_CREATE_FAILED', {
        sourceCallId: d.result.sourceCallId,
        destinationCallId: d.destCallId,
        operation: `ASSOCIATE_CALL_${label}`,
        associatedObjectType: toType,
        associatedSourceRecordId: d.sourceToId,
        associatedDestinationRecordId: d.destToId,
        ...apiErrorFields(err),
      });
    }
  }
}

// ===========================================================================
// Per-call planning and page processing
// ===========================================================================

function newCallResult(sourceCallId) {
  const assoc = () => ({ created: 0, alreadyPresent: 0, mappingMissing: 0, blocked: 0, failed: 0 });
  return {
    sourceCallId,
    destCallId: null,
    isNewCall: false,
    plannedAction: null,
    action: null,
    properties: null,
    owner: null,
    skippedProperties: [],
    hadAssociationError: false,
    assoc: { contacts: assoc(), companies: assoc(), deals: assoc() },
  };
}

/** Decides CREATE / UPDATE / UNCHANGED for one source call (no writes). */
function migrateCall(sourceCall, ctx, lookup, destCurrent) {
  const r = newCallResult(String(sourceCall.id));
  const t = transformCallProperties(sourceCall, ctx);
  r.owner = t.owner;
  r.skippedProperties = t.skipped;
  if (t.fatalReason) {
    r.action = 'FAILED';
    logError('CALL_TRANSFORM_FAILED', { sourceCallId: r.sourceCallId, operation: 'TRANSFORM_CALL', message: t.fatalReason });
    return r;
  }

  const destIds = lookup.get(r.sourceCallId) || [];
  if (destIds.length > 1) {
    logIssue('DUPLICATE_DESTINATION_CALLS', `${destIds.length} destination calls carry ${CONFIG.trackingProperty}=${r.sourceCallId}; updating the oldest, not creating another`,
      { sourceCallId: r.sourceCallId, destinationCallIds: destIds.join(',') }, { toErrorLog: true, console: true });
  }
  if (destIds.length === 0) {
    r.plannedAction = 'CREATE';
    r.isNewCall = true;
    r.properties = t.properties;
    return r;
  }
  r.destCallId = lowestId(destIds);
  const changed = diffProperties(t.properties, destCurrent.get(r.destCallId) || {}, ctx.plan);
  if (Object.keys(changed).length === 0) {
    r.plannedAction = 'UNCHANGED';
  } else {
    r.plannedAction = 'UPDATE';
    r.properties = changed;
  }
  return r;
}

function logSkippedProperties(r) {
  if (r.skippedProperties.length === 0) return;
  for (const s of r.skippedProperties) {
    if (s.expected) continue;
    stats.propertiesSkipped += 1;
    countIssue(s.code, { sourceCallId: r.sourceCallId, property: s.name, value: s.value, reason: s.reason });
  }
  logFileOnly('PROPERTY_SKIPPED', `sourceCall=${r.sourceCallId}`, {
    properties: r.skippedProperties.map((s) => `${s.name}:${s.code}`).join(','),
  });
  for (const s of r.skippedProperties.filter((x) => x.code === 'PROPERTY_REJECTED_BY_DESTINATION' || x.code === 'CALL_OUTCOME_NOT_IN_DESTINATION' || x.code === 'PROPERTY_VALUE_NOT_ALLOWED')) {
    append(LOG.errors, `${nowIso()} [WARN] code=${s.code}\n  sourceCallId=${r.sourceCallId}\n  destinationCallId=${r.destCallId || ''}\n  property=${s.name}\n  value=${s.value}\n  reason=${s.reason}\n`);
  }
}

function logCallOutcome(r) {
  logSkippedProperties(r);
  if (r.action === 'FAILED') {
    stats.failed += 1;
    return;
  }
  if (r.action === 'CREATED') stats.created += 1;
  else if (r.action === 'UPDATED') stats.updated += 1;
  else if (r.action === 'UNCHANGED') stats.alreadyCurrent += 1;
  if (r.hadAssociationError) stats.callsWithAssociationErrors += 1;

  const dry = CONFIG.dryRun ? ' (DRY RUN)' : '';
  const assocLine = (t) => {
    const a = r.assoc[t];
    return `${a.created + a.alreadyPresent} (created ${a.created}, already present ${a.alreadyPresent}, mapping missing ${a.mappingMissing + a.blocked}, failed ${a.failed})`;
  };
  const owner = r.owner || {};
  append(LOG.success, [
    `${nowIso()} [${r.action === 'UNCHANGED' ? 'UNCHANGED' : r.action}]${dry}${r.hadAssociationError ? ' [PARTIAL: association errors]' : ''}`,
    `Source Call: ${r.sourceCallId}`,
    `Destination Call: ${r.destCallId || (CONFIG.dryRun ? '(would be created)' : '')}`,
    `Owner: ${owner.sourceOwnerId || '-'} → ${owner.destinationOwnerId || '-'} (${owner.status || 'NO_SOURCE_OWNER'})`,
    `Contacts: ${assocLine('contacts')}`,
    `Companies: ${assocLine('companies')}`,
    `Deals: ${assocLine('deals')}`,
    `Properties written: ${r.properties ? Object.keys(r.properties).length : 0}, skipped: ${r.skippedProperties.length}`,
    '',
  ].join('\n'));
  log('INFO', r.action, `sourceCall=${r.sourceCallId} destinationCall=${r.destCallId || '(new)'}${dry}`, {
    owner: `${owner.sourceOwnerId || '-'}→${owner.destinationOwnerId || '-'}`,
    contacts: r.assoc.contacts.created, companies: r.assoc.companies.created, deals: r.assoc.deals.created,
  });
}

function applyWriteOutcome(r, outcome, action) {
  for (const d of outcome.dropped || []) r.skippedProperties.push(d);
  if (outcome.error) {
    r.action = 'FAILED';
    logError(action === 'CREATED' ? 'CREATE_CALL_FAILED' : 'UPDATE_CALL_FAILED', {
      sourceCallId: r.sourceCallId,
      destinationCallId: r.destCallId,
      operation: action === 'CREATED' ? 'CREATE_CALL' : 'UPDATE_CALL',
      ...apiErrorFields(outcome.error),
    });
    return false;
  }
  return true;
}

/** Processes one page of source calls end to end. Returns true if every call fully succeeded. */
async function processPage(calls, ctx) {
  const { sourceClient, destClient } = ctx;
  const ids = calls.map((c) => String(c.id));

  // 1. Source associations (labels included).
  ctx.sourceAssociations = {};
  for (const toType of ASSOCIATED_OBJECT_TYPES) {
    ctx.sourceAssociations[toType] = await batchReadAssociations(sourceClient, 'calls', toType, ids);
  }

  // 2. Resolve destination record IDs for everything this page references.
  for (const toType of ASSOCIATED_OBJECT_TYPES) {
    const needed = new Set();
    for (const list of ctx.sourceAssociations[toType].values()) for (const a of list) needed.add(a.toObjectId);
    for (const c of calls) {
      const p = c.properties || {};
      if (CALLEE_OBJECT_TYPE_MAP[String(p.hs_call_callee_object_type || '').toUpperCase()] === toType && !isEmpty(p.hs_call_callee_object_id)) needed.add(String(p.hs_call_callee_object_id));
    }
    await ctx.mappings[toType].resolveMany(destClient, [...needed]);
  }

  // 3. Existing destination calls (duplicate detection) + their current values.
  const lookup = await getDestinationCallsBySourceIds(destClient, ids, ctx.tracking);
  const existingDestIds = [...new Set([...lookup.values()].flat())];
  const compareProps = [...ctx.plan.writable.keys(), CONFIG.trackingProperty];
  const destCurrent = existingDestIds.length ? await getDestinationCallDetails(destClient, existingDestIds, compareProps) : new Map();

  // 4. Plan every call (isolated per call).
  const results = calls.map((c) => {
    try {
      return migrateCall(c, ctx, lookup, destCurrent);
    } catch (err) {
      if (err instanceof FatalMigrationError) throw err;
      const r = newCallResult(String(c.id));
      r.action = 'FAILED';
      logError('CALL_PLANNING_FAILED', { sourceCallId: r.sourceCallId, operation: 'PLAN_CALL', message: err.stack || err.message });
      return r;
    }
  });

  // 5. Creates.
  const creates = results.filter((r) => r.plannedAction === 'CREATE' && !r.action);
  if (creates.length) {
    if (CONFIG.dryRun) {
      for (const r of creates) {
        log('INFO', 'DRY RUN', `CREATE CALL source=${r.sourceCallId}`, { properties: Object.keys(r.properties).length, owner: r.owner.destinationOwnerId || '-' });
        r.action = 'CREATED';
      }
    } else {
      const outcomes = await createDestinationCalls(destClient, creates.map((r) => ({ sourceId: r.sourceCallId, properties: r.properties })), ctx);
      for (const r of creates) {
        const o = outcomes.get(r.sourceCallId) || { error: new Error('no create outcome returned') };
        if (!applyWriteOutcome(r, o, 'CREATED')) continue;
        r.destCallId = o.destId;
        if (o.recovered) r.isNewCall = false; // found rather than created by this request: read its existing associations
        if (o.existing) {
          // Found to already exist at write time: sync it via update instead.
          r.isNewCall = false;
          r.plannedAction = 'UPDATE';
        } else {
          r.action = 'CREATED';
        }
      }
    }
  }

  // 6. Updates.
  const updates = results.filter((r) => r.plannedAction === 'UPDATE' && !r.action);
  if (updates.length) {
    if (CONFIG.dryRun) {
      for (const r of updates) {
        log('INFO', 'DRY RUN', `UPDATE CALL destination=${r.destCallId} source=${r.sourceCallId}`, { changed: Object.keys(r.properties).join(',') });
        r.action = 'UPDATED';
      }
    } else {
      const outcomes = await updateDestinationCalls(destClient, updates.map((r) => ({ sourceId: r.sourceCallId, destId: r.destCallId, properties: r.properties })));
      for (const r of updates) {
        if (applyWriteOutcome(r, outcomes.get(r.sourceCallId) || { error: new Error('no update outcome returned') }, 'UPDATED')) r.action = 'UPDATED';
      }
    }
  }
  for (const r of results) if (r.plannedAction === 'UNCHANGED' && !r.action) r.action = 'UNCHANGED';

  // 7. Associations (create only what is missing).
  const live = results.filter((r) => r.action !== 'FAILED' && (r.destCallId || CONFIG.dryRun));
  try {
    await reconcileAssociations(ctx, live);
  } catch (err) {
    if (err instanceof FatalMigrationError) throw err;
    for (const r of live) r.hadAssociationError = true;
    logError('ASSOCIATION_RECONCILE_FAILED', { operation: 'RECONCILE_ASSOCIATIONS', sourceCallId: live.map((r) => r.sourceCallId).join(','), ...apiErrorFields(err) });
  }

  // 8. Logs.
  for (const r of results) logCallOutcome(r);
  return results.every((r) => r.action !== 'FAILED' && !r.hadAssociationError);
}

// ===========================================================================
// Checkpoint (performance only - never used to decide "already migrated")
// ===========================================================================

function loadCheckpoint() {
  if (!CONFIG.resume || CONFIG.sourceCallIds.length || CONFIG.dryRun) return null;
  const cp = readJson(LOG.checkpoint);
  if (!cp) return null;
  if (cp.sourcePortalId !== CONFIG.sourcePortalId || cp.destinationPortalId !== CONFIG.destinationPortalId || cp.trackingProperty !== CONFIG.trackingProperty) {
    log('WARN', 'CHECKPOINT_REJECTED', 'Checkpoint belongs to different portals/property; starting from the beginning');
    return null;
  }
  if (cp.completed) {
    log('INFO', 'CHECKPOINT', 'Previous run completed; starting a full reconciliation pass from the beginning');
    return null;
  }
  return cp;
}

function saveCheckpoint(data) {
  if (CONFIG.dryRun || CONFIG.sourceCallIds.length) return;
  writeJsonAtomic(LOG.checkpoint, {
    sourcePortalId: CONFIG.sourcePortalId,
    destinationPortalId: CONFIG.destinationPortalId,
    trackingProperty: CONFIG.trackingProperty,
    updatedAt: nowIso(),
    ...data,
  });
}

// ===========================================================================
// Summary
// ===========================================================================

function topErrors() {
  return Object.entries(stats.errorCodes).sort((a, b) => b[1] - a[1]);
}

function buildSummary(ctx) {
  const finished = stats.finishedAt || new Date();
  return {
    sourcePortalId: CONFIG.sourcePortalId,
    destinationPortalId: CONFIG.destinationPortalId,
    dryRun: CONFIG.dryRun,
    startedAt: stats.startedAt.toISOString(),
    finishedAt: finished.toISOString(),
    durationSeconds: Math.round((finished - stats.startedAt) / 1000),
    trackingProperty: CONFIG.trackingProperty,
    trackingPropertyState: ctx && ctx.tracking ? ctx.tracking : null,
    recordMappings: ctx && ctx.mappings
      ? Object.fromEntries(Object.entries(ctx.mappings).map(([k, m]) => [k, { property: m.property, status: m.status, populatedInDestination: m.populatedCount ?? null, resolved: m.map.size, ambiguous: m.ambiguous.size }]))
      : null,
    sourceCallsEstimated: stats.estimatedSourceTotal,
    sourceCallsFound: stats.sourceCallsFound,
    created: stats.created,
    updated: stats.updated,
    alreadyCurrent: stats.alreadyCurrent,
    failed: stats.failed,
    callsWithAssociationErrors: stats.callsWithAssociationErrors,
    associationsCreated: stats.associationsCreated,
    associationsAlreadyPresent: stats.associationsAlreadyPresent,
    associationsFailed: stats.associationsFailed,
    mappingMissing: stats.mappingMissing,
    mappingPropertyMissing: stats.mappingPropertyMissing,
    propertiesSkipped: stats.propertiesSkipped,
    ownerMappingMissing: stats.ownerMappingMissing,
    ownerMappingInvalid: stats.ownerMappingInvalid,
    ownerUnassigned: stats.ownerUnassigned,
    rateLimitRetries: stats.rateLimitRetries,
    otherRetries: stats.otherRetries,
    stoppedEarly: stats.stoppedEarly,
    fatalError: stats.fatalError,
    topErrors: topErrors().map(([code, count]) => ({ code, count })),
    errorSamples: stats.errorSamples,
    logFiles: { main: LOG.main, success: LOG.success, errors: LOG.errors, summary: LOG.summary, propertyReport: LOG.propertyReport, ownerReport: LOG.ownerReport },
  };
}

function printSummary(summary) {
  const d = summary.durationSeconds;
  const dur = `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m ${d % 60}s`;
  const w = CONFIG.dryRun ? ' (would be)' : '';
  const lines = [
    '========================================',
    `CALL MIGRATION SUMMARY${CONFIG.dryRun ? ' — DRY RUN (no writes were made)' : ''}`,
    '========================================',
    '',
    `Source Portal:      ${summary.sourcePortalId}`,
    `Destination Portal: ${summary.destinationPortalId}`,
    '',
    `Source Calls Found: ${summary.sourceCallsFound}${summary.sourceCallsEstimated !== null ? ` (portal total ≈ ${summary.sourceCallsEstimated})` : ''}`,
    `Created${w}: ${summary.created}`,
    `Updated${w}: ${summary.updated}`,
    `Already Current: ${summary.alreadyCurrent}`,
    `Failed: ${summary.failed}`,
    `Calls With Association Errors: ${summary.callsWithAssociationErrors}`,
    '',
    `Contact Associations Created${w}: ${summary.associationsCreated.contacts} (already present ${summary.associationsAlreadyPresent.contacts}, failed ${summary.associationsFailed.contacts})`,
    `Company Associations Created${w}: ${summary.associationsCreated.companies} (already present ${summary.associationsAlreadyPresent.companies}, failed ${summary.associationsFailed.companies})`,
    `Deal Associations Created${w}: ${summary.associationsCreated.deals} (already present ${summary.associationsAlreadyPresent.deals}, failed ${summary.associationsFailed.deals})`,
    '',
    `Contact Mapping Missing: ${summary.mappingMissing.contacts}${summary.mappingPropertyMissing.contacts ? ` (+${summary.mappingPropertyMissing.contacts} blocked: tm_contact_record_id missing)` : ''}`,
    `Company Mapping Missing: ${summary.mappingMissing.companies}${summary.mappingPropertyMissing.companies ? ` (+${summary.mappingPropertyMissing.companies} blocked: tm_company_record_id missing)` : ''}`,
    `Deal Mapping Missing: ${summary.mappingMissing.deals}${summary.mappingPropertyMissing.deals ? ` (+${summary.mappingPropertyMissing.deals} blocked: tm_deal_record_id missing)` : ''}`,
    '',
    `Properties Skipped: ${summary.propertiesSkipped}`,
    `Owner Mapping Missing: ${summary.ownerMappingMissing}`,
    `Owner Mapping Invalid: ${summary.ownerMappingInvalid}`,
    `Owner Left Unassigned: ${summary.ownerUnassigned}`,
    '',
    `Rate Limit Retries: ${summary.rateLimitRetries}`,
    `Other Retries: ${summary.otherRetries}`,
    '',
    `Duration: ${dur}`,
  ];
  if (summary.stoppedEarly) lines.push('', 'NOTE: run stopped early (interrupt or MAX_CALLS). Re-run to continue.');
  if (summary.fatalError) lines.push('', `FATAL: ${summary.fatalError}`);
  const deals = summary.recordMappings && summary.recordMappings.deals;
  if (deals && (deals.status === 'PROPERTY_MISSING' || deals.status === 'PROPERTY_NOT_POPULATED')) {
    lines.push('', 'Deal association migration is blocked because tm_deal_record_id', 'is missing or not populated in the destination portal.');
  }
  lines.push('========================================');
  const top = summary.topErrors;
  if (top.length) {
    lines.push('', 'Top Errors / Issues:', '');
    top.slice(0, 25).forEach((e, i) => lines.push(`${i + 1}. ${e.code}: ${e.count}`));
  }
  lines.push('', `Logs: ${CONFIG.logDir}`);
  const text = lines.join('\n');
  console.log(`\n${text}\n`);
  append(LOG.main, text);
}

// ===========================================================================
// Main
// ===========================================================================

let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  console.warn('\n[INTERRUPT] Finishing the current page, then stopping. Press Ctrl+C again to abort immediately.');
});

async function run(ctx) {
  console.log('========================================');
  console.log('HUBSPOT CALL MIGRATION');
  console.log('========================================');
  console.log(`Source Portal ID:      ${CONFIG.sourcePortalId || '(not set)'}`);
  console.log(`Destination Portal ID: ${CONFIG.destinationPortalId || '(not set)'}`);
  console.log(`DRY_RUN:               ${CONFIG.dryRun}`);
  console.log(`Migration start time:  ${stats.startedAt.toISOString()}`);
  console.log('========================================');
  append(LOG.main, `\n${nowIso()} ===== RUN START dryRun=${CONFIG.dryRun} source=${CONFIG.sourcePortalId} destination=${CONFIG.destinationPortalId} setupOnly=${CONFIG.setupOnly} =====`);

  validateEnvironment();
  const sourceClient = createClient(CONFIG.sourceToken, 'SOURCE');
  const destClient = createClient(CONFIG.destinationToken, 'DESTINATION');
  ctx.sourceClient = sourceClient;
  ctx.destClient = destClient;

  const { sourceInfo, destInfo } = await verifyPortals(sourceClient, destClient);
  console.log(`SOURCE PORTAL:      ${sourceInfo.portalId} (${sourceInfo.uiDomain || ''} ${sourceInfo.accountType || ''})`);
  console.log(`DESTINATION PORTAL: ${destInfo.portalId} (${destInfo.uiDomain || ''} ${destInfo.accountType || ''})`);
  console.log(`DRY RUN:            ${CONFIG.dryRun}`);
  console.log('========================================');

  // Schema.
  const [sourceProps, destPropsList] = await Promise.all([getObjectProperties(sourceClient, 'calls'), getObjectProperties(destClient, 'calls')]);
  const destPropsByName = new Map(destPropsList.map((p) => [p.name, p]));
  if (CONFIG.setupOnly) {
    ctx.tracking = await ensureSourceCallIdProperty(destClient, destPropsByName);
    log('INFO', 'SETUP', `Setup complete: "${CONFIG.trackingProperty}" ${ctx.tracking.created ? 'created' : 'already existed'} (unique=${ctx.tracking.unique}).`);
    return;
  }

  // Every read-only validation runs BEFORE the first destination write, so a
  // configuration problem never leaves a half-configured destination.
  ctx.plan = buildPropertyPlan(sourceProps, destPropsByName);
  ctx.owners = await validateOwners(destClient);
  ctx.dispositions = ctx.plan.writable.has('hs_call_disposition') ? await buildDispositionMapping(sourceClient, destClient) : { available: false, map: new Map(), srcLabels: new Map() };
  await verifyAssociationDefinitions(destClient);
  stats.estimatedSourceTotal = CONFIG.sourceCallIds.length ? CONFIG.sourceCallIds.length : await estimateSourceCallTotal(sourceClient);
  const useScan = CONFIG.mappingStrategy === 'scan' ||
    (CONFIG.mappingStrategy === 'auto' && (stats.estimatedSourceTotal === null || stats.estimatedSourceTotal > CONFIG.mappingScanMinCalls));
  log('INFO', 'RECORD_MAPPING', `Resolving destination records by ${useScan ? 'full scan + cache' : 'on-demand search'}`, { strategy: CONFIG.mappingStrategy, sourceCalls: stats.estimatedSourceTotal });
  ctx.mappings = {};
  for (const t of ASSOCIATED_OBJECT_TYPES) {
    ctx.mappings[t] = new RecordMapping(t);
    await ctx.mappings[t].build(destClient, useScan);
  }
  await checkUntrackedDestinationCalls(destClient, destPropsByName.has(CONFIG.trackingProperty));

  // First possible write: the tracking property (skipped in dry run).
  ctx.tracking = await ensureSourceCallIdProperty(destClient, destPropsByName);
  writePropertyReport(ctx.plan, sourceProps, destPropsByName, ctx.tracking);

  const dealStatus = ctx.mappings.deals.status;
  if (dealStatus === 'PROPERTY_MISSING' || dealStatus === 'PROPERTY_NOT_POPULATED') {
    log('WARN', 'DEAL_ASSOCIATIONS_BLOCKED',
      'Deal association migration is blocked because tm_deal_record_id is missing or not populated in the destination portal. Calls and Contact/Company associations continue.');
  }

  // Iterate source calls.
  const checkpoint = loadCheckpoint();
  if (checkpoint) log('INFO', 'RESUME', `Resuming from checkpoint (calls before it were processed in an earlier run; they are re-reconciled on the next full pass)`, { after: checkpoint.after, previouslyProcessed: checkpoint.callsProcessed });
  let callsProcessedTotal = checkpoint ? checkpoint.callsProcessed || 0 : 0;
  let checkpointAfter = checkpoint ? checkpoint.after : null;
  let checkpointBlocked = false;
  let reachedEnd = false;

  for await (const page of getSourceCalls(sourceClient, ctx.plan.readProperties, checkpointAfter)) {
    let calls = page.calls;
    let truncatedPage = false;
    if (CONFIG.maxCalls && stats.sourceCallsFound + calls.length > CONFIG.maxCalls) {
      calls = calls.slice(0, CONFIG.maxCalls - stats.sourceCallsFound);
      truncatedPage = true;
    }
    if (calls.length) {
      stats.sourceCallsFound += calls.length;
      const pageOk = await processPage(calls, ctx);
      callsProcessedTotal += calls.length;
      if (!pageOk || truncatedPage) checkpointBlocked = true;
    }
    log('INFO', 'PROGRESS', `Fetched: ${stats.sourceCallsFound}${stats.estimatedSourceTotal !== null ? ` / ${stats.estimatedSourceTotal}` : ''}`, {
      created: stats.created, updated: stats.updated, unchanged: stats.alreadyCurrent, failed: stats.failed,
    });

    // Advance the resume cursor only across pages that fully succeeded, so a
    // resumed run always revisits the first page that had any failure.
    if (!checkpointBlocked) {
      checkpointAfter = page.nextAfter;
      saveCheckpoint({ after: checkpointAfter, callsProcessed: callsProcessedTotal, completed: false });
    }
    for (const m of Object.values(ctx.mappings)) if (m.dirty) m.saveCache();

    if (!page.nextAfter) reachedEnd = true;
    if (truncatedPage || (CONFIG.maxCalls && stats.sourceCallsFound >= CONFIG.maxCalls)) {
      stats.stoppedEarly = !reachedEnd;
      break;
    }
    if (stopRequested) {
      stats.stoppedEarly = true;
      break;
    }
  }
  if (CONFIG.sourceCallIds.length) reachedEnd = true;
  if (reachedEnd && !stats.stoppedEarly) {
    saveCheckpoint({ after: checkpointBlocked ? checkpointAfter : null, callsProcessed: callsProcessedTotal, completed: !checkpointBlocked });
  }
}

const LOCK_FILE = path.join(CONFIG.logDir, 'call-migration.lock');
let lockHeld = false;

/** Prevents two runs against the same LOG_DIR at once (two runs could race on creates). */
function acquireLock() {
  const existing = readJson(LOCK_FILE);
  if (existing && existing.pid && existing.pid !== process.pid) {
    let alive = false;
    try {
      process.kill(existing.pid, 0);
      alive = true;
    } catch (err) {
      alive = err.code === 'EPERM';
    }
    if (alive) throw new FatalMigrationError(`Another migrate-calls.js run (pid ${existing.pid}, started ${existing.startedAt}) is using ${CONFIG.logDir}. Stop it first.`);
    log('WARN', 'STALE_LOCK', `Removing stale lock from pid ${existing.pid}`);
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: nowIso(), dryRun: CONFIG.dryRun }));
  lockHeld = true;
}

function releaseLock() {
  if (!lockHeld) return;
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // already gone
  }
  lockHeld = false;
}

async function main() {
  ensureLogDir();
  const ctx = {};
  let exitCode = 0;
  try {
    acquireLock();
    await run(ctx);
  } catch (err) {
    exitCode = 1;
    stats.fatalError = err.message;
    logError(err instanceof FatalMigrationError ? 'FATAL' : 'UNEXPECTED_FATAL', {
      operation: 'MIGRATION',
      message: err instanceof FatalMigrationError ? err.message : err.stack || err.message,
      responseBody: err.details ? err.details.body : undefined,
      endpoint: err.details ? err.details.endpoint : err.endpoint,
      httpStatus: err.details ? err.details.status : err.status,
    });
  } finally {
    releaseLock();
    if (ctx.mappings) for (const m of Object.values(ctx.mappings)) if (m.dirty) m.saveCache();
    stats.finishedAt = new Date();
    if (!CONFIG.setupOnly || stats.fatalError) {
      const summary = buildSummary(ctx);
      writeJsonAtomic(LOG.summary, summary);
      printSummary(summary);
    }
  }
  process.exitCode = exitCode || (stats.failed > 0 ? 2 : 0);
}

main();
