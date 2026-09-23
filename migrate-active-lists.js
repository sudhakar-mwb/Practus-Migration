#!/usr/bin/env node

/**
 * ============================================================
 * HUBSPOT ACTIVE LIST MIGRATION  (source portal -> destination portal)
 * ============================================================
 *
 * Migrates ONLY the lists named in REQUESTED_LISTS below, recreating each
 * one's full filter configuration in the destination portal under the name
 * "Touchmath | <source name>".
 *
 * ------------------------------------------------------------
 * REQUIREMENTS
 * ------------------------------------------------------------
 *   Node.js 18 or newer (uses the built-in global fetch).
 *   No npm packages required. Tokens may be supplied via `--env-file`,
 *   which needs Node 20+, or exported into the environment on any Node 18+.
 *
 * ------------------------------------------------------------
 * ENVIRONMENT VARIABLES
 * ------------------------------------------------------------
 *   SOURCE_HUBSPOT_ACCESS_TOKEN        Private app token, source portal.
 *   DESTINATION_HUBSPOT_ACCESS_TOKEN   Private app token, destination portal.
 *
 *   For compatibility with the other scripts in this repo, SOURCE_HUBSPOT_TOKEN
 *   and DESTINATION_HUBSPOT_TOKEN are accepted as fallbacks.
 *
 *   Optional:
 *     DRY_RUN            "true"/"false". Default "true". Reads and compares
 *                        everything, writes nothing.
 *     MAX_RETRIES        Default 5.
 *     RETRY_BASE_DELAY_MS Default 1000 (1s, 2s, 4s, 8s, 16s).
 *     REQUEST_DELAY_MS   Pacing between calls. Default 250.
 *     ALLOW_LOSSY        "true"/"false". Default "false". See LIMITATIONS.
 *     FORM_MAP_FILE      Default ./active-list-form-map.json
 *     LOG_DIRECTORY      Default ./logs
 *     HUBSPOT_API_BASE   Override the API base URL (for testing).
 *
 * ------------------------------------------------------------
 * REQUIRED HUBSPOT PRIVATE APP SCOPES
 * ------------------------------------------------------------
 * Verified by exercising each endpoint against both live portals:
 *   SOURCE token       crm.lists.read
 *                      crm.objects.contacts.read   (lists of contacts)
 *                      forms                       (to name the forms a
 *                                                   FORM_SUBMISSION filter
 *                                                   references, for the log)
 *   DESTINATION token  crm.lists.read
 *                      crm.lists.write
 *                      crm.objects.contacts.read
 *                      crm.schemas.contacts.read   (to verify that every
 *                                                   property a filter uses
 *                                                   exists before writing)
 *                      forms                       (to verify referenced
 *                                                   forms exist)
 * A list on a non-contact object additionally needs the matching
 * crm.objects.<object>.read / crm.schemas.<object>.read scope.
 *
 * ------------------------------------------------------------
 * USAGE
 * ------------------------------------------------------------
 *   # 1. Preview (default — writes nothing):
 *   node --env-file=.env migrate-active-lists.js
 *
 *   # 2. Real migration:
 *   DRY_RUN=false node --env-file=.env migrate-active-lists.js
 *
 * ------------------------------------------------------------
 * HUBSPOT ENDPOINTS USED  (all verified live before this was written)
 * ------------------------------------------------------------
 *   POST /crm/v3/lists/search                      enumerate lists
 *        body {count, offset} -> {lists, hasMore, offset, total}
 *        NOTE: GET /crm/v3/lists is NOT a list-all endpoint. It answers
 *        200 {"lists": []}, which silently reads as "no lists exist".
 *   GET  /crm/v3/lists/{listId}?includeFilters=true  full config + filterBranch
 *        Without includeFilters the response has NO filterBranch at all.
 *   POST /crm/v3/lists                              create
 *        body {name, objectTypeId, processingType, filterBranch}
 *   PUT  /crm/v3/lists/{listId}/update-list-filters update filters
 *        body {filterBranch, enrollObjectsInWorkflows}
 *   PUT  /crm/v3/lists/{listId}/update-list-name?listName=...   rename
 *        PATCH and POST both answer 405 here; it must be PUT.
 *   GET  /crm/v3/properties/{objectType}            pre-flight property check
 *   GET  /marketing/v3/forms/{formId}               pre-flight form check
 *
 * The legacy /contacts/v1/lists API is retired and is never used.
 *
 * ------------------------------------------------------------
 * HOW ACTIVE LISTS ARE REPLICATED
 * ------------------------------------------------------------
 * A list's behaviour lives entirely in its `filterBranch`: a recursive tree of
 * filterBranches (each with filterBranchType/filterBranchOperator AND or OR)
 * and filters. The whole tree is copied verbatim — operators, operationTypes,
 * every value in a multi-value filter, time-range endpoints and timezones,
 * includeObjectsWithNoValueSet — with exactly two exceptions, both of which
 * are cross-portal id references that are rewritten or refused (see below).
 * processingType is carried across, so a DYNAMIC (active) source list is
 * created DYNAMIC and keeps evaluating members; it is never downgraded to a
 * static list.
 *
 * ------------------------------------------------------------
 * KNOWN LIMITATIONS  (verified, not assumed)
 * ------------------------------------------------------------
 * 1. FORM_SUBMISSION filters reference a form GUID. Form GUIDs are NOT
 *    portable: all three forms referenced by these lists return 404 in the
 *    destination portal, and no destination form carries the same name.
 *    HubSpot ACCEPTS a foreign form id without complaint and builds a list
 *    that matches zero contacts — a silently empty list, not an error. This
 *    script therefore refuses to write such a list by default and reports it
 *    as `partial`. Map the forms in FORM_MAP_FILE (see below) and re-run, or
 *    set ALLOW_LOSSY=true to create the list anyway, knowingly empty.
 *
 * 2. IN_LIST filters reference another list by id. List ids are NOT portable
 *    either. Where the referenced list is itself in REQUESTED_LISTS, this
 *    script migrates it first (dependency order) and rewrites the reference
 *    to the destination id. Where it is not, the list is reported as
 *    `partial` rather than pointed at whatever happens to hold that id in the
 *    destination — the two portals reuse the same numeric id space for
 *    unrelated lists.
 *
 * 3. A filter on a property that does not exist in the destination portal
 *    cannot behave the same way. Such lists are reported as `partial`.
 *
 * 4. MANUAL (static) lists have no filters; membership is a stored set of
 *    records. Contact ids are not portable, so a MANUAL list is created
 *    EMPTY and reported as `partial`. Seven of the requested lists are MANUAL
 *    in the source despite being described as Active Lists.
 *
 * 5. processingType cannot be changed after a list is created. If a
 *    destination list exists with a different processingType, this script
 *    reports it rather than deleting and recreating the list.
 *
 * 6. Migrating a list migrates its CRITERIA, not its members. A DYNAMIC list
 *    recomputes membership from the destination portal's own contacts and
 *    their engagement history, so a list that matches thousands of contacts
 *    in the source will match few or none here until the underlying contact,
 *    form-submission and email-engagement data exists in the destination too.
 *    An empty migrated list is therefore usually a data gap, not a broken
 *    filter — check the destination contact count before concluding the
 *    filters are wrong.
 *
 * 7. Lists are SOFT-deleted. A deleted list still answers 200 on
 *    GET /crm/v3/lists/{id}, with a `deletedAt` set; only
 *    POST /crm/v3/lists/search leaves it out. Anything resolving a list by id
 *    must check `deletedAt` or it will treat a deleted list as live.
 *
 * 8. A UNIFIED_EVENTS branch filters on a custom behavioural event. The event
 *    type itself resolves in the destination portal, but a custom property on
 *    that event may not be filterable there. HubSpot rejects this loudly —
 *    400 ListError.UNIFIED_EVENT_PROPERTIES_NOT_FILTERABLE, naming the
 *    property — so no pre-check is attempted and the failure is reported with
 *    HubSpot's own message. Event-scoped property names are deliberately NOT
 *    validated against the contact schema; they belong to the event schema.
 *
 * FORM_MAP_FILE format — {"<source form GUID>": "<destination form GUID>"}.
 * The file is created empty on first run for you to fill in.
 *
 * ------------------------------------------------------------
 * PRIVACY
 * ------------------------------------------------------------
 * Filter values in these lists include personal data (contact email
 * addresses). Filter VALUES are never written to the logs — they are
 * summarised as a count and a hash. Property names, operators and branch
 * structure are logged, since those are what you need in order to debug a
 * migration. Access tokens are never logged.
 *
 * ------------------------------------------------------------
 * RE-RUN BEHAVIOUR
 * ------------------------------------------------------------
 * Safe to re-run. A destination list is located by its EXACT expected name,
 * "Touchmath | <source name>". Found and equivalent -> already_synced, no
 * write. Found and different -> filters updated in place. Not found ->
 * created. Nothing is ever deleted, in either portal.
 *
 * ------------------------------------------------------------
 * TROUBLESHOOTING
 * ------------------------------------------------------------
 *   401/403       Token missing a scope from the list above.
 *   "Source list not found"
 *                 The name in REQUESTED_LISTS no longer matches the source
 *                 exactly. Check for a rename or stray whitespace.
 *   Stuck PROCESSING
 *                 Normal. A new DYNAMIC list takes time to evaluate its
 *                 members; processingStatus becomes COMPLETE on its own and
 *                 does not affect whether the filters were saved correctly.
 *   partial       Read the reason in the summary. Usually an unmapped form
 *                 or a property missing in the destination.
 * ============================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Requested lists
// ---------------------------------------------------------------------------

/**
 * Matched against the source portal by EXACT name — never a partial or
 * case-insensitive match, so a similarly named list is never picked up by
 * accident. Names containing "|", "#", "(", ")", "-" and "." are used
 * verbatim; nothing here is sanitised.
 *
 * All 22 were confirmed to resolve to exactly one source list. Source ids and
 * types at the time of writing, for orientation only — matching is by name,
 * so these do not need maintaining:
 *   DYNAMIC (active): 532, 751, 685, 684, 672, 683, 682, 678, 666, 654, 646,
 *                     624, 623, 566, 531
 *   MANUAL (static):  872, 828, 779, 681, 648, 559, 557
 *
 * "ToutchMath" is a typo in the source list names. It is preserved, because
 * the naming rule is to add the prefix and change nothing else.
 */
