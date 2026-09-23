#!/usr/bin/env node

/**
 * HubSpot Marketing Email Migration Script
 * =========================================
 *
 * Migrates ONLY the 99 marketing emails named in REQUESTED_EMAIL_NAMES below,
 * from a SOURCE HubSpot portal to a DESTINATION HubSpot portal, using the
 * current Marketing Emails v3 API (`/marketing/v3/emails` — GET list,
 * GET /{id}, POST create, PATCH /{id} update). The old `/marketing-emails/v1/`
 * API is retired and is never used here.
 *
 * Confirmed from current HubSpot documentation before writing this script
 * (see the delivery notes for links):
 *   - Base path: /marketing/v3/emails (list/get/create), PATCH /{id} (update).
 *   - folderIdV2 is the current, writable folder field. The old `folderId`
 *     field is being removed; only folderIdV2 is used here.
 *   - Marketing Email objects do NOT support arbitrary custom properties.
 *     Duplicate prevention therefore uses a local JSON mapping file
 *     (marketing-email-migration-map.json), never a fabricated custom
 *     property such as "source_marketing_email_id".
 *   - There is no documented "create folder" endpoint for marketing email
 *     folders — folders can only be created in the HubSpot UI. Folder
 *     mapping is therefore a manually-edited file
 *     (marketing-email-folder-map.json), not auto-created.
 *   - HubSpot's Files API (`POST /files/v3/files/import-from-url/async`) IS
 *     a real, documented endpoint and is used to migrate images/files
 *     referenced inside email HTML content into the destination portal.
 *   - HubSpot's Lists v3 API (`/crm/v3/lists`) IS used to migrate STATIC
 *     (processingType "MANUAL") contact lists referenced by an email.
 *     DYNAMIC/active lists are NOT auto-recreated: their filter criteria
 *     reference source-portal-specific property values and there is no safe,
 *     documented way to translate that automatically — these are flagged for
 *     manual review instead of guessed at.
 *   - CTAs, custom modules, HubDB data, and forms referenced inside an
 *     email's content are DETECTED (via pattern matching on the content
 *     payload) and logged for manual review, but are NOT auto-migrated: no
 *     current, verified HubSpot API reliably recreates these cross-portal
 *     from inside a marketing-email-specific script, and inventing one would
 *     violate the "never guess an endpoint" requirement this script was
 *     built under.
 *
 * SAFETY
 * ------
 *   - This script only READS from the source portal. It never modifies,
 *     archives, sends, or publishes anything in the source portal.
 *   - This script never sends or publishes a destination email, regardless
 *     of the ALLOW_PUBLISH flag (see the ALLOW_PUBLISH section below for why).
 *   - Idempotent: rerunning after a partial/crashed run does not create
 *     duplicates. See "DUPLICATE PREVENTION" below.
 *
 * REQUIRED ENVIRONMENT VARIABLES
 * -------------------------------
 *   SOURCE_HUBSPOT_TOKEN        Private app token for the source portal.
 *   DESTINATION_HUBSPOT_TOKEN   Private app token for the destination portal.
 *
 * Both tokens need the `content` / `marketing-email` scopes; the destination
 * token additionally needs the `crm.lists.write` scope if list dependencies
 * are being auto-created, and the `files` scope if image/file dependencies
 * are being auto-imported.
 *
 * OPTIONAL ENVIRONMENT VARIABLES
 * -------------------------------
 *   DRY_RUN                 "true"/"false". Defaults to true. See DRY RUN below.
 *   ALLOW_PUBLISH            "true"/"false". Defaults to false. See ALLOW_PUBLISH below.
 *   MIGRATE_DEPENDENCIES     "true"/"false". Defaults to true. Set "false" to
 *                            skip auto list-creation / file-import and just
 *                            flag every dependency for manual review instead.
 *   MAX_RETRIES              Defaults to 5.
 *   RETRY_BASE_DELAY_MS      Defaults to 1000.
 *   REQUEST_DELAY_MS         Fixed pacing delay between calls. Defaults to 350.
 *   HUBSPOT_API_BASE         Override API base URL (for testing against a mock server).
 *   MAPPING_FILE              Defaults to ./marketing-email-migration-map.json
 *   DEPENDENCY_MAP_FILE       Defaults to ./marketing-email-dependency-map.json
 *   FOLDER_MAP_FILE           Defaults to ./marketing-email-folder-map.json
 *   LOG_DIRECTORY             Defaults to ./logs
 *
 * USAGE
 * -----
 *   export SOURCE_HUBSPOT_TOKEN="..."
 *   export DESTINATION_HUBSPOT_TOKEN="..."
 *
 *   # 1. Dry run first (default) — reports what WOULD happen, changes nothing:
 *   node migrate-marketing-emails.js
 *
 *   # 2. Real migration:
 *   DRY_RUN=false node migrate-marketing-emails.js
 *
 * DUPLICATE PREVENTION (idempotency)
 * -----------------------------------
 * For every requested email, in this order:
 *   1. marketing-email-migration-map.json: if sourceEmailId has a recorded
 *      destinationEmailId, re-fetch that destination email. If it still
 *      exists, UPDATE it (never create again). If it was deleted in the
 *      destination portal, the stale mapping is discarded and step 2 runs.
 *   2. Destination exact-name match: search destination emails already
 *      fetched for one named exactly `${prefix}${sourceName}`. Exactly one
 *      match -> UPDATE it. Zero matches -> CREATE. More than one match ->
 *      STOP that email and write a manual-review entry (never guess).
 * The mapping file is saved immediately after every create/update (atomic
 * write via temp-file + rename), so a crash mid-run loses no progress and
 * a rerun always picks up where it left off.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';

// This script NEVER calls a publish/send endpoint, regardless of this flag.
// No current HubSpot Marketing Email publish/send endpoint was verified
// against live documentation during development, and "never guess an
// endpoint" + "never send a marketing email" together mean the only safe
// implementation is: this flag exists (per the spec), but the actual publish
// call is intentionally not implemented. If true, a single manual-review
// note is written explaining this so it isn't a silent no-op.
const ALLOW_PUBLISH = String(process.env.ALLOW_PUBLISH ?? 'false').toLowerCase() === 'true';

const CONFIG = {
  sourceToken: process.env.SOURCE_HUBSPOT_TOKEN,
  destinationToken: process.env.DESTINATION_HUBSPOT_TOKEN,
  prefix: 'TouchMath - ',
  dryRun: DRY_RUN,
  allowPublish: ALLOW_PUBLISH,
  migrateDependencies: String(process.env.MIGRATE_DEPENDENCIES ?? 'true').toLowerCase() !== 'false',
  maxRetries: Number.parseInt(process.env.MAX_RETRIES, 10) || 5,
  retryBaseDelayMs: Number.parseInt(process.env.RETRY_BASE_DELAY_MS, 10) || 1000,
  requestDelayMs: Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 350,
  hubspotApiBase: process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com',
  mappingFile: process.env.MAPPING_FILE || path.join(process.cwd(), 'marketing-email-migration-map.json'),
  dependencyMapFile: process.env.DEPENDENCY_MAP_FILE || path.join(process.cwd(), 'marketing-email-dependency-map.json'),
  folderMapFile: process.env.FOLDER_MAP_FILE || path.join(process.cwd(), 'marketing-email-folder-map.json'),
  logDirectory: process.env.LOG_DIRECTORY || path.join(process.cwd(), 'logs'),
};

fs.mkdirSync(CONFIG.logDirectory, { recursive: true });

const RETRY_LOG_PATH = path.join(CONFIG.logDirectory, 'marketing-email-retries.log');
const SUCCESS_LOG_PATH = path.join(CONFIG.logDirectory, 'marketing-email-success.log');
const ERROR_LOG_PATH = path.join(CONFIG.logDirectory, 'marketing-email-errors.log');
const MANUAL_REVIEW_LOG_PATH = path.join(CONFIG.logDirectory, 'marketing-email-manual-review.log');
const SOURCE_SNAPSHOT_PATH = path.join(CONFIG.logDirectory, 'source-marketing-emails-snapshot.json');
const DESTINATION_SNAPSHOT_PATH = path.join(CONFIG.logDirectory, 'destination-marketing-emails-snapshot.json');
const FIELD_COMPARISON_PATH = path.join(CONFIG.logDirectory, 'marketing-email-field-comparison.json');
const SUMMARY_PATH = path.join(CONFIG.logDirectory, 'marketing-email-migration-summary.json');

const MARKETING_EMAILS_PATH = '/marketing/v3/emails';
const LISTS_PATH = '/crm/v3/lists';
const FILES_IMPORT_PATH = '/files/v3/files/import-from-url/async';
const CONTACT_OBJECT_TYPE_ID = '0-1';

// ---------------------------------------------------------------------------
// The 99 marketing emails to migrate — exact (case-sensitive) name match
// only. Nothing else in the source portal is touched.
// ---------------------------------------------------------------------------

const REQUESTED_EMAIL_NAMES = [
  'EM4: Indiana Tier-2 FY26',
  'EM2: Tier-2 Math Survey',
  'EM2: Back to School 2026-2027',
  'EM3: Indiana Tier-2 FY26',
  'EM1: Tier-2 Math Survey',
  'EM2: Indiana Tier-2 FY26',
  'EM1: Indiana Tier-2 FY26',
  'Automated | Indiana | FY26',
  'EM6: Georgia FY26 (TM Database)',
  'EM5: Georgia FY26 (TM Database)',
  'EM5: K-5 FY26 (TM Active List)',
  'EM4: Georgia FY26 (TM Database)',
  'EM3: Georgia FY26 (TM Database)',
  'EM2: Georgia FY26 (TM Database)',
  'EM1: Georgia FY26 (TM Database)',
  'EM1: Back to School 2026-2027',
  'EM4: K-5 FY26 (TM Active List)',
  'EM3: K-5 FY26 (TM Customer List)',
  'EM3: K-5 FY26 (TM Active List)',
  'Automated | TM Georgia Tier 2 | FY26',
  'EM2: K-5 FY26 (TM Active List)',
  'EM2: K-5 FY26 (TM Customer List)',
  'EM1: K-5 FY26 (TM Active List)',
  'EM1: K-5 FY26 (TM Customers)',
  'Monday Must Know - 072726',
  'Automated | TouchMath Program Sampler',
  'EM2: TM Funding Guide FY26',
  'Monday Must Know - 072026',
  'EM1: TM Funding Guide FY26',
  'EM2: Dyscalculia (Phase 2)',
  'Monday Must Know - 071326',
  'EM1: Dyscalculia (Phase 2)',
  'Monday Must Know - 070626',
  'Monday Must Know - 062926',
  'Monday Must Know - 062226',
  'Monday Must Know - 061526',
  'Monday Must Know - 060826',
  'Monday Must Know - 060126',
  'EM1: TouchMath Grades 3-5 OD Webinar (Active Database)',
  'EM1: TouchMath Grades 3-5 OD Webinar (Non Live Attendees)',
  'EM1: TouchMath Grades 3-5 OD Webinar (Live Attendees)',
  'Monday Must Know - 051826',
  'EM3: CASE Webinar',
  'EM6: TouchMath Grades 3-5 Sample Page (Customer List)',
  'EM6: TouchMath Grades 3-5 Sample Page (Active Database)',
  'EM2: CASE Webinar',
  'Monday Must Know - 051126',
  'EM5: TouchMath Grades 3-5 Webinar (Active Database) - LAST CHANCE',
  'EM5: TouchMath Grades 3-5 Webinar (Customer List) - LAST CHANCE',
  'EM1: CASE Webinar',
  'Monday Must Know - 050426',
  'Monday Must Know - 042726',
  'EM4: TouchMath Grades 3-5 Sample Page (Customer List)',
  'EM4: TouchMath Grades 3-5 Sample Page (Active Database)',
  'Newsletter - April 2026 - External',
  'EM3: TouchMath Grades 3-5 Webinar (Active Database)',
  'EM3: TouchMath Grades 3-5 Webinar (Customer List)',
  'Newsletter - April 2026 - Internal',
  'Monday Must Know - 042026',
  'Automated | TouchMath Grades 3-5 Sample Page',
  'EM1: Urban Collaborative Invite 2026',
  'EM2: TouchMath Grades 3-5 Sample Page (Customer List)',
  'EM2: TouchMath Grades 3-5 Sample Page (Active Database)',
  'EM1: TouchMath Grades 3-5 Webinar (Active Database)',
  'EM1: TouchMath Grades 3-5 Webinar (Customer List)',
  'Monday Must Know - 041326',
  'Monday Must Know - 04.06.26',
  'TouchMath Announcement 4.3.26',
  'Monday Must Know - 03.30.26',
  'EM6: Extend 2026',
  'EM5: Dyscalculia',
  'Monday Must Know - 03.23.26',
  'EM5: Extend 2026 (test)',
  'EM5: Extend 2026',
  'EM2: TM Announcement (Active List)',
  'EM2: TM Announcement (Customers)',
  'Monday Must Know - 03.16.26',
  'EM4: Dyscalculia',
  'EM1: TM Announcement (Active List)',
  'EM1: TM Announcement (Customer List)',
  'EM4: Extend 2026',
  'Monday Must Know - 03.09.26',
  'EM3: Dyscalculia',
  'EM1A: Dyscalculia (Webinar follow-up)',
  'EM3: Extend 2026',
  'Monday Must Know - 03.02.26',
  'EM2: Dyscalculia',
  'EM1: Dyscalculia',
  'EM2: Extend 2026',
  'Monday Must Know - 2.23.26',
  'EM1: Extend 2026',
  'Monday Must Know - 2.16.26',
  'Monday Must Know - 2.9.26',
  'Monday Must Know - 2.2.26',
  'Texas - TCASE 2026 - Email 3',
  'Monday Must Know - 1.26.26',
  'Texas - TCASE 2026 - Email 2',
  'Texas - TCASE 2026 - Email 1',
];

/**
 * Explicit, human-decided pins for the two names in REQUESTED_EMAIL_NAMES
 * that matched more than one source email. In both cases the source portal
 * has a stale DRAFT copy sitting alongside the actual PUBLISHED (sent)
 * email, same subject — confirmed by inspecting both source records before
 * adding this. Only the PUBLISHED copy is migrated; the DRAFT duplicate is
 * intentionally left untouched in the source portal and never created in
 * the destination. Any OTHER duplicate name this script encounters (not
 * listed here) still goes to manual review rather than being guessed at.
 */