const REQUESTED_LISTS = [
  'TouchMath Customer List 09.08.26',
  'CON_KY_2026.07_KASA_CY26-Attendees',
  'CON_TX_2026.06_TEPSA_CY26 - Attendees - TouchMath',
  'In US with State Information',
  'FOC Webinar Registrants 5.19.26',
  'Webinar | ToutchMath 3-5 | 95PG Database Registrants - Handraiser *NET NEW Contact/Lead',
  'Webinar | ToutchMath 3-5 | 95PG Database Registrants - Handraiser',
  'Webinar | TouchMath 3-5 | 5.7.26 - Handraisers',
  'Webinar | ToutchMath 3-5 | 95PG Database Registrants - Attended Live *NET NEW Contact/Lead',
  'Webinar | ToutchMath 3-5 | 95PG Database Registrants - Attended Live',
  'Webinar | TouchMath 3-5 | 95PG Database Registrants',
  'Webinar | TouchMath 3-5 | 95PG Database Email Registrants - Net New Leads',
  'Webinar | TouchMath 3-5 | 5.7.26 - Live Attendees',
  'Submissions | Grades 3-5 Sample',
  'CON_OR_2026.04_ORRTII_CY26 - Attendee',
  '# Downloads | Dyscalculia Toolkit',
  '(Sales Version) Webinar | TouchMath 3-5 | 5.7.26 - Registrants',
  'Webinar | TouchMath 3-5 | 5.7.26 - Registrants',
  'Submissions | Dyscalculia Toolkit',
  'EdWeek Registrants 3.3.26 - Bridging the Math Gap',
  'TouchMath Customer List 2.24.26',
  'Active List (Contacts who have opened emails or submitted forms)',
];

const NAME_PREFIX = 'Touchmath | ';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const LISTS_PATH = '/crm/v3/lists';

let CONFIG;

function loadConfiguration() {
  const sourceToken = process.env.SOURCE_HUBSPOT_ACCESS_TOKEN || process.env.SOURCE_HUBSPOT_TOKEN;
  const destinationToken = process.env.DESTINATION_HUBSPOT_ACCESS_TOKEN || process.env.DESTINATION_HUBSPOT_TOKEN;

  const config = {
    sourceToken,
    destinationToken,
    prefix: NAME_PREFIX,
    dryRun: String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false',
    allowLossy: String(process.env.ALLOW_LOSSY ?? 'false').toLowerCase() === 'true',
    maxRetries: Number.parseInt(process.env.MAX_RETRIES, 10) || 5,
    retryBaseDelayMs: Number.parseInt(process.env.RETRY_BASE_DELAY_MS, 10) || 1000,
    requestDelayMs: Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 250,
    apiBase: process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com',
    formMapFile: process.env.FORM_MAP_FILE || path.join(process.cwd(), 'active-list-form-map.json'),
    logDirectory: process.env.LOG_DIRECTORY || path.join(process.cwd(), 'logs'),
  };

  const missing = [];
  if (!config.sourceToken) missing.push('SOURCE_HUBSPOT_ACCESS_TOKEN');
  if (!config.destinationToken) missing.push('DESTINATION_HUBSPOT_ACCESS_TOKEN');
  if (missing.length) {
    for (const name of missing) console.error(`ERROR: ${name} is not configured.`);
    return null;
  }
  if (config.sourceToken === config.destinationToken) {
    console.error('ERROR: source and destination tokens are identical. Refusing to run.');
    return null;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let RUN_LOG_PATH = null;

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Levels: INFO SUCCESS WARNING ERROR RETRY DEBUG.
 * `details` is printed as indented key/value lines under the message. Never
 * pass a raw filter value here — use redactFilterBranch()/describeFilters().
 */
function log(level, message, details) {
  const head = `[${timestamp()}] [${level}] ${message}`;
  const lines = [head];
  if (details && typeof details === 'object') {
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined) continue;
      const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
      lines.push(`  ${key}: ${rendered}`);
    }
  }
  const text = lines.join('\n');
  if (level === 'ERROR') console.error(text); else console.log(text);
  if (RUN_LOG_PATH) {
    try {
      fs.appendFileSync(RUN_LOG_PATH, `${text}\n`, 'utf8');
    } catch {
      /* logging must never break the migration */
    }
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    log('WARNING', `Could not parse ${filePath}; continuing without it.`, { reason: err.message });
    return fallback;
  }
}

function writeJsonFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Key-order-independent stringify, so comparison ignores property order. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256Short(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex').slice(0, 12);
}

function buildDestinationName(sourceName) {
  return sourceName.startsWith(NAME_PREFIX) ? sourceName : `${NAME_PREFIX}${sourceName}`;
}

// ---------------------------------------------------------------------------
// PII-safe rendering of filters
// ---------------------------------------------------------------------------

/**
 * Filter values are personal data (contact email addresses, among others), so
 * they never reach a log. Structure, property names and operators are kept,
 * because those are what makes a migration debuggable; concrete values become
 * a count plus a short hash, which is still enough to tell whether source and
 * destination hold the same values.
 */
function redactFilterBranch(branch) {
  if (Array.isArray(branch)) return branch.map(redactFilterBranch);
  if (!branch || typeof branch !== 'object') return branch;
  const out = {};
  for (const [key, value] of Object.entries(branch)) {
    if (key === 'values' && Array.isArray(value)) {
      out.values = `<${value.length} value(s), sha=${sha256Short(value)}>`;
    } else if (key === 'value') {
      out.value = `<redacted, sha=${sha256Short(String(value))}>`;
    } else {
      out[key] = redactFilterBranch(value);
    }
  }
  return out;
}

/** One-line-per-filter description for the log, with no values in it. */
function describeFilters(branch, depth = 0, acc = []) {
  if (!branch) return acc;
  const pad = '  '.repeat(depth);
  const kids = branch.filterBranches || [];
  const filters = branch.filters || [];
  if (filters.length || kids.length) {
    acc.push(`${pad}[${branch.filterBranchType || '?'}/${branch.filterBranchOperator || '?'}] ${filters.length} filter(s), ${kids.length} sub-branch(es)`);
  }
  for (const f of filters) {
    if (f.filterType === 'PROPERTY') {
      const op = f.operation || {};
      const count = Array.isArray(op.values) ? ` (${op.values.length} values)` : '';
      acc.push(`${pad}  - PROPERTY ${f.property} ${op.operator}${count} [${op.operationType || ''}]`);
    } else if (f.filterType === 'IN_LIST') {
      acc.push(`${pad}  - IN_LIST listId=${f.listId} ${f.operator}`);
    } else if (f.filterType === 'FORM_SUBMISSION') {
      acc.push(`${pad}  - FORM_SUBMISSION formId=${f.formId} ${f.operator}`);
    } else {
      acc.push(`${pad}  - ${f.filterType} ${f.operator || ''}`);
    }
  }
  for (const k of kids) describeFilters(k, depth + 1, acc);
  return acc;
}

/** Walks every filter in a branch tree. */
function eachFilter(branch, fn) {
  if (!branch) return;
  for (const f of branch.filters || []) fn(f);
  for (const k of branch.filterBranches || []) eachFilter(k, fn);
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

class HubSpotApiError extends Error {
  constructor(message, { status, body, correlationId, attempts } = {}) {
    super(message);
    this.name = 'HubSpotApiError';
    this.status = status ?? null;
    this.body = body ?? null;
    this.correlationId = correlationId ?? null;
    this.attempts = attempts ?? null;
  }
}

const RETRYABLE_STATUSES = new Set([429, 408, 500, 502, 503, 504]);

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The single entry point for every HubSpot call. Retries 429/408/5xx and
 * network faults with exponential backoff (1s, 2s, 4s, 8s, 16s), honouring
 * Retry-After on a 429. Other 4xx are not retried — they will not succeed on
 * a second attempt. The Authorization header is never logged.
 */
async function apiRequest(token, method, urlPath, { body, context } = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable. Run this script with Node.js 18 or newer.');
  }
  const url = `${CONFIG.apiBase}${urlPath}`;
  const label = `${method} ${urlPath.split('?')[0]}`;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    if (CONFIG.requestDelayMs > 0) await sleep(CONFIG.requestDelayMs);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      if (attempt > CONFIG.maxRetries) {
        throw new HubSpotApiError(`${label} failed after ${CONFIG.maxRetries} retries: ${networkErr.message}`, { attempts: attempt });
      }
      const wait = Math.min(CONFIG.retryBaseDelayMs * 2 ** (attempt - 1), 30000);
      log('RETRY', `${label} | Status: NETWORK_ERROR | Attempt: ${attempt}/${CONFIG.maxRetries} | Waiting: ${wait}ms`, { list: context, error: networkErr.message });
      await sleep(wait);
      continue;
    }

    if (RETRYABLE_STATUSES.has(response.status)) {
      const errBody = await readBody(response);
      if (attempt > CONFIG.maxRetries) {
        throw new HubSpotApiError(`${label} failed after ${CONFIG.maxRetries} retries with status ${response.status}`, {
          status: response.status, body: errBody, correlationId: errBody && errBody.correlationId, attempts: attempt,
        });
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(CONFIG.retryBaseDelayMs * 2 ** (attempt - 1), 30000);
      log('RETRY', `${label} | Status: ${response.status} | Attempt: ${attempt}/${CONFIG.maxRetries} | Waiting: ${wait}ms`, { list: context });
      await sleep(wait);
      continue;
    }

    if (!response.ok) {
      const errBody = await readBody(response);
      throw new HubSpotApiError(`${label} responded with ${response.status}`, {
        status: response.status, body: errBody, correlationId: errBody && errBody.correlationId, attempts: attempt,
      });
    }

    if (response.status === 204) return null;
    return readBody(response);
  }
}

// ---------------------------------------------------------------------------
// List API wrappers
// ---------------------------------------------------------------------------

function unwrapList(response) {
  if (!response) return null;
  return response.list || response.updatedList || response;
}