const DUPLICATE_NAME_OVERRIDES = {
  'EM2: Back to School 2026-2027': '221725071696', // PUBLISHED; skips stale draft 218791042136
  'Newsletter - April 2026 - Internal': '211060039810', // PUBLISHED; skips stale draft 209921507438
};

// Fields HubSpot sets/returns itself; never sent on create/update.
const READ_ONLY_EMAIL_FIELDS = new Set([
  'id', 'createdAt', 'updatedAt', 'publishDate', 'isPublished', 'state',
  'archived', 'stats', 'portalId', 'currentlyPublished', 'abTestOriginalEmailId',
]);

// Fields that could cause the destination email to send/publish. Never sent —
// see the ALLOW_PUBLISH comment above for why this is a hard rule, not a flag.
const SAFETY_OVERRIDE_FIELDS = new Set(['sendOnPublish', 'publishImmediately']);

// Pattern-matched inside stringified email content to flag dependencies this
// script does not attempt to auto-migrate (see file header for why).
const DEPENDENCY_PATTERNS = [
  { type: 'cta', regex: /hs-cta-[a-z0-9-]+|cta_button_id|cta-redirect\.hubspot\.com|hubspotcta[.-]net/gi },
  { type: 'hubdb', regex: /hubdbtable|hubdb\.data|hs_hubdb/gi },
  { type: 'custom_module', regex: /"module_id"\s*:\s*"?\d+/gi },
  { type: 'form', regex: /hs-form-iframe|hbspt\.forms\.create|"formId"\s*:/gi },
];

// URLs inside content that look like HubSpot-hosted images/files — these ARE
// auto-migrated via the Files API (see resolveFileUrl / importFileFromUrlToDestination).
const FILE_URL_REGEX = /https?:\/\/[a-z0-9.-]*(?:hubspotusercontent[a-z0-9.-]*|hubspot\.net|hs-sites\.com)[^\s"'()<>\\]*\.(?:png|jpe?g|gif|svg|webp|pdf|docx?|xlsx?|zip)/gi;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

/** Atomic write: temp file + rename, so a crash mid-write never corrupts the real file. */
function writeJsonFileAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendLine(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${text}\n`, 'utf8');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256Hex(input) {
  const text = typeof input === 'string' ? input : stableStringify(input);
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Keeps log/report files readable — truncates long strings/objects to a hash + length. */
function summarizeForAudit(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 300)}... (${value.length} chars)` : value;
  }
  if (typeof value !== 'object') return value;
  const json = JSON.stringify(value);
  if (json.length > 300) return `${json.slice(0, 300)}... (${json.length} chars, sha256=${sha256Hex(json)})`;
  return value;
}

function buildDestinationName(sourceName) {
  if (typeof sourceName !== 'string') return sourceName;
  return sourceName.startsWith(CONFIG.prefix) ? sourceName : `${CONFIG.prefix}${sourceName}`;
}

function isAuthError(err) {
  return err instanceof HubSpotApiError && (err.status === 401 || err.status === 403);
}

// ---------------------------------------------------------------------------
// Logging (retry / success / error / manual-review)
// ---------------------------------------------------------------------------

function logRetry({ method, endpoint, emailName, sourceEmailId, destinationEmailId, attempt, status, retryAfter, message }) {
  const lines = [
    nowIso(),
    `EMAIL: ${emailName || 'n/a'}`,
    `SOURCE_ID: ${sourceEmailId || 'n/a'}`,
    `DESTINATION_ID: ${destinationEmailId || 'n/a'}`,
    `METHOD: ${method}`,
    `ENDPOINT: ${endpoint}`,
    `ATTEMPT: ${attempt}`,
    `STATUS: ${status}`,
    `RETRY_AFTER: ${retryAfter ?? 'n/a'}`,
    `MESSAGE: ${message}`,
    '---',
  ];
  appendLine(RETRY_LOG_PATH, lines.join('\n'));
}

function logSuccess({ sourceEmailId, sourceEmailName, destinationEmailId, destinationEmailName, action, status, durationMs, validation }) {
  const lines = [
    nowIso(),
    `SOURCE_ID=${sourceEmailId}`,
    `SOURCE_NAME=${sourceEmailName}`,
    `DESTINATION_ID=${destinationEmailId ?? 'n/a'}`,
    `DESTINATION_NAME=${destinationEmailName ?? 'n/a'}`,
    `ACTION=${action}`,
    `STATUS=${status}`,
    `DURATION_MS=${durationMs}`,
    `VALIDATION=${validation}`,
    '---',
  ];
  appendLine(SUCCESS_LOG_PATH, lines.join('\n'));
}

function logError({ phase, sourceEmailId, sourceEmailName, destinationEmailId, destinationEmailName, method, endpoint, httpStatusCode, apiResponse, errorMessage, correlationId, requestPayload, retryAttempts, stack }) {
  const lines = [
    nowIso(),
    `PHASE: ${phase || 'UNKNOWN'}`,
    `SOURCE_ID: ${sourceEmailId ?? 'n/a'}`,
    `SOURCE_NAME: ${sourceEmailName ?? 'n/a'}`,
    `DESTINATION_ID: ${destinationEmailId ?? 'n/a'}`,
    `DESTINATION_NAME: ${destinationEmailName ?? 'n/a'}`,
    `METHOD: ${method ?? 'n/a'}`,
    `ENDPOINT: ${endpoint ?? 'n/a'}`,
    `HTTP_STATUS: ${httpStatusCode ?? 'n/a'}`,
    `CORRELATION_ID: ${correlationId ?? 'n/a'}`,
    `RETRY_ATTEMPTS: ${retryAttempts ?? 'n/a'}`,
    `MESSAGE: ${errorMessage}`,
    `API_RESPONSE: ${apiResponse ? JSON.stringify(summarizeForAudit(apiResponse)) : 'n/a'}`,
    `REQUEST_PAYLOAD: ${requestPayload ? JSON.stringify(summarizeForAudit(requestPayload)) : 'n/a'}`,
    `STACK: ${stack ?? 'n/a'}`,
    '---',
  ];
  appendLine(ERROR_LOG_PATH, lines.join('\n'));
}

function logManualReview({ what, why, sourceEmailId, sourceEmailName, destinationEmailId, destinationEmailName, whatWasAttempted, whatNeedsToBeDone, canRerun }) {
  const lines = [
    nowIso(),
    `WHAT FAILED: ${what}`,
    `WHY IT FAILED: ${why}`,
    `SOURCE EMAIL: ${sourceEmailName ?? 'n/a'}`,
    `SOURCE EMAIL ID: ${sourceEmailId ?? 'n/a'}`,
    `DESTINATION EMAIL: ${destinationEmailName ?? 'n/a'}`,
    `DESTINATION EMAIL ID: ${destinationEmailId ?? 'n/a'}`,
    `WHAT WAS ATTEMPTED: ${whatWasAttempted}`,
    `WHAT NEEDS TO BE DONE MANUALLY: ${whatNeedsToBeDone}`,
    `CAN RERUN AFTER FIXING: ${canRerun ? 'YES' : 'NO'}`,
    '---',
  ];
  appendLine(MANUAL_REVIEW_LOG_PATH, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// HTTP layer — retries 429/408/500/502/503/504 with exponential backoff,
// respects Retry-After, never retries other 4xx.
// ---------------------------------------------------------------------------

class HubSpotApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HubSpotApiError';
    this.status = status ?? null;
    this.body = body ?? null;
  }
}

const RETRYABLE_STATUSES = new Set([429, 408, 500, 502, 503, 504]);

async function safeReadBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function throttle() {
  if (CONFIG.requestDelayMs > 0) await sleep(CONFIG.requestDelayMs);
}

async function hubspotRequest(token, label, method, urlPath, jsonBody, meta = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available. Run this script with Node.js 18 or newer.');
  }
  const url = `${CONFIG.hubspotApiBase}${urlPath}`;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    await throttle();

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
      });
    } catch (networkErr) {
      if (attempt > CONFIG.maxRetries) {
        throw new HubSpotApiError(`[${label}] Network error calling ${method} ${urlPath}: ${networkErr.message}`, {});
      }
      const backoffMs = Math.min(CONFIG.retryBaseDelayMs * 2 ** (attempt - 1), 30000);
      logRetry({ method, endpoint: urlPath, emailName: meta.emailName, sourceEmailId: meta.sourceEmailId, destinationEmailId: meta.destinationEmailId, attempt, status: 'NETWORK_ERROR', retryAfter: null, message: networkErr.message });
      console.warn(`[warn][${label}] Network error on ${method} ${urlPath} (attempt ${attempt}), retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
      continue;
    }

    if (RETRYABLE_STATUSES.has(response.status)) {
      const body = await safeReadBody(response);
      const retryAfterHeader = response.headers.get('retry-after');
      if (attempt > CONFIG.maxRetries) {
        throw new HubSpotApiError(`[${label}] ${method} ${urlPath} failed after ${CONFIG.maxRetries} retries with status ${response.status}`, { status: response.status, body });
      }
      const backoffMs = retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))
        ? Number(retryAfterHeader) * 1000
        : Math.min(CONFIG.retryBaseDelayMs * 2 ** (attempt - 1), 30000);
      logRetry({ method, endpoint: urlPath, emailName: meta.emailName, sourceEmailId: meta.sourceEmailId, destinationEmailId: meta.destinationEmailId, attempt, status: response.status, retryAfter: retryAfterHeader, message: (body && body.message) || `HTTP ${response.status}` });
      console.warn(`[warn][${label}] ${response.status} from ${method} ${urlPath} (attempt ${attempt}/${CONFIG.maxRetries}), waiting ${backoffMs}ms`);
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

// ---------------------------------------------------------------------------
// Marketing Email API
// ---------------------------------------------------------------------------

async function listAllMarketingEmails(token, label) {
  const all = [];
  let after;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    const page = await hubspotRequest(token, label, 'GET', `${MARKETING_EMAILS_PATH}?${query.toString()}`);
    const results = (page && Array.isArray(page.results)) ? page.results : [];
    all.push(...results);
    after = page && page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : undefined;
  } while (after);
  return all;
}

async function getMarketingEmailById(token, label, id, meta = {}) {
  return hubspotRequest(token, label, 'GET', `${MARKETING_EMAILS_PATH}/${id}`, undefined, meta);
}

async function getMarketingEmailByIdSafe(token, label, id, meta = {}) {
  try {
    return await getMarketingEmailById(token, label, id, meta);
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 404) return null;
    throw err;
  }
}

async function createMarketingEmail(token, label, body, meta = {}) {
  return hubspotRequest(token, label, 'POST', MARKETING_EMAILS_PATH, body, meta);
}

async function updateMarketingEmail(token, label, id, body, meta = {}) {
  return hubspotRequest(token, label, 'PATCH', `${MARKETING_EMAILS_PATH}/${id}`, body, meta);
}

async function fetchPortalId(token, label) {
  try {
    const details = await hubspotRequest(token, label, 'GET', '/account-info/v3/details');
    return details ? details.portalId : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lists v3 API — used only for STATIC (processingType "MANUAL") list
// dependencies. DYNAMIC/active lists are never auto-created (see file header).
// ---------------------------------------------------------------------------

function unwrapList(resp) {
  return resp && resp.list ? resp.list : resp;
}

function getListId(list) {
  return String(list.listId ?? list.id);
}

async function getListByIdSafe(token, label, id) {
  try {
    const resp = await hubspotRequest(token, label, 'GET', `${LISTS_PATH}/${id}`);
    return unwrapList(resp);
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 404) return null;
    throw err;
  }
}

async function createStaticList(destToken, name) {
  const resp = await hubspotRequest(destToken, 'lists-dest', 'POST', LISTS_PATH, {
    name,
    objectTypeId: CONTACT_OBJECT_TYPE_ID,
    processingType: 'MANUAL',
  });
  return unwrapList(resp);
}

/**
 * Enumerates every destination list once (used for name-based dependency
 * matching). Only follows the documented paging.next.after cursor; if the
 * response ever indicates more pages through an unrecognized shape, this
 * stops rather than guessing an undocumented pagination parameter, and the
 * caller is told coverage may be incomplete.
 */
async function fetchAllDestinationLists(destToken) {
  const all = [];
  let after;
  let possiblyIncomplete = false;
  try {
    do {
      const query = new URLSearchParams({ limit: '250' });
      if (after) query.set('after', after);
      const page = await hubspotRequest(destToken, 'lists-dest', 'GET', `${LISTS_PATH}?${query.toString()}`);
      const results = (page && (page.lists || page.results)) || [];
      all.push(...results);
      const nextAfter = page && page.paging && page.paging.next && page.paging.next.after;
      if (nextAfter) {
        after = nextAfter;
      } else {
        if (page && page.hasMore) possiblyIncomplete = true;
        after = undefined;
      }
    } while (after);
  } catch (err) {
    console.warn(`[warn] Could not enumerate destination lists (${err.message}). List-name dependency matching is disabled for this run; unmatched list references will be logged for manual review instead of guessed at.`);
    return null;
  }
  if (possiblyIncomplete) {
    console.warn('[warn] Destination lists response indicated more results exist but used an unrecognized pagination shape; list coverage may be incomplete. Verify list dependency matches manually if in doubt.');
  }
  return all;
}

// ---------------------------------------------------------------------------
// Files v3 API — imports images/files referenced in email content into the
// destination portal's file manager (POST .../import-from-url/async, then
// poll the task status endpoint until COMPLETE).
// ---------------------------------------------------------------------------

/** Derives a "Touchmath - <original filename>" display name from the source URL. */
function buildDependencyFileName(sourceUrl) {
  try {
    const base = decodeURIComponent(new URL(sourceUrl).pathname.split('/').pop() || 'file');
    return buildDestinationName(base);
  } catch {
    return buildDestinationName('imported-file');
  }
}

async function importFileFromUrlToDestination(destToken, sourceUrl) {
  const createResp = await hubspotRequest(destToken, 'files-dest', 'POST', FILES_IMPORT_PATH, {
    url: sourceUrl,
    name: buildDependencyFileName(sourceUrl),
    access: 'PUBLIC_INDEXABLE',
    duplicateValidationStrategy: 'NONE',
  });
  const taskId = createResp && createResp.id;
  if (!taskId) throw new Error('Import-from-url did not return a task id');

  const deadline = Date.now() + 120000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for file import task ${taskId} to complete`);
    await sleep(2000);
    const statusResp = await hubspotRequest(destToken, 'files-dest', 'GET', `${FILES_IMPORT_PATH}/tasks/${taskId}/status`);
    const status = statusResp && statusResp.status;
    if (status === 'COMPLETE') {
      const file = (statusResp && (statusResp.result || statusResp.file)) || statusResp;
      if (!file || !file.url) throw new Error(`File import task ${taskId} completed but no file URL was returned`);
      return { id: file.id, url: file.url };
    }
    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(`File import task ${taskId} failed: ${JSON.stringify(statusResp)}`);
    }
    // PENDING / PROCESSING — keep polling.
  }
}