/** Enumerates every list in a portal via POST /crm/v3/lists/search. */
async function fetchAllLists(token, portalLabel) {
  const all = [];
  let offset = 0;
  for (;;) {
    const page = await apiRequest(token, 'POST', `${LISTS_PATH}/search`, { body: { count: 250, offset } });
    const results = (page && page.lists) || [];
    all.push(...results);
    if (!page || !page.hasMore || results.length === 0) break;
    offset = typeof page.offset === 'number' ? page.offset : offset + results.length;
  }
  log('INFO', `Enumerated ${portalLabel} lists`, { count: all.length });
  return all;
}

async function getListWithFilters(token, listId) {
  const response = await apiRequest(token, 'GET', `${LISTS_PATH}/${listId}?includeFilters=true`, { context: listId });
  return unwrapList(response);
}

/** Exact-name lookup against a pre-fetched index. Never a partial match. */
function findListByExactName(index, name) {
  return index.get(name) || [];
}

function getSourceListByName(sourceIndex, sourceName) {
  const matches = findListByExactName(sourceIndex, sourceName);
  if (matches.length === 0) return { status: 'not_found' };
  if (matches.length > 1) {
    return { status: 'ambiguous', matches };
  }
  return { status: 'ok', list: matches[0] };
}

async function getSourceListConfiguration(listId) {
  return getListWithFilters(CONFIG.sourceToken, listId);
}

function getDestinationListByName(destIndex, destinationName) {
  // HubSpot soft-deletes lists: a deleted list still answers 200 on
  // GET /crm/v3/lists/{id}, carrying a `deletedAt`. POST /crm/v3/lists/search
  // correctly leaves those out, but filter them here too so a deleted list is
  // never mistaken for a live one and "updated" into a zombie.
  const matches = findListByExactName(destIndex, destinationName).filter((l) => !l.deletedAt);
  if (matches.length === 0) return { status: 'absent' };
  if (matches.length > 1) return { status: 'ambiguous', matches };
  return { status: 'found', list: matches[0] };
}

async function createDestinationList({ name, objectTypeId, processingType, filterBranch }) {
  const body = { name, objectTypeId, processingType };
  // A MANUAL list has no filters; sending an empty branch is rejected.
  if (processingType !== 'MANUAL' && filterBranch) body.filterBranch = filterBranch;
  const response = await apiRequest(CONFIG.destinationToken, 'POST', LISTS_PATH, { body, context: name });
  return unwrapList(response);
}

async function updateDestinationList(listId, filterBranch) {
  const response = await apiRequest(CONFIG.destinationToken, 'PUT', `${LISTS_PATH}/${listId}/update-list-filters`, {
    body: { filterBranch, enrollObjectsInWorkflows: false },
    context: listId,
  });
  return unwrapList(response);
}

// ---------------------------------------------------------------------------
// Configuration comparison
// ---------------------------------------------------------------------------

/**
 * Strips everything HubSpot owns — ids, versions, timestamps, processing
 * status, sizes, audit fields — so only the functional configuration is
 * compared and an unchanged list is not rewritten on every run.
 *
 * Applied recursively, because the same metadata keys appear inside nested
 * filter structures too. `listId` is deliberately NOT stripped from IN_LIST
 * filters: a reference to a different list is a real functional difference,
 * and by comparison time it has already been rewritten to its destination id.
 */
function normalizeFilterBranch(branch) {
  const DROP = new Set(['createdAt', 'updatedAt', 'filtersUpdatedAt', 'listVersion', 'processingStatus', 'createdById', 'updatedById', 'size', 'metaData']);
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        if (DROP.has(key)) continue;
        if (value[key] === null || value[key] === undefined) continue;
        out[key] = walk(value[key]);
      }
      return out;
    }
    return value;
  };
  return walk(branch || {});
}

function compareListConfiguration(expected, actual) {
  const differences = [];
  if (expected.name !== actual.name) differences.push('name');
  if (String(expected.objectTypeId) !== String(actual.objectTypeId)) differences.push('objectTypeId');
  if (expected.processingType !== actual.processingType) differences.push('processingType');

  const a = stableStringify(normalizeFilterBranch(expected.filterBranch));
  const b = stableStringify(normalizeFilterBranch(actual.filterBranch));
  if (a !== b) differences.push('filterBranch');

  return { equivalent: differences.length === 0, differences };
}

// ---------------------------------------------------------------------------
// Cross-portal dependency resolution
// ---------------------------------------------------------------------------

/**
 * Rewrites the portal-specific ids inside a filter tree, and reports anything
 * that cannot be rewritten.
 *
 * Both portals reuse the same numeric/GUID id spaces for unrelated records, so
 * a reference carried across unchanged does not fail loudly — it silently
 * points the destination list at the wrong thing, or at nothing. Every id is
 * therefore translated or refused; none is passed through on hope.
 */
function resolveFilterDependencies(filterBranch, ctx) {
  const blockers = [];
  const notes = [];

  const walk = (branch, inEventBranch = false) => {
    if (!branch || typeof branch !== 'object') return branch;
    const out = { ...branch };
    // A UNIFIED_EVENTS branch scopes its PROPERTY filters to an event schema,
    // not to the contact schema, so those property names must not be checked
    // against contact properties — doing so reports a false blocker on every
    // event-scoped filter. Whether the destination portal can filter that
    // event property is something only HubSpot can answer, and it answers
    // loudly: a 400 UNIFIED_EVENT_PROPERTIES_NOT_FILTERABLE naming the exact
    // property. That is a safe failure, so the write is attempted.
    const insideEvents = inEventBranch || branch.filterBranchType === 'UNIFIED_EVENTS';
    if (Array.isArray(branch.filterBranches)) out.filterBranches = branch.filterBranches.map((b) => walk(b, insideEvents));
    if (Array.isArray(branch.filters)) {
      out.filters = branch.filters.map((filter) => {
        if (filter.filterType === 'IN_LIST') {
          const destId = ctx.listIdMap.get(String(filter.listId));
          if (!destId) {
            blockers.push({
              field: `filter.IN_LIST.listId=${filter.listId}`,
              reason: `References source list ${filter.listId}, which has no known destination equivalent. List ids are not portable between portals — the destination portal uses that same id for an unrelated list.`,
            });
            return filter;
          }
          notes.push(`IN_LIST ${filter.listId} -> ${destId}`);
          return { ...filter, listId: String(destId) };
        }

        if (filter.filterType === 'FORM_SUBMISSION') {
          const mapped = ctx.formIdMap[filter.formId];
          if (mapped) {
            notes.push(`FORM_SUBMISSION ${filter.formId} -> ${mapped}`);
            return { ...filter, formId: mapped };
          }
          if (ctx.destinationFormIds.has(filter.formId)) {
            notes.push(`FORM_SUBMISSION ${filter.formId} exists in destination`);
            return filter;
          }
          blockers.push({
            field: `filter.FORM_SUBMISSION.formId=${filter.formId}`,
            reason: `Form ${filter.formId}${ctx.formNames[filter.formId] ? ` ("${ctx.formNames[filter.formId]}")` : ''} does not exist in the destination portal, and no mapping was supplied in ${path.basename(CONFIG.formMapFile)}. HubSpot accepts a foreign form id without error and builds a list that matches zero contacts, so migrating this filter unchanged would produce a silently empty list.`,
          });
          return filter;
        }

        if (filter.filterType === 'PROPERTY' && !insideEvents && ctx.destinationProperties && !ctx.destinationProperties.has(filter.property)) {
          blockers.push({
            field: `filter.PROPERTY.property=${filter.property}`,
            reason: `Property "${filter.property}" does not exist on the destination ${ctx.objectLabel} object, so this filter cannot evaluate the same way.`,
          });
        }
        return filter;
      });
    }
    return out;
  };

  return { filterBranch: walk(filterBranch), blockers, notes };
}

/**
 * HubSpot's create endpoint requires the root filter branch to be OR with at
 * least one nested AND branch (400 ListError.INVALID_BASE_FILTER_BRANCH).
 * Some older source lists have an AND root instead, which the API will happily
 * return but will not accept back.
 *
 * An AND root whose children are all plain AND branches is a pure conjunction:
 * (a AND b) AND (c) is the same set as a AND b AND c. So it can be rewritten
 * as OR -> [ AND(all the filters) ] with identical membership. That rewrite is
 * only applied when it is provably equivalent — the root carries no filters of
 * its own and every child is an AND branch with no nested branches of its own.
 * Anything else (an OR child, a UNIFIED_EVENTS child, deeper nesting) is
 * reported rather than reshaped, because flattening those would change which
 * contacts the list matches.
 */
function normalizeBaseFilterBranch(filterBranch) {
  const blockers = [];
  const notes = [];
  if (!filterBranch || typeof filterBranch !== 'object') return { filterBranch, blockers, notes };
  if (filterBranch.filterBranchType === 'OR') return { filterBranch, blockers, notes };

  const children = filterBranch.filterBranches || [];
  const flattenable = children.every((c) => c.filterBranchType === 'AND'
    && c.filterBranchOperator === 'AND'
    && (c.filterBranches || []).length === 0);

  if (!flattenable) {
    blockers.push({
      field: `filterBranch.root=${filterBranch.filterBranchType}`,
      reason: 'The source list has a non-OR root filter branch that cannot be rewritten without changing which contacts it matches. HubSpot requires an OR root with nested AND branches (ListError.INVALID_BASE_FILTER_BRANCH). Rebuild this list\'s criteria by hand in the destination portal.',
    });
    return { filterBranch, blockers, notes };
  }

  const merged = [...(filterBranch.filters || [])];
  for (const child of children) merged.push(...(child.filters || []));
  notes.push(`root ${filterBranch.filterBranchType} -> OR with one nested AND (${merged.length} filter(s) merged; membership unchanged)`);

  return {
    filterBranch: {
      filterBranchType: 'OR',
      filterBranchOperator: 'OR',
      filters: [],
      filterBranches: [{ filterBranchType: 'AND', filterBranchOperator: 'AND', filters: merged, filterBranches: [] }],
    },
    blockers,
    notes,
  };
}

/**
 * A time-ranged filter pins its boundaries to a timezone. The destination
 * portal only accepts its OWN portal timezone or UTC and rejects anything else
 * outright (400 ListError.INVALID_TIME_ZONE), so a source list built against a
 * third timezone cannot be stored verbatim.
 *
 * Rather than drop the list, the zone is remapped to the destination portal's
 * timezone — the closest equivalent to "the portal's local time" — and the
 * substitution is reported, because it does shift the boundary of a date
 * window by the offset between the two zones.
 */
function remapTimezones(filterBranch, allowedZones, fallbackZone) {
  const notes = [];
  if (!fallbackZone) return { filterBranch, notes };
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'zoneId' && typeof inner === 'string' && !allowedZones.has(inner)) {
          out.zoneId = fallbackZone;
          notes.push(`zoneId ${inner} -> ${fallbackZone}`);
        } else {
          out[key] = walk(inner);
        }
      }
      return out;
    }
    return value;
  };
  return { filterBranch: walk(filterBranch), notes: [...new Set(notes)] };
}

/** Which requested lists must be migrated before which others (IN_LIST). */
function orderByDependencies(entries) {
  const bySourceId = new Map(entries.map((e) => [String(e.sourceList.listId), e]));
  const ordered = [];
  const state = new Map(); // id -> 'visiting' | 'done'

  const visit = (entry) => {
    const id = String(entry.sourceList.listId);
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') return; // cycle: leave order as-is
    state.set(id, 'visiting');
    const deps = [];
    eachFilter(entry.sourceConfig.filterBranch, (f) => {
      if (f.filterType === 'IN_LIST' && bySourceId.has(String(f.listId))) deps.push(String(f.listId));
    });
    for (const dep of deps) if (dep !== id) visit(bySourceId.get(dep));
    state.set(id, 'done');
    ordered.push(entry);
  };

  for (const entry of entries) visit(entry);
  return ordered;
}

// ---------------------------------------------------------------------------
// Per-list migration
// ---------------------------------------------------------------------------