function extractFileUrls(content) {
  const text = JSON.stringify(content || {});
  const matches = text.match(FILE_URL_REGEX) || [];
  return [...new Set(matches)];
}

function detectUnmigratableContentReferences(content) {
  const text = JSON.stringify(content || {});
  const found = [];
  for (const { type, regex } of DEPENDENCY_PATTERNS) {
    const matches = text.match(regex);
    if (matches && matches.length) found.push({ type, count: matches.length, sample: [...new Set(matches)].slice(0, 3) });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Migration map / dependency map / folder map — persistent state files
// ---------------------------------------------------------------------------

function loadMigrationMap() {
  const fallback = { sourcePortal: null, destinationPortal: null, emails: {} };
  const data = readJsonFile(CONFIG.mappingFile, fallback);
  data.emails = data.emails || {};
  return data;
}

function saveMigrationMap(state) {
  writeJsonFileAtomic(CONFIG.mappingFile, state);
}

function loadDependencyMap() {
  const fallback = { lists: {}, files: {} };
  const data = readJsonFile(CONFIG.dependencyMapFile, fallback);
  data.lists = data.lists || {};
  data.files = data.files || {};
  return data;
}

function saveDependencyMap(state) {
  writeJsonFileAtomic(CONFIG.dependencyMapFile, state);
}

function loadFolderMap() {
  const fallback = { folders: {} };
  const data = readJsonFile(CONFIG.folderMapFile, fallback);
  data.folders = data.folders || {};
  if (!fs.existsSync(CONFIG.folderMapFile)) {
    // Seed an editable, empty file — folder creation has no API, so mapping
    // "sourceFolderId": "destinationFolderId" here is the only way to set it.
    writeJsonFileAtomic(CONFIG.folderMapFile, data);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

function resolveFolder(sourceFolderId, folderMap) {
  if (!sourceFolderId) return { status: 'none' };
  const destId = folderMap.folders[String(sourceFolderId)];
  if (destId) return { status: 'mapped', destinationFolderId: destId };
  return {
    status: 'unmapped',
    reason: `No entry for source folder ${sourceFolderId} in ${CONFIG.folderMapFile}. HubSpot's Marketing Email API has no documented folder-create endpoint, so this must be mapped by hand: create/find the equivalent folder in the destination portal UI, then add "${sourceFolderId}": "<destinationFolderId>" to that file and rerun.`,
  };
}

async function resolveListReference(sourceListId, ctx) {
  const key = String(sourceListId);
  const existing = ctx.dependencyMap.lists[key];
  if (existing && existing.destinationListId) {
    const stillExists = await getListByIdSafe(ctx.destToken, 'lists-dest', existing.destinationListId);
    if (stillExists) return { status: 'mapped', destinationListId: existing.destinationListId, sourceListName: existing.sourceListName };
    delete ctx.dependencyMap.lists[key];
  }

  let sourceList;
  try {
    sourceList = await getListByIdSafe(ctx.sourceToken, 'lists-source', sourceListId);
  } catch (err) {
    return { status: 'error', reason: `Could not read source list ${sourceListId}: ${err.message}` };
  }
  if (!sourceList) {
    return { status: 'error', reason: `Source list ${sourceListId} no longer exists in the source portal.` };
  }
  const listName = sourceList.name;
  const processingType = sourceList.processingType;
  // Auto-created dependencies get the same "Touchmath - " prefix as the
  // primary migrated records, so they're identifiable in the destination
  // portal and so a rerun's name-match lookup stays consistent with what
  // was actually created (not the unprefixed source name).
  const destinationListName = buildDestinationName(listName);

  if (ctx.destListsByName) {
    const candidates = ctx.destListsByName.get(destinationListName) || [];
    if (candidates.length === 1) {
      const destId = getListId(candidates[0]);
      ctx.dependencyMap.lists[key] = { sourceListId: key, sourceListName: listName, destinationListName, destinationListId: destId, resolvedVia: 'name-match', resolvedAt: nowIso() };
      return { status: 'mapped', destinationListId: destId, sourceListName: listName };
    }
    if (candidates.length > 1) {
      return { status: 'ambiguous', reason: `${candidates.length} destination lists are already named exactly "${destinationListName}"; cannot safely pick one.`, sourceListName: listName };
    }
  }

  if (processingType !== 'MANUAL') {
    return {
      status: 'unmigratable_dynamic',
      reason: `Source list "${listName}" (id ${sourceListId}) is a DYNAMIC/active list (processingType=${processingType}). Its filter criteria reference source-portal-specific property values/ids and cannot be safely reproduced automatically.`,
      sourceListName: listName,
    };
  }

  if (ctx.dryRun) return { status: 'dry_run_would_create', sourceListName: listName, destinationListName };

  try {
    const created = await createStaticList(ctx.destToken, destinationListName);
    const destId = getListId(created);
    ctx.dependencyMap.lists[key] = { sourceListId: key, sourceListName: listName, destinationListName, destinationListId: destId, resolvedVia: 'created', resolvedAt: nowIso() };
    saveDependencyMap(ctx.dependencyMap);
    return { status: 'created', destinationListId: destId, sourceListName: listName };
  } catch (err) {
    return { status: 'error', reason: `Failed to create destination static list "${destinationListName}": ${err.message}`, sourceListName: listName };
  }
}

async function resolveFileUrl(url, ctx) {
  const existing = ctx.dependencyMap.files[url];
  if (existing && existing.destinationUrl) return { status: 'mapped', destinationUrl: existing.destinationUrl };
  if (ctx.dryRun) return { status: 'dry_run_would_import' };
  try {
    const imported = await importFileFromUrlToDestination(ctx.destToken, url);
    ctx.dependencyMap.files[url] = { sourceUrl: url, destinationFileId: String(imported.id), destinationUrl: imported.url, importedAt: nowIso() };
    saveDependencyMap(ctx.dependencyMap);
    return { status: 'imported', destinationUrl: imported.url };
  } catch (err) {
    return { status: 'error', reason: err.message };
  }
}

async function resolveContactIlsLists(value, ctx) {
  const issues = [];
  if (value === null || value === undefined) return { body: value, allResolved: true, issues };

  const resolveIdList = async (ids) => {
    const resolved = [];
    for (const id of ids || []) {
      const result = await resolveListReference(id, ctx);
      if (result.status === 'mapped' || result.status === 'created') {
        const numeric = Number(result.destinationListId);
        resolved.push(Number.isFinite(numeric) ? numeric : result.destinationListId);
      } else if (result.status === 'dry_run_would_create') {
        issues.push({ kind: 'list', sourceId: id, status: 'DRY_RUN', sourceListName: result.sourceListName, reason: `[DRY RUN] Would create a new static list "${result.destinationListName || buildDestinationName(result.sourceListName)}" in the destination portal.` });
      } else {
        issues.push({ kind: 'list', sourceId: id, status: result.status, sourceListName: result.sourceListName, reason: result.reason || 'Could not resolve a destination list for this reference.' });
      }
    }
    return resolved;
  };

  if (Array.isArray(value)) {
    const resolved = await resolveIdList(value);
    return { body: resolved, allResolved: resolved.length === value.length, issues };
  }
  if (typeof value === 'object' && (Array.isArray(value.include) || Array.isArray(value.exclude))) {
    const include = await resolveIdList(value.include || []);
    const exclude = await resolveIdList(value.exclude || []);
    const allResolved = include.length === (value.include || []).length && exclude.length === (value.exclude || []).length;
    return { body: { ...value, include, exclude }, allResolved, issues };
  }

  issues.push({ kind: 'list', status: 'UNRECOGNIZED_SHAPE', reason: 'contactIlsLists had an unexpected shape for this script to interpret; omitted from the destination payload rather than risk sending invalid source-portal list IDs.' });
  return { body: undefined, allResolved: false, issues };
}

async function resolveContentDependencies(content, ctx) {
  const issues = [];
  const fileUrls = extractFileUrls(content);
  const unmigratable = detectUnmigratableContentReferences(content);
  let text = JSON.stringify(content);
  let resolvedCount = 0;

  for (const url of fileUrls) {
    const result = await resolveFileUrl(url, ctx);
    if (result.status === 'mapped' || result.status === 'imported') {
      text = text.split(url).join(result.destinationUrl);
      resolvedCount += 1;
    } else if (result.status === 'dry_run_would_import') {
      issues.push({ kind: 'file', sourceUrl: url, status: 'DRY_RUN', reason: '[DRY RUN] Would import this file/image into the destination portal file manager and rewrite the reference.' });
    } else {
      issues.push({ kind: 'file', sourceUrl: url, status: result.status, reason: result.reason || 'Could not import this file into the destination portal; the source-portal URL was left as-is and will likely not display correctly.' });
    }
  }

  for (const ref of unmigratable) {
    issues.push({
      kind: ref.type,
      status: 'MANUAL_REVIEW',
      reason: `Detected ${ref.count} reference(s) that look like a "${ref.type}" dependency (sample: ${ref.sample.join(', ')}). This script does not auto-migrate CTAs, HubDB data, custom modules, or embedded forms — there is no verified, documented HubSpot API for reliably recreating these cross-portal from a marketing-email-specific script. Recreate/verify manually in the destination portal.`,
    });
  }

  let newContent;
  try {
    newContent = JSON.parse(text);
  } catch {
    newContent = content;
    issues.push({ kind: 'content', status: 'ERROR', reason: 'File URL substitution produced invalid JSON; original content left untouched. Investigate the matched file URLs manually.' });
  }

  return { content: newContent, allResolved: fileUrls.length === resolvedCount && unmigratable.length === 0, unresolvedCount: issues.length, issues };
}

// ---------------------------------------------------------------------------
// Payload building (with per-field classification audit) and validation
// ---------------------------------------------------------------------------

async function buildCreatePayload(sourceEmail, ctx) {
  const body = {};
  const fieldAudit = [];
  const dependencyIssues = [];
  const destinationName = buildDestinationName(sourceEmail.name);

  for (const [field, value] of Object.entries(sourceEmail)) {
    if (value === undefined) continue;

    if (READ_ONLY_EMAIL_FIELDS.has(field)) {
      fieldAudit.push({ field, sourceValue: summarizeForAudit(value), classification: 'READ_ONLY' });
      continue;
    }
    if (SAFETY_OVERRIDE_FIELDS.has(field)) {
      fieldAudit.push({ field, sourceValue: summarizeForAudit(value), classification: 'SAFETY_OVERRIDE', note: 'Never sent — this script never sends or publishes destination emails.' });
      continue;
    }
    if (field === 'name') {
      body.name = destinationName;
      fieldAudit.push({ field, sourceValue: value, destinationValue: destinationName, classification: 'DIRECT_WITH_PREFIX' });
      continue;
    }
    if (field === 'folderIdV2') {
      const resolved = resolveFolder(value, ctx.folderMap);
      if (resolved.status === 'mapped') {
        body.folderIdV2 = resolved.destinationFolderId;
        fieldAudit.push({ field, sourceValue: value, destinationValue: resolved.destinationFolderId, classification: 'PORTAL_SPECIFIC_MAPPED' });
      } else if (resolved.status === 'unmapped') {
        fieldAudit.push({ field, sourceValue: value, classification: 'PORTAL_SPECIFIC_UNMAPPED', reason: resolved.reason });
        dependencyIssues.push({ kind: 'folder', sourceId: value, status: 'MANUAL_REVIEW', reason: resolved.reason });
      }
      continue;
    }
    if (field === 'contactIlsLists') {
      if (!CONFIG.migrateDependencies) {
        fieldAudit.push({ field, sourceValue: summarizeForAudit(value), classification: 'DEPENDENCY_SKIPPED', reason: 'MIGRATE_DEPENDENCIES=false' });
        dependencyIssues.push({ kind: 'list', status: 'MANUAL_REVIEW', reason: 'Dependency migration is disabled (MIGRATE_DEPENDENCIES=false); list references were not resolved or sent.' });
        continue;
      }
      const resolvedLists = await resolveContactIlsLists(value, ctx);
      if (resolvedLists.body !== undefined) body.contactIlsLists = resolvedLists.body;
      fieldAudit.push({ field, sourceValue: summarizeForAudit(value), destinationValue: summarizeForAudit(resolvedLists.body), classification: resolvedLists.allResolved ? 'DEPENDENCY_MAPPED' : 'DEPENDENCY_PARTIAL' });
      dependencyIssues.push(...resolvedLists.issues);
      continue;
    }
    if (field === 'content') {
      if (!CONFIG.migrateDependencies) {
        body.content = deepClone(value);
        fieldAudit.push({ field, classification: 'DIRECT', note: 'Dependency scanning skipped (MIGRATE_DEPENDENCIES=false); content copied verbatim.' });
        continue;
      }
      const resolvedContent = await resolveContentDependencies(value, ctx);
      body.content = resolvedContent.content;
      fieldAudit.push({ field, classification: resolvedContent.allResolved ? 'DIRECT' : 'DIRECT_WITH_UNRESOLVED_REFERENCES', unresolvedReferenceCount: resolvedContent.unresolvedCount });
      dependencyIssues.push(...resolvedContent.issues);
      continue;
    }

    // Everything else the source API returned is a directly writable field —
    // copy it through untouched rather than hand-picking a "basic" subset.
    body[field] = deepClone(value);
    fieldAudit.push({ field, sourceValue: summarizeForAudit(value), classification: 'DIRECT' });
  }

  return { body, fieldAudit, dependencyIssues, destinationName };
}

function validateMigration(builtBody, destEmail) {
  const fields = {};
  const mismatches = [];

  const compare = (name, sourceVal, destVal) => {
    const match = stableStringify(sourceVal ?? null) === stableStringify(destVal ?? null);
    fields[name] = { source: summarizeForAudit(sourceVal), destination: summarizeForAudit(destVal), match };
    if (!match) mismatches.push(name);
  };

  compare('name', builtBody.name, destEmail.name);
  compare('subject', builtBody.subject, destEmail.subject);
  compare('fromName', builtBody.fromName, destEmail.fromName);
  compare('replyTo', builtBody.replyTo, destEmail.replyTo);
  compare('webversion', builtBody.webversion, destEmail.webversion);
  compare('language', builtBody.language, destEmail.language);
  compare('campaign', builtBody.campaign, destEmail.campaign);
  compare('folderIdV2', builtBody.folderIdV2, destEmail.folderIdV2);

  const sourceHash = sha256Hex(builtBody.content || {});
  const destHash = sha256Hex(destEmail.content || {});
  fields.content = { sourceHash, destinationHash: destHash, match: sourceHash === destHash };
  if (sourceHash !== destHash) mismatches.push('content');

  return { fields, mismatches, overall: mismatches.length === 0 ? 'PASS' : 'FAIL' };
}

// ---------------------------------------------------------------------------
// Per-email migration orchestration
// ---------------------------------------------------------------------------

async function migrateEmail(sourceSummary, ctx) {
  const startedAt = Date.now();
  const sourceId = String(sourceSummary.id);
  const requestedName = sourceSummary.name;
  const meta = { emailName: requestedName, sourceEmailId: sourceId };

  let fullSource;
  try {
    fullSource = await getMarketingEmailById(ctx.sourceToken, 'source', sourceId, meta);
  } catch (err) {
    logError({ phase: 'SOURCE_FETCH', sourceEmailId: sourceId, sourceEmailName: requestedName, method: 'GET', endpoint: `${MARKETING_EMAILS_PATH}/${sourceId}`, httpStatusCode: err.status, apiResponse: err.body, errorMessage: err.message, stack: err.stack });
    return { status: 'FAILED', sourceEmailId: sourceId, sourceEmailName: requestedName, action: 'NONE' };
  }
  ctx.sourceSnapshots[sourceId] = fullSource;

  const expectedDestinationName = buildDestinationName(fullSource.name);
  const mappingEntry = ctx.mappingState.emails[sourceId];

  let existingDestEmail = null;

  if (mappingEntry && mappingEntry.destinationEmailId) {
    try {
      existingDestEmail = await getMarketingEmailByIdSafe(ctx.destToken, 'destination', mappingEntry.destinationEmailId, meta);
    } catch (err) {
      logError({ phase: 'MAPPING', sourceEmailId: sourceId, sourceEmailName: requestedName, destinationEmailId: mappingEntry.destinationEmailId, errorMessage: `Could not verify existing mapped destination email: ${err.message}`, httpStatusCode: err.status, apiResponse: err.body });
    }
    if (!existingDestEmail) {
      console.warn(`[warn] Mapping for "${requestedName}" (source ${sourceId}) points to destination email ${mappingEntry.destinationEmailId}, which no longer exists. Falling back to name match / create.`);
    }
  }

  if (!existingDestEmail) {
    const byName = ctx.destinationNameIndex.get(expectedDestinationName) || [];
    if (byName.length === 1) {
      existingDestEmail = byName[0];
    } else if (byName.length > 1) {
      logManualReview({
        what: 'Ambiguous destination match',
        why: `${byName.length} destination emails are already named exactly "${expectedDestinationName}"; ids: ${byName.map((e) => e.id).join(', ')}.`,
        sourceEmailId: sourceId,
        sourceEmailName: requestedName,
        whatWasAttempted: 'Looked up destination emails by exact expected name to avoid creating a duplicate.',
        whatNeedsToBeDone: `Manually decide which destination email id corresponds to this source email, then add "${sourceId}": {"destinationEmailId": "<the correct id>", ...} to ${CONFIG.mappingFile} (or delete the extra destination email(s)).`,
        canRerun: true,
      });
      return { status: 'MANUAL_REVIEW_REQUIRED', sourceEmailId: sourceId, sourceEmailName: requestedName, action: 'NONE' };
    }
  }

  const buildCtx = { sourceToken: ctx.sourceToken, destToken: ctx.destToken, folderMap: ctx.folderMap, dependencyMap: ctx.dependencyMap, dryRun: ctx.dryRun, destListsByName: ctx.destListsByName };
  const { body, fieldAudit, dependencyIssues, destinationName } = await buildCreatePayload(fullSource, buildCtx);
  const blockingIssues = dependencyIssues.filter((i) => i.status !== 'DRY_RUN');

  if (ctx.dryRun) {
    const action = existingDestEmail ? 'UPDATE' : 'CREATE';
    console.log(`\n[DRY RUN]\nSOURCE:\n${sourceId} - ${requestedName}\n\nACTION:\n${action}\n\nDESTINATION NAME:\n${destinationName}` +
      (dependencyIssues.length ? `\n\nDEPENDENCY NOTES:\n${dependencyIssues.map((i) => `  - [${i.kind}] ${i.reason}`).join('\n')}` : ''));
    logSuccess({ sourceEmailId: sourceId, sourceEmailName: requestedName, destinationEmailId: existingDestEmail ? existingDestEmail.id : null, destinationEmailName: destinationName, action: `DRY_RUN_${action}`, status: 'DRY_RUN', durationMs: Date.now() - startedAt, validation: 'N/A' });
    return { status: 'DRY_RUN', sourceEmailId: sourceId, sourceEmailName: requestedName, action: `DRY_RUN_${action}` };
  }

  let destResult;
  let action;
  try {
    if (existingDestEmail) {
      action = 'UPDATED';
      await updateMarketingEmail(ctx.destToken, 'destination', existingDestEmail.id, body, { ...meta, destinationEmailId: existingDestEmail.id });
      destResult = await getMarketingEmailById(ctx.destToken, 'destination', existingDestEmail.id, meta);
    } else {
      action = 'CREATED';
      destResult = await createMarketingEmail(ctx.destToken, 'destination', body, meta);
    }
  } catch (err) {
    logError({
      phase: action === 'UPDATED' ? 'UPDATE' : 'CREATE',
      sourceEmailId: sourceId, sourceEmailName: requestedName,
      destinationEmailId: existingDestEmail ? existingDestEmail.id : null, destinationEmailName: destinationName,
      method: action === 'UPDATED' ? 'PATCH' : 'POST', endpoint: MARKETING_EMAILS_PATH,
      httpStatusCode: err.status, apiResponse: err.body, errorMessage: err.message, requestPayload: body, stack: err.stack,
    });
    console.error(`[error] Failed to ${action === 'UPDATED' ? 'update' : 'create'} "${requestedName}" (source ${sourceId}): ${err.message}`);
    return { status: 'FAILED', sourceEmailId: sourceId, sourceEmailName: requestedName, action: 'NONE' };
  }

  const destinationId = String(destResult.id);

  // Persist the mapping immediately — before validation — so a crash right
  // after creation still prevents a duplicate on the next run.
  ctx.mappingState.emails[sourceId] = {
    sourceEmailId: sourceId,
    sourceEmailName: fullSource.name,
    sourceEmailType: fullSource.type || null,
    sourceEmailState: fullSource.state || null,
    sourceCreatedAt: fullSource.createdAt || null,
    sourceUpdatedAt: fullSource.updatedAt || null,
    destinationEmailId: destinationId,
    destinationEmailName: destResult.name || destinationName,
    status: 'pending_validation',
    lastMigratedAt: nowIso(),
  };
  saveMigrationMap(ctx.mappingState);
  saveDependencyMap(ctx.dependencyMap);

  let destFull;
  try {
    destFull = await getMarketingEmailById(ctx.destToken, 'destination', destinationId, { ...meta, destinationEmailId: destinationId });
  } catch (err) {
    logError({ phase: 'VALIDATION', sourceEmailId: sourceId, sourceEmailName: requestedName, destinationEmailId: destinationId, errorMessage: `Could not re-fetch destination email for validation: ${err.message}`, httpStatusCode: err.status, apiResponse: err.body });
    ctx.mappingState.emails[sourceId].status = 'FAILED_VALIDATION_FETCH';
    saveMigrationMap(ctx.mappingState);
    return { status: 'FAILED', sourceEmailId: sourceId, sourceEmailName: requestedName, action };
  }

  const comparison = validateMigration(body, destFull);
  const finalStatus = (comparison.overall === 'PASS' && blockingIssues.length === 0) ? 'FULL_SUCCESS' : 'PARTIAL';

  ctx.fieldComparisons.push({
    sourceEmailId: sourceId, destinationEmailId: destinationId,
    sourceName: fullSource.name, destinationName: destFull.name,
    status: finalStatus, action, fields: comparison.fields,
    dependencies: dependencyIssues, fieldAudit,
    missingFields: comparison.mismatches, unsupportedFields: fieldAudit.filter((f) => f.classification === 'PORTAL_SPECIFIC_UNMAPPED' || f.classification === 'DEPENDENCY_SKIPPED').map((f) => f.field),
  });

  ctx.mappingState.emails[sourceId].status = finalStatus;
  ctx.mappingState.emails[sourceId].lastMigratedAt = nowIso();
  saveMigrationMap(ctx.mappingState);
  ctx.destinationSnapshots[destinationId] = destFull;

  if (finalStatus !== 'FULL_SUCCESS') {
    logManualReview({
      what: `Marketing email migrated with unresolved issues (${finalStatus})`,
      why: [...comparison.mismatches.map((m) => `field mismatch: ${m}`), ...blockingIssues.map((i) => `${i.kind}: ${i.reason}`)].join(' | ') || 'unspecified',
      sourceEmailId: sourceId, sourceEmailName: requestedName,
      destinationEmailId: destinationId, destinationEmailName: destFull.name,
      whatWasAttempted: `${action} the destination email via ${MARKETING_EMAILS_PATH}, then re-fetched and compared field-by-field.`,
      whatNeedsToBeDone: 'Review the listed field mismatches / dependency issues above (and in marketing-email-field-comparison.json), fix manually in the destination portal or via the mapping files, then rerun — this will UPDATE the same destination email, not duplicate it.',
      canRerun: true,
    });
  }

  logSuccess({ sourceEmailId: sourceId, sourceEmailName: fullSource.name, destinationEmailId: destinationId, destinationEmailName: destFull.name, action, status: finalStatus, durationMs: Date.now() - startedAt, validation: comparison.overall });
  console.log(`[${finalStatus === 'FULL_SUCCESS' ? 'ok' : 'warn'}] ${action} "${requestedName}" (source ${sourceId} -> destination ${destinationId}) [${finalStatus}]`);

  return { status: finalStatus, sourceEmailId: sourceId, sourceEmailName: requestedName, destinationEmailId: destinationId, action };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = nowIso();
  console.log('HubSpot Marketing Email Migration');
  console.log('==================================');
  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log(`ALLOW_PUBLISH: ${ALLOW_PUBLISH}${ALLOW_PUBLISH ? ' (no-op — this script never calls a publish/send endpoint; see file header)' : ''}`);
  console.log(`MIGRATE_DEPENDENCIES: ${CONFIG.migrateDependencies}`);
  console.log(`Name prefix: "${CONFIG.prefix}"`);

  if (ALLOW_PUBLISH) {
    logManualReview({
      what: 'ALLOW_PUBLISH=true was set',
      why: 'This script intentionally never calls a publish/send endpoint for any email, regardless of this flag, because no such endpoint was verified against current HubSpot documentation during development and this migration must never send a real marketing email.',
      sourceEmailId: 'n/a', sourceEmailName: 'n/a',
      whatWasAttempted: 'N/A — no publish call was made.',
      whatNeedsToBeDone: 'Publish/send any destination email manually from the HubSpot UI once you have reviewed it.',
      canRerun: true,
    });
  }

  if (!CONFIG.sourceToken || !CONFIG.destinationToken) {
    console.error('[fatal] SOURCE_HUBSPOT_TOKEN and DESTINATION_HUBSPOT_TOKEN are both required.');
    process.exitCode = 1;
    return;
  }
  if (CONFIG.sourceToken === CONFIG.destinationToken) {
    console.error('[fatal] SOURCE_HUBSPOT_TOKEN and DESTINATION_HUBSPOT_TOKEN are identical. Refusing to run.');
    process.exitCode = 1;
    return;
  }

  const [sourcePortalId, destPortalId] = await Promise.all([
    fetchPortalId(CONFIG.sourceToken, 'source'),
    fetchPortalId(CONFIG.destinationToken, 'destination'),
  ]);
  if (sourcePortalId && destPortalId) {
    console.log(`SOURCE PORTAL ID: ${sourcePortalId}`);
    console.log(`DESTINATION PORTAL ID: ${destPortalId}`);
    if (sourcePortalId === destPortalId) {
      console.error('[fatal] Source and destination tokens resolve to the same HubSpot portal. Aborting.');
      process.exitCode = 1;
      return;
    }
  } else {
    console.log('[info] Could not verify portal IDs (missing oauth scope or endpoint unavailable) — proceeding anyway.');
  }

  console.log('\n[info] Fetching marketing emails from the source portal...');
  let sourceEmails;
  try {
    sourceEmails = await listAllMarketingEmails(CONFIG.sourceToken, 'source');
  } catch (err) {
    if (isAuthError(err)) {
      console.error(`[fatal] Authentication/permission failure listing source marketing emails (status ${err.status}). Verify SOURCE_HUBSPOT_TOKEN has the "content"/"marketing-email" scopes. Stopping before any destination changes.`);
    } else {
      console.error(`[fatal] Could not list source marketing emails: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[info] Found ${sourceEmails.length} marketing email(s) in the source portal.`);

  console.log('[info] Fetching marketing emails from the destination portal (for duplicate detection)...');
  let destinationEmails;
  try {
    destinationEmails = await listAllMarketingEmails(CONFIG.destinationToken, 'destination');
  } catch (err) {
    if (isAuthError(err)) {
      console.error(`[fatal] Authentication/permission failure listing destination marketing emails (status ${err.status}). Verify DESTINATION_HUBSPOT_TOKEN has the "content"/"marketing-email" scopes and create/update permission. Stopping before any changes.`);
    } else {
      console.error(`[fatal] Could not list destination marketing emails: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[info] Found ${destinationEmails.length} marketing email(s) already in the destination portal.`);

  const destinationNameIndex = new Map();
  for (const email of destinationEmails) {
    const list = destinationNameIndex.get(email.name) || [];
    list.push(email);
    destinationNameIndex.set(email.name, list);
  }

  const byName = new Map();
  for (const email of sourceEmails) {
    const list = byName.get(email.name) || [];
    list.push(email);
    byName.set(email.name, list);
  }

  const readyMatches = [];
  const notFound = [];
  const duplicateNameMatches = [];

  for (const requestedName of REQUESTED_EMAIL_NAMES) {
    const candidates = byName.get(requestedName) || [];
    if (candidates.length === 0) {
      notFound.push(requestedName);
      continue;
    }
    if (candidates.length === 1) {
      readyMatches.push(candidates[0]);
      continue;
    }

    const pinnedId = DUPLICATE_NAME_OVERRIDES[requestedName];
    const pinned = pinnedId ? candidates.find((c) => String(c.id) === String(pinnedId)) : null;
    if (pinned) {
      readyMatches.push(pinned);
      const skipped = candidates.filter((c) => String(c.id) !== String(pinnedId)).map((c) => c.id).join(', ');
      console.log(`[info] "${requestedName}" matched ${candidates.length} source emails; using pinned id ${pinnedId} per DUPLICATE_NAME_OVERRIDES (skipping: ${skipped}).`);
      continue;
    }
    if (pinnedId) {
      console.warn(`[warn] DUPLICATE_NAME_OVERRIDES pins "${requestedName}" to id ${pinnedId}, but that id is no longer among its ${candidates.length} source matches (ids: ${candidates.map((c) => c.id).join(', ')}). Falling back to manual review.`);
    }
    duplicateNameMatches.push({ name: requestedName, candidates });
  }

  console.log('\nPre-migration summary');
  console.log('----------------------');
  console.log(`Requested emails: ${REQUESTED_EMAIL_NAMES.length}`);
  console.log(`Found: ${readyMatches.length + duplicateNameMatches.length}`);
  console.log(`Not found: ${notFound.length}`);
  console.log(`Duplicate-name matches: ${duplicateNameMatches.length}`);
  console.log(`Ready for migration: ${readyMatches.length}\n`);

  for (const name of notFound) {
    logManualReview({
      what: 'Requested marketing email not found in source portal',
      why: `No marketing email in the source portal has the exact name "${name}".`,
      sourceEmailId: 'n/a', sourceEmailName: name,
      whatWasAttempted: 'Exact (case-sensitive) name match against every marketing email returned by GET /marketing/v3/emails in the source portal.',
      whatNeedsToBeDone: 'Confirm the exact name in the source portal (typos, extra whitespace, or a rename), correct REQUESTED_EMAIL_NAMES if needed, then rerun.',
      canRerun: true,
    });
  }
  for (const dup of duplicateNameMatches) {
    logManualReview({
      what: 'Duplicate source email name',
      why: `${dup.candidates.length} source marketing emails share the exact name "${dup.name}": ids ${dup.candidates.map((c) => c.id).join(', ')}.`,
      sourceEmailId: dup.candidates.map((c) => c.id).join(', '), sourceEmailName: dup.name,
      whatWasAttempted: 'Exact name matching cannot disambiguate multiple source emails with an identical name, and no other reliable identifying field was provided.',
      whatNeedsToBeDone: 'Manually identify the correct source email id from the list above, then migrate it directly (e.g. temporarily add its id to a one-off run) instead of relying on name matching.',
      canRerun: true,
    });
  }

  const mappingState = loadMigrationMap();
  mappingState.sourcePortal = mappingState.sourcePortal || sourcePortalId || null;
  mappingState.destinationPortal = mappingState.destinationPortal || destPortalId || null;
  const dependencyMap = loadDependencyMap();
  const folderMap = loadFolderMap();

  let destListsByName = null;
  if (CONFIG.migrateDependencies) {
    console.log('[info] Fetching destination contact lists (for contactIlsLists dependency matching)...');
    const destLists = await fetchAllDestinationLists(CONFIG.destinationToken);
    if (destLists) {
      destListsByName = new Map();
      for (const list of destLists) {
        const arr = destListsByName.get(list.name) || [];
        arr.push(list);
        destListsByName.set(list.name, arr);
      }
      console.log(`[info] Found ${destLists.length} destination list(s).`);
    }
  }

  const ctx = {
    sourceToken: CONFIG.sourceToken,
    destToken: CONFIG.destinationToken,
    folderMap,
    dependencyMap,
    mappingState,
    destinationNameIndex,
    destListsByName,
    dryRun: DRY_RUN,
    sourceSnapshots: {},
    destinationSnapshots: {},
    fieldComparisons: [],
  };

  const counters = {
    requested: REQUESTED_EMAIL_NAMES.length,
    found: readyMatches.length + duplicateNameMatches.length,
    notFound: notFound.length,
    created: 0, updated: 0, fullSuccess: 0, partial: 0, failed: 0,
    manualReview: duplicateNameMatches.length, dryRun: 0,
  };

  for (const sourceSummary of readyMatches) {
    let result;
    try {
      result = await migrateEmail(sourceSummary, ctx);
    } catch (err) {
      if (isAuthError(err)) {
        console.error(`[fatal] Authentication/permission failure while migrating "${sourceSummary.name}" (status ${err.status}). Stopping the entire migration — continuing would only produce more auth failures.`);
        break;
      }
      logError({ phase: 'MIGRATION', sourceEmailId: sourceSummary.id, sourceEmailName: sourceSummary.name, errorMessage: err.message, stack: err.stack });
      result = { status: 'FAILED' };
    }

    if (result.status === 'FULL_SUCCESS') {
      counters.fullSuccess += 1;
      if (result.action === 'CREATED') counters.created += 1; else if (result.action === 'UPDATED') counters.updated += 1;
    } else if (result.status === 'PARTIAL') {
      counters.partial += 1;
      if (result.action === 'CREATED') counters.created += 1; else if (result.action === 'UPDATED') counters.updated += 1;
    } else if (result.status === 'FAILED') {
      counters.failed += 1;
    } else if (result.status === 'MANUAL_REVIEW_REQUIRED') {
      counters.manualReview += 1;
    } else if (result.status === 'DRY_RUN') {
      counters.dryRun += 1;
    }
  }

  writeJsonFileAtomic(SOURCE_SNAPSHOT_PATH, ctx.sourceSnapshots);
  writeJsonFileAtomic(DESTINATION_SNAPSHOT_PATH, ctx.destinationSnapshots);
  writeJsonFileAtomic(FIELD_COMPARISON_PATH, ctx.fieldComparisons);

  const listsCreated = Object.values(dependencyMap.lists).filter((l) => l.resolvedVia === 'created').length;
  const listsReused = Object.values(dependencyMap.lists).filter((l) => l.resolvedVia === 'name-match').length;
  const filesImported = Object.keys(dependencyMap.files).length;

  const summary = {
    startedAt, completedAt: nowIso(), dryRun: DRY_RUN,
    requested: counters.requested, found: counters.found, notFound: counters.notFound,
    created: counters.created, updated: counters.updated,
    fullyReplicated: counters.fullSuccess, partiallyReplicated: counters.partial,
    failed: counters.failed, manualReview: counters.manualReview,
    additionalDependencyRecords: { listsCreated, listsReused, filesImported },
    results: ctx.fieldComparisons.map((c) => ({ sourceEmailId: c.sourceEmailId, sourceEmailName: c.sourceName, destinationEmailId: c.destinationEmailId, destinationEmailName: c.destinationName, action: c.action, status: c.status })),
  };
  writeJsonFileAtomic(SUMMARY_PATH, summary);

  console.log('\n========================================');
  console.log('MIGRATION SUMMARY');
  console.log('========================================');
  console.log(`Requested: ${counters.requested}`);
  console.log(`Found: ${counters.found}`);
  console.log(`Not found: ${counters.notFound}`);
  console.log(`Duplicate-name matches (manual review): ${duplicateNameMatches.length}`);
  console.log(`Created: ${counters.created}`);
  console.log(`Updated: ${counters.updated}`);
  console.log(`Fully replicated: ${counters.fullSuccess}`);
  console.log(`Partially replicated: ${counters.partial}`);
  console.log(`Failed: ${counters.failed}`);
  console.log(`Manual review: ${counters.manualReview}`);
  if (DRY_RUN) console.log(`Dry run previewed (no changes made): ${counters.dryRun}`);
  console.log(`\nDependency lists created: ${listsCreated}`);
  console.log(`Dependency lists reused: ${listsReused}`);
  console.log(`Dependency files imported: ${filesImported}`);
  console.log('========================================');
  console.log(`\nLogs directory: ${CONFIG.logDirectory}`);
  console.log(`Migration mapping: ${CONFIG.mappingFile}`);
  console.log(`Dependency map: ${CONFIG.dependencyMapFile}`);
  console.log(`Folder map (edit manually): ${CONFIG.folderMapFile}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[fatal] Unexpected error:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  buildDestinationName,
  buildCreatePayload,
  validateMigration,
  resolveListReference,
  resolveFileUrl,
  resolveFolder,
  extractFileUrls,
  detectUnmigratableContentReferences,
  sha256Hex,
  stableStringify,
};