async function migrateList(entry, ctx, result) {
  const { sourceList, sourceConfig } = entry;
  const sourceId = String(sourceList.listId);
  const destinationName = buildDestinationName(sourceConfig.name);
  result.sourceId = sourceId;
  result.destinationName = destinationName;

  log('INFO', 'Source list found', {
    Name: sourceConfig.name,
    ID: sourceId,
    Type: sourceConfig.processingType === 'DYNAMIC' ? 'ACTIVE (DYNAMIC)' : sourceConfig.processingType,
    ObjectType: sourceConfig.objectTypeId,
    Size: sourceConfig.size,
  });
  const described = describeFilters(sourceConfig.filterBranch);
  if (described.length) log('DEBUG', 'Filter configuration being migrated (values redacted)', { filters: `\n${described.join('\n')}` });

  // --- unsupported / unmigratable configuration ------------------------
  if (sourceConfig.processingType === 'MANUAL') {
    log('WARNING', 'Source list contains configuration that is not supported by the destination API.', {
      List: sourceConfig.name,
      Field: 'membership (processingType=MANUAL)',
      Reason: 'A MANUAL (static) list stores an explicit set of records rather than filters. Record ids are not portable between portals, so the destination list is created EMPTY and its members must be added separately.',
    });
    result.partialReasons.push('MANUAL list: membership not migrated (destination list is empty).');
  }

  // Reshape the root branch and remap timezones before resolving references,
  // so the blocker report covers everything in one pass.
  const based = normalizeBaseFilterBranch(sourceConfig.filterBranch);
  const zoned = remapTimezones(based.filterBranch, ctx.allowedTimezones, ctx.fallbackTimezone);
  for (const note of [...based.notes, ...zoned.notes]) log('INFO', `Adjusted filter for destination portal: ${note}`, { List: sourceConfig.name });
  for (const note of zoned.notes) {
    result.partialReasons.push(`Timezone remapped (${note}): the destination portal accepts only ${[...ctx.allowedTimezones].join(' or ')}, so date-window boundaries shift by the offset between the two zones.`);
  }

  const resolved = resolveFilterDependencies(zoned.filterBranch, ctx);
  resolved.blockers.push(...based.blockers);
  for (const blocker of resolved.blockers) {
    log('WARNING', 'Source list contains configuration that is not supported by the destination API.', {
      List: sourceConfig.name, Field: blocker.field, Reason: blocker.reason,
    });
    result.partialReasons.push(`${blocker.field}: ${blocker.reason}`);
  }
  for (const note of resolved.notes) log('INFO', `Rewrote cross-portal reference: ${note}`);

  const blocked = resolved.blockers.length > 0;
  if (blocked && !CONFIG.allowLossy) {
    result.action = 'skipped';
    result.status = 'partial';
    log('ERROR', 'Skipping write: the destination list would not behave like the source.', {
      'Source List': sourceConfig.name,
      'Source ID': sourceId,
      'Destination Name': destinationName,
      Blockers: resolved.blockers.length,
      Hint: `Map the references (see ${path.basename(CONFIG.formMapFile)}) and re-run, or set ALLOW_LOSSY=true to create it anyway.`,
    });
    return;
  }
  if (blocked && CONFIG.allowLossy) {
    log('WARNING', 'ALLOW_LOSSY=true — writing this list despite unresolved references. It will not behave like the source.', { List: sourceConfig.name });
  }

  // --- locate the destination list -------------------------------------
  log('INFO', 'Checking destination list...', { Name: destinationName });
  const found = getDestinationListByName(ctx.destinationIndex, destinationName);

  if (found.status === 'ambiguous') {
    result.action = 'skipped';
    result.status = 'failed';
    result.error = `${found.matches.length} destination lists are named exactly "${destinationName}" (ids ${found.matches.map((l) => l.listId).join(', ')}).`;
    log('ERROR', 'Ambiguous destination list; refusing to guess.', { 'Destination Name': destinationName, IDs: found.matches.map((l) => l.listId).join(', ') });
    return;
  }

  const expected = {
    name: destinationName,
    objectTypeId: sourceConfig.objectTypeId,
    processingType: sourceConfig.processingType,
    filterBranch: resolved.filterBranch,
  };

  // --- create ----------------------------------------------------------
  if (found.status === 'absent') {
    log('INFO', 'Destination list does not exist');
    if (CONFIG.dryRun) {
      log('INFO', `[DRY-RUN] Would create:\n${destinationName}`);
      result.action = 'created';
      result.status = 'dry_run';
      // Record a placeholder id so that a list which IN_LIST-references this
      // one resolves during the preview too. Without it the dry run reports
      // every dependent as unresolvable, which a real run would not do,
      // because there the dependency is created first and gets a real id.
      ctx.listIdMap.set(sourceId, `dry-run:${sourceId}`);
      return;
    }
    log('INFO', 'Creating destination list...');
    const created = await createDestinationList(expected);
    result.destinationId = String(created.listId);
    result.action = 'created';
    log('SUCCESS', 'Destination list created', { ID: result.destinationId, Name: created.name, Type: created.processingType });
    ctx.registerDestination(created);
    ctx.listIdMap.set(sourceId, result.destinationId);
    await validateMigration(expected, result);
    return;
  }

  // --- already there: compare, then update only if needed ---------------
  const existing = found.list;
  result.destinationId = String(existing.listId);
  ctx.listIdMap.set(sourceId, result.destinationId);
  log('INFO', 'Destination list already exists', { ID: result.destinationId, Type: existing.processingType });

  if (existing.processingType !== sourceConfig.processingType) {
    result.action = 'skipped';
    result.status = 'failed';
    result.error = `Destination list ${existing.listId} is ${existing.processingType} but the source is ${sourceConfig.processingType}. HubSpot cannot change a list's processingType after creation.`;
    log('ERROR', 'processingType mismatch; refusing to modify.', {
      'Source List': sourceConfig.name, 'Source ID': sourceId,
      'Destination ID': result.destinationId,
      Source: sourceConfig.processingType, Destination: existing.processingType,
      Action: 'Rename or delete the destination list by hand, then re-run to have it recreated with the correct type.',
    });
    return;
  }

  const currentConfig = await getListWithFilters(CONFIG.destinationToken, existing.listId);
  const comparison = compareListConfiguration(expected, currentConfig);

  if (comparison.equivalent) {
    result.action = 'already_synced';
    log('SUCCESS', 'Destination list is already synchronized.', { Name: destinationName, ID: result.destinationId });
    return;
  }

  log('INFO', 'Destination list configuration differs from source.', { Differences: comparison.differences.join(', ') });

  if (CONFIG.dryRun) {
    log('INFO', `[DRY-RUN] Would update:\n${destinationName}`);
    result.action = 'updated';
    result.status = 'dry_run';
    return;
  }

  log('INFO', 'Updating destination list...');
  if (sourceConfig.processingType === 'MANUAL') {
    // A MANUAL list has no filters to push; nothing to update beyond its name,
    // which already matches because that is how it was found.
    result.action = 'already_synced';
    log('SUCCESS', 'Destination list is already synchronized.', { Name: destinationName, Note: 'MANUAL list: only membership could differ, and membership is not migratable.' });
    return;
  }
  await updateDestinationList(existing.listId, resolved.filterBranch);
  result.action = 'updated';
  log('SUCCESS', 'Destination list updated', { ID: result.destinationId, Name: destinationName });
  await validateMigration(expected, result);
}

/**
 * Required post-write step: read the list back from the destination portal and
 * confirm what was actually stored, rather than trusting the write response.
 */
async function validateMigration(expected, result) {
  log('INFO', 'Validating destination list...');
  const saved = await getListWithFilters(CONFIG.destinationToken, result.destinationId);
  if (saved && saved.deletedAt) {
    result.validated = false;
    result.partialReasons.push(`Validation: destination list ${result.destinationId} is soft-deleted (deletedAt ${saved.deletedAt}).`);
    log('ERROR', 'Destination validation failed.\nThe destination list is marked deleted.', { 'Destination ID': result.destinationId, deletedAt: saved.deletedAt });
    return;
  }
  const comparison = compareListConfiguration(expected, saved);
  if (comparison.equivalent) {
    log('SUCCESS', 'Destination configuration matches source.');
    result.validated = true;
    return;
  }
  result.validated = false;
  result.partialReasons.push(`Validation: destination differs after write (${comparison.differences.join(', ')}).`);
  log('ERROR', 'Destination validation failed.\nSource and destination configurations do not match.', {
    'Destination ID': result.destinationId,
    Differences: comparison.differences.join(', '),
    'Expected (redacted)': JSON.stringify(redactFilterBranch(normalizeFilterBranch(expected.filterBranch))).slice(0, 600),
    'Actual (redacted)': JSON.stringify(redactFilterBranch(normalizeFilterBranch(saved.filterBranch))).slice(0, 600),
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function migrateAllLists(ctx) {
  const results = [];

  // --- resolve every requested name against the source portal first -----
  const entries = [];
  for (const sourceName of REQUESTED_LISTS) {
    const result = {
      sourceName,
      sourceId: null,
      destinationName: buildDestinationName(sourceName),
      destinationId: null,
      action: 'skipped',
      status: 'success',
      validated: null,
      partialReasons: [],
      error: null,
    };
    results.push(result);

    const match = getSourceListByName(ctx.sourceIndex, sourceName);
    if (match.status === 'not_found') {
      result.action = 'not_found';
      result.status = 'not_found';
      result.error = `Source list not found: ${sourceName}`;
      log('ERROR', `Source list not found: ${sourceName}`);
      continue;
    }
    if (match.status === 'ambiguous') {
      result.action = 'skipped';
      result.status = 'failed';
      result.error = `${match.matches.length} source lists share the name "${sourceName}" (ids ${match.matches.map((l) => l.listId).join(', ')}).`;
      log('ERROR', 'Ambiguous source list name; refusing to guess.', { Name: sourceName, IDs: match.matches.map((l) => l.listId).join(', ') });
      continue;
    }

    log('INFO', 'Fetching list configuration...', { Name: sourceName, ID: match.list.listId });
    try {
      const sourceConfig = await getSourceListConfiguration(match.list.listId);
      log('SUCCESS', 'Source list configuration retrieved', { ID: match.list.listId, Type: sourceConfig.processingType });
      entries.push({ sourceList: match.list, sourceConfig, result });
    } catch (err) {
      result.status = 'failed';
      result.action = 'failed';
      result.error = err.message;
      logApiError('Failed to read source list configuration', { sourceName, sourceId: match.list.listId }, err);
    }
  }

  // --- pre-seed the id map with destination lists already migrated ------
  for (const entry of entries) {
    const destName = buildDestinationName(entry.sourceConfig.name);
    const found = getDestinationListByName(ctx.destinationIndex, destName);
    if (found.status === 'found') ctx.listIdMap.set(String(entry.sourceList.listId), String(found.list.listId));
  }

  // --- migrate in dependency order --------------------------------------
  const ordered = orderByDependencies(entries);
  if (ordered.length) {
    log('INFO', 'Migration order resolved (IN_LIST dependencies first)', {
      order: ordered.map((e) => e.sourceList.listId).join(' -> '),
    });
  }

  for (const entry of ordered) {
    log('INFO', '--------------------------------------------------');
    try {
      await migrateList(entry, ctx, entry.result);
    } catch (err) {
      entry.result.status = 'failed';
      entry.result.action = 'failed';
      entry.result.error = err.message;
      logApiError('Failed to migrate list', {
        sourceName: entry.sourceConfig.name,
        sourceId: entry.sourceList.listId,
        destinationName: entry.result.destinationName,
      }, err);
      // Deliberately continue with the remaining lists.
    }
  }

  // Anything flagged along the way but still written is a partial success.
  for (const result of results) {
    if (result.status === 'success' && result.partialReasons.length) result.status = 'partial';
  }
  return results;
}

function logApiError(message, where, err) {
  log('ERROR', message, {
    'Source List': where.sourceName ?? 'n/a',
    'Source ID': where.sourceId ?? 'n/a',
    'Destination Name': where.destinationName ?? 'n/a',
    'HTTP Status': err.status ?? 'n/a',
    'API Error': (err.body && err.body.message) || err.message,
    'Correlation ID': err.correlationId ?? 'n/a',
    'Retry Count': err.attempts ?? 'n/a',
    Response: err.body ? JSON.stringify(err.body).slice(0, 800) : 'n/a',
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printMigrationSummary(results) {
  // Categories are keyed on status so they are mutually exclusive and sum to
  // the total. A list can be both "already synchronized" and "partial" (a
  // MANUAL list whose membership cannot come across, for instance); counting
  // it in each bucket would overstate the totals, so status wins and the
  // action is shown in the per-list detail below.
  const by = (fn) => results.filter(fn);
  const dryRun = by((r) => r.status === 'dry_run');
  const failed = by((r) => r.status === 'failed');
  const notFound = by((r) => r.status === 'not_found');
  const partial = by((r) => r.status === 'partial');
  const succeeded = by((r) => r.status === 'success');
  const created = succeeded.filter((r) => r.action === 'created');
  const updated = succeeded.filter((r) => r.action === 'updated');
  const synced = succeeded.filter((r) => r.action === 'already_synced');

  const line = '='.repeat(50);
  const out = [];
  out.push('', line, 'ACTIVE LIST MIGRATION SUMMARY', line, '');
  out.push(`Total requested: ${results.length}`);
  if (CONFIG.dryRun) {
    out.push(`Would create: ${dryRun.filter((r) => r.action === 'created').length}`);
    out.push(`Would update: ${dryRun.filter((r) => r.action === 'updated').length}`);
  } else {
    out.push(`Successfully created: ${created.length}`);
    out.push(`Successfully updated: ${updated.length}`);
  }
  out.push(`Already synchronized: ${synced.length}`);
  out.push(`Partially migrated: ${partial.length}`);
  out.push(`Failed: ${failed.length}`);
  out.push(`Source lists not found: ${notFound.length}`);
  out.push(`  (these categories are exclusive and total ${dryRun.length + succeeded.length + partial.length + failed.length + notFound.length} of ${results.length})`);
  out.push('', line, 'MIGRATION DETAILS', line);

  const section = (title, rows, render) => {
    if (!rows.length) return;
    out.push('', title);
    for (const r of rows) out.push(...render(r));
  };

  section('SUCCESS', [...created, ...updated, ...synced], (r) => [
    `- ${r.sourceName}`,
    `  Source ID: ${r.sourceId}`,
    `  Destination ID: ${r.destinationId}`,
    `  Action: ${r.action}`,
    `  Validated: ${r.validated === null ? 'n/a' : r.validated}`,
  ]);

  section('DRY RUN', dryRun, (r) => [
    `- ${r.sourceName}`,
    `  Would: ${r.action}`,
    `  Destination Name: ${r.destinationName}`,
  ]);

  section('PARTIAL', partial, (r) => [
    `- ${r.sourceName}`,
    `  Source ID: ${r.sourceId}`,
    `  Destination ID: ${r.destinationId ?? 'not written'}`,
    `  Action: ${r.action}`,
    ...r.partialReasons.map((reason) => `  Reason: ${reason}`),
  ]);

  section('FAILED', failed, (r) => [
    `- ${r.sourceName}`,
    `  Source ID: ${r.sourceId ?? 'n/a'}`,
    `  Reason: ${r.error}`,
  ]);

  section('NOT FOUND', notFound, (r) => [
    `- ${r.sourceName}`,
    '  No source list has this exact name. Check for a rename or stray whitespace.',
  ]);

  out.push('', line);
  const text = out.join('\n');
  console.log(text);
  if (RUN_LOG_PATH) {
    try {
      fs.appendFileSync(RUN_LOG_PATH, `${text}\n`, 'utf8');
    } catch { /* ignore */ }
  }
  return { failed: failed.length, partial: partial.length };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  CONFIG = loadConfiguration();
  if (!CONFIG) {
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(CONFIG.logDirectory, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  RUN_LOG_PATH = path.join(CONFIG.logDirectory, `active-list-migration-${runId}.log`);

  log('INFO', 'Starting Active List migration');
  log('INFO', 'Configuration', {
    DRY_RUN: CONFIG.dryRun,
    ALLOW_LOSSY: CONFIG.allowLossy,
    Prefix: CONFIG.prefix,
    'Requested lists': REQUESTED_LISTS.length,
    'Max retries': CONFIG.maxRetries,
    'Log file': RUN_LOG_PATH,
  });

  // Seed the form map file so it is obvious it can be edited.
  const formIdMap = readJsonFile(CONFIG.formMapFile, {});
  if (!fs.existsSync(CONFIG.formMapFile)) writeJsonFileAtomic(CONFIG.formMapFile, {});
  if (Object.keys(formIdMap).length) log('INFO', 'Loaded form id map', { entries: Object.keys(formIdMap).length });

  const sourceLists = await fetchAllLists(CONFIG.sourceToken, 'source');
  const destinationLists = await fetchAllLists(CONFIG.destinationToken, 'destination');

  const buildIndex = (lists) => {
    const index = new Map();
    for (const list of lists) {
      const arr = index.get(list.name) || [];
      arr.push(list);
      index.set(list.name, arr);
    }
    return index;
  };
  const destinationIndex = buildIndex(destinationLists);

  // Pre-flight: which destination contact properties exist, and which of the
  // referenced forms exist. Cheaper and clearer than discovering it per list.
  const OBJECT_TYPE_PATHS = { '0-1': 'contacts', '0-2': 'companies', '0-3': 'deals' };
  const objectTypeId = '0-1';
  let destinationProperties = null;
  try {
    const props = await apiRequest(CONFIG.destinationToken, 'GET', `/crm/v3/properties/${OBJECT_TYPE_PATHS[objectTypeId]}`);
    destinationProperties = new Set((props.results || []).map((p) => p.name));
    log('INFO', 'Loaded destination properties for pre-flight checks', { count: destinationProperties.size });
  } catch (err) {
    log('WARNING', 'Could not read destination properties; property existence will not be pre-checked.', { reason: err.message });
  }

  // The destination portal's own timezone is the only non-UTC zone its Lists
  // API will store, so discover it rather than hardcoding one.
  let destinationTimezone = null;
  try {
    const details = await apiRequest(CONFIG.destinationToken, 'GET', '/account-info/v3/details');
    destinationTimezone = details && details.timeZone;
    log('INFO', 'Destination portal', { portalId: details && details.portalId, timeZone: destinationTimezone });
  } catch (err) {
    log('WARNING', 'Could not read the destination portal timezone; time-ranged filters will be sent unchanged.', { reason: err.message });
  }
  const fallbackTimezone = process.env.FALLBACK_TIMEZONE || destinationTimezone;
  const allowedTimezones = new Set(['UTC', destinationTimezone, fallbackTimezone].filter(Boolean));

  const ctx = {
    sourceIndex: buildIndex(sourceLists),
    destinationIndex,
    allowedTimezones,
    fallbackTimezone,
    listIdMap: new Map(),
    formIdMap,
    destinationFormIds: new Set(),
    formNames: {},
    destinationProperties,
    objectLabel: OBJECT_TYPE_PATHS[objectTypeId] || objectTypeId,
    registerDestination: (list) => {
      const arr = destinationIndex.get(list.name) || [];
      arr.push(list);
      destinationIndex.set(list.name, arr);
    },
  };

  // Collect the form ids the requested lists actually reference, then check
  // each one once against both portals.
  const referencedForms = new Set();
  for (const sourceName of REQUESTED_LISTS) {
    const match = getSourceListByName(ctx.sourceIndex, sourceName);
    if (match.status !== 'ok') continue;
    try {
      const cfg = await getListWithFilters(CONFIG.sourceToken, match.list.listId);
      eachFilter(cfg.filterBranch, (f) => {
        if (f.filterType === 'FORM_SUBMISSION' && f.formId) referencedForms.add(f.formId);
      });
    } catch { /* reported later, during the real pass */ }
  }
  for (const formId of referencedForms) {
    const target = ctx.formIdMap[formId] || formId;
    try {
      await apiRequest(CONFIG.destinationToken, 'GET', `/marketing/v3/forms/${target}`);
      ctx.destinationFormIds.add(formId);
      if (ctx.formIdMap[formId]) ctx.destinationFormIds.add(target);
    } catch (err) {
      if (!(err instanceof HubSpotApiError) || err.status !== 404) {
        log('WARNING', 'Could not verify a referenced form in the destination portal.', { formId: target, reason: err.message });
      }
    }
    try {
      const srcForm = await apiRequest(CONFIG.sourceToken, 'GET', `/marketing/v3/forms/${formId}`);
      if (srcForm && srcForm.name) ctx.formNames[formId] = srcForm.name;
    } catch { /* name is a nicety for the log */ }
  }
  if (referencedForms.size) {
    log('INFO', 'Form references pre-flight', {
      referenced: referencedForms.size,
      resolvableInDestination: ctx.destinationFormIds.size,
      unresolved: [...referencedForms].filter((f) => !ctx.destinationFormIds.has(f)).join(', ') || 'none',
    });
  }

  const results = await migrateAllLists(ctx);
  const { failed } = printMigrationSummary(results);

  writeJsonFileAtomic(path.join(CONFIG.logDirectory, `active-list-migration-${runId}.json`), {
    startedAt: runId, dryRun: CONFIG.dryRun, results,
  });

  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    log('ERROR', 'Unexpected error; migration aborted.', { message: err.message, stack: err.stack });
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  loadConfiguration,
  apiRequest,
  getSourceListByName,
  getSourceListConfiguration,
  getDestinationListByName,
  createDestinationList,
  updateDestinationList,
  compareListConfiguration,
  normalizeFilterBranch,
  normalizeBaseFilterBranch,
  remapTimezones,
  resolveFilterDependencies,
  orderByDependencies,
  migrateList,
  migrateAllLists,
  printMigrationSummary,
  buildDestinationName,
  redactFilterBranch,
  describeFilters,
  sleep,
  log,
};
