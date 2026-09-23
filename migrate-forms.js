#!/usr/bin/env node

/**
 * HubSpot Forms Migration Script
 * ================================
 *
 * Migrates ONLY the 40 forms named in FORM_NAMES below (the forms actually
 * referenced as assets by the 33 campaigns already migrated via
 * migrate-campaigns.js), from a SOURCE HubSpot portal to a DESTINATION
 * HubSpot portal — then migrate-campaigns.js's asset-linking (already
 * built) will pick these up automatically on its next re-run, since it
 * matches destination assets by exact "Touchmath - <name>" name.
 *
 * FACTS CONFIRMED LIVE AGAINST REAL HUBSPOT PORTALS BEFORE WRITING THIS
 * SCRIPT:
 *   - Base path: /marketing/v3/forms. GET (list) and GET/{id} both return
 *     the FULL form definition (id, name, createdAt, updatedAt, archived,
 *     fieldGroups, configuration, displayOptions, legalConsentOptions,
 *     formType) — unlike the Campaigns API, there is no restricted
 *     `properties=` allowlist here; the list endpoint already has
 *     everything needed, confirmed by direct comparison of list vs get-by-id
 *     responses.
 *   - POST /marketing/v3/forms is the real create endpoint (confirmed via a
 *     live validation-error probe — an empty body 400s with "Some required
 *     fields were not set: [name, formType, createdAt]"). A doc page
 *     advertised an alternate dated path (/marketing/forms/2027-03-beta)
 *     that returns the identical validation error — i.e. it's the same
 *     backend, and /marketing/v3/forms is used here as the stable path.
 *   - createdAt IS required on create (unusual — most objects treat this as
 *     server-assigned/read-only). This script sets it to "now" on create and
 *     never sends it on update.
 *   - PATCH /marketing/v3/forms/{id} is a real, working partial-update
 *     endpoint (confirmed live) — only the fields included in the body are
 *     changed.
 *   - Forms are NOT a CRM object — there is no Properties API for them and
 *     no custom-property mechanism to use for duplicate prevention.
 *     Idempotency therefore uses a local JSON mapping file
 *     (form-migration-map.json), same approach as migrate-marketing-emails.js.
 *   - Form fields reference CRM properties by { objectTypeId, name } (every
 *     field on all 40 target forms uses objectTypeId "0-1" / contacts).
 *     Before including a field, this script confirms that property name
 *     exists in the DESTINATION portal's contacts schema (via the standard
 *     CRM Properties API) — if it doesn't, the field is excluded and logged
 *     for manual review rather than sent and risking a rejected/broken form.
 *   - configuration.notifyRecipients is an array of SOURCE-portal HubSpot
 *     owner/user ids — portal-specific and meaningless if copied directly.
 *     This script resolves each id to an email via the source portal's
 *     Owners API (GET /crm/v3/owners), then looks up that email in the
 *     destination portal's Owners API to find the equivalent id. Owners
 *     that can't be matched by email are omitted and logged, never guessed.
 *   - Across all 40 target forms as inspected live: legalConsentOptions.type
 *     is always "none", and configuration.postSubmitAction.type is always
 *     either "thank_you" (inline HTML, portal-agnostic) or "redirect_url"
 *     (external URL, portal-agnostic) — both copy through directly. This
 *     script still detects and flags (does not silently trust) any OTHER
 *     value for either field, since a non-"none" consent type or a
 *     "thank_you_page" type (which would reference a source-portal CMS page
 *     id) needs human review rather than a guess.
 *   - displayOptions (styling) is fully self-contained with no portal ids —
 *     copied through as-is.
 *
 * REQUIRED HUBSPOT PRIVATE APP SCOPES
 * -------------------------------------
 *   Source app:      forms, crm.objects.owners.read
 *   Destination app:  forms, crm.objects.owners.read, crm.schemas.contacts.read
 *
 * REQUIRED ENV VARS (.env, loaded via --env-file)
 * ---------------------------------------------------
 *   SOURCE_HUBSPOT_TOKEN, DESTINATION_HUBSPOT_TOKEN
 *
 * OPTIONAL ENV VARS
 * -------------------
 *   DRY_RUN (default "true"), MAX_RETRIES, RETRY_BASE_DELAY_MS,
 *   REQUEST_DELAY_MS, HUBSPOT_API_BASE, MAPPING_FILE, LOG_DIRECTORY
 *
 * USAGE
 * -----
 *   node --env-file=.env migrate-forms.js              # dry run (default)
 *   DRY_RUN=false node --env-file=.env migrate-forms.js # real migration
 *
 * OUTPUT
 * ------
 *   form-migration-map.json (source id -> destination id, idempotency)
 *   logs/form-migration-{success,errors,manual-review}.log
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';

const CONFIG = {
  sourceToken: process.env.SOURCE_HUBSPOT_TOKEN,
  destToken: process.env.DESTINATION_HUBSPOT_TOKEN,
  prefix: 'Touchmath - ',
  dryRun: DRY_RUN,
  maxRetries: Number.parseInt(process.env.MAX_RETRIES, 10) || 5,
  retryBaseDelayMs: Number.parseInt(process.env.RETRY_BASE_DELAY_MS, 10) || 1000,
  requestDelayMs: Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 300,
  hubspotApiBase: process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com',
  mappingFile: process.env.MAPPING_FILE || path.join(process.cwd(), 'form-migration-map.json'),
  logDirectory: process.env.LOG_DIRECTORY || path.join(process.cwd(), 'logs'),
};

fs.mkdirSync(CONFIG.logDirectory, { recursive: true });

const FORMS_PATH = '/marketing/v3/forms';
const OWNERS_PATH = '/crm/v3/owners';

const SUCCESS_LOG_PATH = path.join(CONFIG.logDirectory, 'form-migration-success.log');
const ERROR_LOG_PATH = path.join(CONFIG.logDirectory, 'form-migration-errors.log');
const MANUAL_REVIEW_LOG_PATH = path.join(CONFIG.logDirectory, 'form-migration-manual-review.log');

// Values confirmed live across all 40 target forms; anything else is flagged
// for manual review rather than assumed safe.
const KNOWN_SAFE_POST_SUBMIT_TYPES = new Set(['thank_you', 'redirect_url']);
const KNOWN_SAFE_CONSENT_TYPES = new Set(['none']);

// ---------------------------------------------------------------------------
// The 40 forms to migrate — exact (case-sensitive, whitespace-sensitive)
// name match only. Names come directly from the source portal (some have
// trailing/double spaces exactly as authored there — preserved verbatim).
// ---------------------------------------------------------------------------

const FORM_NAMES = [
  'State | TM Georgia Tier 2 | FY26',
  'Funding Alignments Guide',
  'TouchMath K-5 Program Sampler',
  'TouchMath Grades 3-5 Sampler',
  'Curriculum Bridges - HMH Go Math ',
  'Curriculum Bridges - TeachTown enCore Math ',
  'Curriculum Bridges - Bluebonnet Math ',
  'Curriculum Bridges - Paradigm by SwunMath',
  'Curriculum Bridges - Into Math ',
  'Curriculum Bridges - Amplify Desmos ',
  'Curriculum Bridges - Everway ULS Math  ',
  'Curriculum Bridges - Illustrative Math ',
  'Curriculum Bridges - SwunMath',
  'Curriculum Bridges - iReady Math ',
  'Curriculum Bridges - HMH Math in Focus',
  'Curriculum Bridges - Bridges Mathematics ',
  'Curriculum Bridges - Reveal Math ',
  'Curriculum Bridges - Eureka Math²',
  'Curriculum Bridges - Envision Math ',
  'Curriculum Bridges - StemScopes Math',
  'Grades 3-5 Fun Sheets - Download ',
  'Winter Fun Sheets 2025 - Download',
  "Conferences - NCTM/NCSM - Claim Copy of Elliott's Book",
  'AI Purchasing Guide (2025)',
  'Conferences - VACASE - Fall 2025',
  'Conferences - SSTAGE - Fall 2025',
  'Conferences - NJSBA - Fall 2025',
  'Conferences - MS CEC 2025 - Fall 2025',
  'Conferences - IAASE - Fall 2025',
  'Conferences - OASPA 2025 - Fall 2025',
  'Conferences - LASE - Fall 2025',
  'Conferences - NCASE 2025 - Fall 2025',
  'Conferences - WTN SPED 2025 - Fall 2025',
  'Conferences - MO CASE 2025 - Fall 2025',
  'Conferences - Region 10 SPED Vendor Fair - Fall 2025',
  'Conferences - ALACASE - Fall 2025',
  'Conferences - TN DOE - Fall 2025',
  'Conferences - WCASS 2025 - Fall 2025',
  'Summer Math Workbook 2025 - Downloads',
  'Fun Sheets',
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn(`[warn] Could not read/parse ${filePath}, starting fresh (${err.message})`);
    return fallback;
  }
}

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

function buildDestinationName(sourceName) {
  if (typeof sourceName !== 'string') return sourceName;
  return sourceName.startsWith(CONFIG.prefix) ? sourceName : `${CONFIG.prefix}${sourceName}`;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logSuccess({ sourceFormId, sourceFormName, destinationFormId, destinationFormName, action, status, durationMs }) {
  appendLine(SUCCESS_LOG_PATH, [
    nowIso(),
    `SOURCE_ID=${sourceFormId}`,
    `SOURCE_NAME=${sourceFormName}`,
    `DESTINATION_ID=${destinationFormId ?? 'n/a'}`,
    `DESTINATION_NAME=${destinationFormName ?? 'n/a'}`,
    `ACTION=${action}`,
    `STATUS=${status}`,
    `DURATION_MS=${durationMs}`,
    '---',
  ].join('\n'));
}

function logError({ sourceFormId, sourceFormName, destinationFormId, phase, httpStatus, apiResponse, message }) {
  appendLine(ERROR_LOG_PATH, [
    nowIso(),
    `PHASE: ${phase}`,
    `SOURCE_ID: ${sourceFormId ?? 'n/a'}`,
    `SOURCE_NAME: ${sourceFormName ?? 'n/a'}`,
    `DESTINATION_ID: ${destinationFormId ?? 'n/a'}`,
    `HTTP_STATUS: ${httpStatus ?? 'n/a'}`,
    `API_RESPONSE: ${apiResponse ? JSON.stringify(apiResponse).slice(0, 500) : 'n/a'}`,
    `MESSAGE: ${message}`,
    '---',
  ].join('\n'));
}

function logManualReview({ what, why, sourceFormId, sourceFormName, whatNeedsToBeDone, canRerun }) {
  appendLine(MANUAL_REVIEW_LOG_PATH, [
    nowIso(),
    `WHAT FAILED: ${what}`,
    `WHY IT FAILED: ${why}`,
    `SOURCE FORM: ${sourceFormName ?? 'n/a'}`,
    `SOURCE FORM ID: ${sourceFormId ?? 'n/a'}`,
    `WHAT NEEDS TO BE DONE MANUALLY: ${whatNeedsToBeDone}`,
    `CAN RERUN AFTER FIXING: ${canRerun ? 'YES' : 'NO'}`,
    '---',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// HTTP layer — retries 429/408/5xx with exponential backoff, respects
// Retry-After, never retries other 4xx.
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

async function hubspotRequest(token, label, method, urlPath, jsonBody) {
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
      console.warn(`[warn][${label}] Network error on ${method} ${urlPath} (attempt ${attempt}), retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
      continue;
    }

    if (RETRYABLE_STATUSES.has(response.status)) {
      const body = await safeReadBody(response);
      if (attempt > CONFIG.maxRetries) {
        throw new HubSpotApiError(`[${label}] ${method} ${urlPath} failed after ${CONFIG.maxRetries} retries with status ${response.status}`, { status: response.status, body });
      }
      const retryAfterHeader = response.headers.get('retry-after');
      const backoffMs = retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))
        ? Number(retryAfterHeader) * 1000
        : Math.min(CONFIG.retryBaseDelayMs * 2 ** (attempt - 1), 30000);
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

function isAuthError(err) {
  return err instanceof HubSpotApiError && (err.status === 401 || err.status === 403);
}

// ---------------------------------------------------------------------------
// Forms API
// ---------------------------------------------------------------------------

async function listAllForms(token, label) {
  const all = [];
  let after;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    const page = await hubspotRequest(token, label, 'GET', `${FORMS_PATH}?${query.toString()}`);
    const results = (page && Array.isArray(page.results)) ? page.results : [];
    all.push(...results);
    after = page && page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : undefined;
  } while (after);
  return all;
}

async function getFormByIdSafe(token, label, id) {
  try {
    return await hubspotRequest(token, label, 'GET', `${FORMS_PATH}/${id}`);
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 404) return null;
    throw err;
  }
}

async function createForm(token, label, body) {
  return hubspotRequest(token, label, 'POST', FORMS_PATH, body);
}

async function updateForm(token, label, id, body) {
  return hubspotRequest(token, label, 'PATCH', `${FORMS_PATH}/${id}`, body);
}

// ---------------------------------------------------------------------------
// Owners API — used to resolve configuration.notifyRecipients (source owner
// ids are meaningless in the destination portal) by matching email address.
// ---------------------------------------------------------------------------

async function listAllOwners(token, label) {
  const all = [];
  let after;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    const page = await hubspotRequest(token, label, 'GET', `${OWNERS_PATH}?${query.toString()}`);
    const results = (page && Array.isArray(page.results)) ? page.results : [];
    all.push(...results);
    after = page && page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : undefined;
  } while (after);
  return all;
}

// ---------------------------------------------------------------------------
// CRM Properties — used to confirm a form field's referenced contact
// property actually exists in the destination portal before including it.
// ---------------------------------------------------------------------------

const propertyExistsCache = new Map();

async function destinationPropertyExists(destToken, objectTypeId, propertyName) {
  const objectTypeName = objectTypeId === '0-1' ? 'contacts' : objectTypeId === '0-2' ? 'companies' : objectTypeId;
  const cacheKey = `${objectTypeName}`;
  if (!propertyExistsCache.has(cacheKey)) {
    try {
      const resp = await hubspotRequest(destToken, 'destination', 'GET', `/crm/v3/properties/${objectTypeName}`);
      propertyExistsCache.set(cacheKey, new Set((resp.results || []).map((p) => p.name)));
    } catch (err) {
      console.warn(`[warn] Could not fetch destination properties for object type "${objectTypeName}" (${err.message}); field-existence checks for this type will be skipped (fields kept as-is).`);
      propertyExistsCache.set(cacheKey, null); // null = "unknown", treat as existing rather than guess it's missing
    }
  }
  const known = propertyExistsCache.get(cacheKey);
  return known === null ? true : known.has(propertyName);
}

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

async function buildFormPayload(sourceForm, ctx, { forCreate }) {
  const issues = [];
  const body = {};

  body.name = buildDestinationName(sourceForm.name);
  body.formType = sourceForm.formType;
  if (forCreate) body.createdAt = nowIso();

  // --- fieldGroups: drop any field whose referenced CRM property doesn't
  //     exist in the destination portal, rather than sending (and risking)
  //     a broken/rejected field reference. ---
  const fieldGroups = deepClone(sourceForm.fieldGroups || []);
  for (const group of fieldGroups) {
    const kept = [];
    for (const field of group.fields || []) {
      const exists = await destinationPropertyExists(ctx.destToken, field.objectTypeId, field.name);
      if (exists) {
        kept.push(field);
      } else {
        issues.push({ kind: 'FIELD_PROPERTY_MISSING', field: field.name, objectTypeId: field.objectTypeId, reason: `Destination portal has no "${field.objectTypeId}" property named "${field.name}" — field omitted from the migrated form.` });
      }
    }
    group.fields = kept;
  }
  body.fieldGroups = fieldGroups.filter((g) => (g.fields || []).length > 0);
  if (body.fieldGroups.length < fieldGroups.length) {
    issues.push({ kind: 'FIELD_GROUP_EMPTIED', reason: `${fieldGroups.length - body.fieldGroups.length} field group(s) had every field removed (missing destination properties) and were dropped entirely.` });
  }

  // --- configuration: remap notifyRecipients by owner email; pass through
  //     everything else; flag any postSubmitAction type not seen/verified. ---
  const configuration = deepClone(sourceForm.configuration || {});
  if (Array.isArray(configuration.notifyRecipients) && configuration.notifyRecipients.length > 0) {
    const resolved = [];
    for (const sourceOwnerId of configuration.notifyRecipients) {
      const email = ctx.sourceOwnersById.get(String(sourceOwnerId));
      const destOwnerId = email ? ctx.destOwnersByEmail.get(email.toLowerCase()) : undefined;
      if (destOwnerId) {
        resolved.push(destOwnerId);
      } else {
        issues.push({ kind: 'NOTIFY_RECIPIENT_UNRESOLVED', sourceOwnerId, sourceOwnerEmail: email || null, reason: email ? `No destination owner found with email "${email}".` : `Source owner id ${sourceOwnerId} not found in the source portal's owners list.` });
      }
    }
    configuration.notifyRecipients = resolved;
  }
  const postSubmitType = configuration.postSubmitAction && configuration.postSubmitAction.type;
  if (postSubmitType && !KNOWN_SAFE_POST_SUBMIT_TYPES.has(postSubmitType)) {
    issues.push({ kind: 'POSTSUBMIT_TYPE_UNVERIFIED', postSubmitType, reason: `postSubmitAction.type "${postSubmitType}" was not seen/verified during development (only "thank_you" and "redirect_url" were) — copied through as-is, but if it references a source-portal CMS page id, it will not resolve correctly in the destination. Verify manually.` });
  }
  body.configuration = configuration;

  // --- displayOptions: pure styling, no portal-specific references. ---
  body.displayOptions = deepClone(sourceForm.displayOptions || {});

  // --- legalConsentOptions: flag anything beyond the verified-safe "none". ---
  const legalConsentOptions = deepClone(sourceForm.legalConsentOptions || { type: 'none' });
  if (!KNOWN_SAFE_CONSENT_TYPES.has(legalConsentOptions.type)) {
    issues.push({ kind: 'CONSENT_TYPE_UNVERIFIED', consentType: legalConsentOptions.type, reason: `legalConsentOptions.type "${legalConsentOptions.type}" was not seen/verified during development (only "none" was). Copied through as-is, but any communication-subscription-type ids it references are portal-specific and may not exist in the destination — this is a compliance-relevant field, verify manually before this form goes live.` });
  }
  body.legalConsentOptions = legalConsentOptions;

  return { body, issues };
}

// ---------------------------------------------------------------------------
// Per-form migration
// ---------------------------------------------------------------------------

function loadMigrationMap() {
  return readJsonFile(CONFIG.mappingFile, { forms: {} });
}

function saveMigrationMap(state) {
  writeJsonFileAtomic(CONFIG.mappingFile, state);
}

async function migrateOneForm(sourceForm, ctx) {
  const startedAt = Date.now();
  const sourceId = String(sourceForm.id);
  const sourceName = sourceForm.name;
  const expectedName = buildDestinationName(sourceName);

  let existingDestForm = null;
  const mappingEntry = ctx.mappingState.forms[sourceId];
  if (mappingEntry && mappingEntry.destinationFormId) {
    existingDestForm = await getFormByIdSafe(ctx.destToken, 'destination', mappingEntry.destinationFormId);
    if (!existingDestForm) {
      console.warn(`[warn] Mapping for "${sourceName}" points to destination form ${mappingEntry.destinationFormId}, which no longer exists. Falling back to name match / create.`);
    }
  }
  if (!existingDestForm) {
    const candidates = ctx.destFormsByName.get(expectedName) || [];
    if (candidates.length === 1) {
      existingDestForm = candidates[0];
    } else if (candidates.length > 1) {
      logManualReview({
        what: 'Ambiguous destination match', why: `${candidates.length} destination forms are already named exactly "${expectedName}".`,
        sourceFormId: sourceId, sourceFormName: sourceName,
        whatNeedsToBeDone: `Manually identify the correct destination form, then add "${sourceId}": {"destinationFormId": "<id>"} to ${CONFIG.mappingFile}.`,
        canRerun: true,
      });
      return { status: 'MANUAL_REVIEW_REQUIRED' };
    }
  }

  const action = existingDestForm ? 'UPDATE' : 'CREATE';
  const { body, issues } = await buildFormPayload(sourceForm, ctx, { forCreate: !existingDestForm });

  if (ctx.dryRun) {
    console.log(`[DRY RUN] ${action} "${sourceName}" -> "${expectedName}"${issues.length ? ` (${issues.length} issue(s): ${issues.map((i) => i.kind).join(', ')})` : ''}`);
    logSuccess({ sourceFormId: sourceId, sourceFormName: sourceName, destinationFormId: existingDestForm ? existingDestForm.id : null, destinationFormName: expectedName, action: `DRY_RUN_${action}`, status: 'DRY_RUN', durationMs: Date.now() - startedAt });
    return { status: 'DRY_RUN' };
  }

  let result;
  try {
    result = existingDestForm ? await updateForm(ctx.destToken, 'destination', existingDestForm.id, body) : await createForm(ctx.destToken, 'destination', body);
  } catch (err) {
    logError({ sourceFormId: sourceId, sourceFormName: sourceName, destinationFormId: existingDestForm ? existingDestForm.id : null, phase: action, httpStatus: err.status, apiResponse: err.body, message: err.message });
    return { status: 'FAILED' };
  }

  const destinationId = String(result.id);
  ctx.mappingState.forms[sourceId] = { sourceFormId: sourceId, sourceFormName: sourceName, destinationFormId: destinationId, destinationFormName: result.name, status: issues.length ? 'PARTIAL' : 'SUCCESS', lastMigratedAt: nowIso() };
  saveMigrationMap(ctx.mappingState);

  for (const issue of issues) {
    logManualReview({
      what: `Form migrated with an unresolved detail (${issue.kind})`, why: issue.reason,
      sourceFormId: sourceId, sourceFormName: sourceName,
      whatNeedsToBeDone: 'Review the reason above and fix manually in the destination portal if needed (or add the missing destination property / owner, then rerun to heal).',
      canRerun: true,
    });
  }

  const status = issues.length ? 'PARTIAL' : 'FULL_SUCCESS';
  logSuccess({ sourceFormId: sourceId, sourceFormName: sourceName, destinationFormId: destinationId, destinationFormName: result.name, action, status, durationMs: Date.now() - startedAt });
  console.log(`[${status === 'FULL_SUCCESS' ? 'ok' : 'warn'}] ${action} "${sourceName}" (source ${sourceId} -> destination ${destinationId}) [${status}]${issues.length ? ` ${issues.length} issue(s) logged` : ''}`);
  return { status };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function fetchPortalId(token, label) {
  try {
    const details = await hubspotRequest(token, label, 'GET', '/account-info/v3/details');
    return details ? details.portalId : null;
  } catch {
    return null;
  }
}

function findMatchingForms(sourceForms) {
  const byName = new Map();
  for (const f of sourceForms) {
    const arr = byName.get(f.name) || [];
    arr.push(f);
    byName.set(f.name, arr);
  }
  const matches = [];
  const notFound = [];
  const duplicates = [];
  for (const requestedName of FORM_NAMES) {
    const candidates = byName.get(requestedName) || [];
    if (candidates.length === 0) notFound.push(requestedName);
    else if (candidates.length === 1) matches.push(candidates[0]);
    else duplicates.push({ name: requestedName, candidates });
  }
  return { matches, notFound, duplicates };
}

async function main() {
  console.log('HubSpot Forms Migration');
  console.log('========================');
  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log(`Name prefix: "${CONFIG.prefix}"`);

  if (!CONFIG.sourceToken || !CONFIG.destToken) {
    console.error('[fatal] SOURCE_HUBSPOT_TOKEN and DESTINATION_HUBSPOT_TOKEN are both required.');
    process.exitCode = 1;
    return;
  }
  if (CONFIG.sourceToken === CONFIG.destToken) {
    console.error('[fatal] Source and destination tokens are identical. Refusing to run.');
    process.exitCode = 1;
    return;
  }

  const [sourcePortalId, destPortalId] = await Promise.all([fetchPortalId(CONFIG.sourceToken, 'source'), fetchPortalId(CONFIG.destToken, 'destination')]);
  if (sourcePortalId && destPortalId) {
    console.log(`SOURCE PORTAL ID: ${sourcePortalId}`);
    console.log(`DESTINATION PORTAL ID: ${destPortalId}`);
    if (sourcePortalId === destPortalId) {
      console.error('[fatal] Source and destination tokens resolve to the same HubSpot portal. Aborting.');
      process.exitCode = 1;
      return;
    }
  }

  console.log('\n[info] Fetching forms from the source portal...');
  let sourceForms;
  try {
    sourceForms = await listAllForms(CONFIG.sourceToken, 'source');
  } catch (err) {
    console.error(isAuthError(err) ? `[fatal] Auth/permission failure listing source forms (status ${err.status}). Verify SOURCE_HUBSPOT_TOKEN has the "forms" scope.` : `[fatal] Could not list source forms: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[info] Found ${sourceForms.length} form(s) in the source portal.`);

  console.log('[info] Fetching forms from the destination portal...');
  let destForms;
  try {
    destForms = await listAllForms(CONFIG.destToken, 'destination');
  } catch (err) {
    console.error(isAuthError(err) ? `[fatal] Auth/permission failure listing destination forms (status ${err.status}). Verify DESTINATION_HUBSPOT_TOKEN has the "forms" scope.` : `[fatal] Could not list destination forms: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[info] Found ${destForms.length} form(s) already in the destination portal.`);

  console.log('[info] Fetching owners from both portals (for notifyRecipients mapping)...');
  const [sourceOwners, destOwners] = await Promise.all([listAllOwners(CONFIG.sourceToken, 'source'), listAllOwners(CONFIG.destToken, 'destination')]);
  const sourceOwnersById = new Map(sourceOwners.map((o) => [String(o.id), o.email]));
  const destOwnersByEmail = new Map(destOwners.filter((o) => o.email).map((o) => [o.email.toLowerCase(), String(o.id)]));

  const destFormsByName = new Map();
  for (const f of destForms) {
    const arr = destFormsByName.get(f.name) || [];
    arr.push(f);
    destFormsByName.set(f.name, arr);
  }

  const { matches, notFound, duplicates } = findMatchingForms(sourceForms);

  console.log('\nPre-migration summary');
  console.log('----------------------');
  console.log(`Requested forms: ${FORM_NAMES.length}`);
  console.log(`Found: ${matches.length + duplicates.length}`);
  console.log(`Not found: ${notFound.length}`);
  console.log(`Duplicate-name matches: ${duplicates.length}`);
  console.log(`Ready for migration: ${matches.length}\n`);

  for (const name of notFound) {
    logManualReview({ what: 'Requested form not found in source portal', why: `No form in the source portal has the exact name "${name}".`, sourceFormId: 'n/a', sourceFormName: name, whatNeedsToBeDone: 'Confirm the exact name (typo/rename/deleted), then rerun.', canRerun: true });
  }
  for (const dup of duplicates) {
    logManualReview({ what: 'Duplicate source form name', why: `${dup.candidates.length} source forms share the exact name "${dup.name}": ids ${dup.candidates.map((c) => c.id).join(', ')}.`, sourceFormId: dup.candidates.map((c) => c.id).join(', '), sourceFormName: dup.name, whatNeedsToBeDone: 'Identify the correct source form id and migrate it directly instead of relying on name matching.', canRerun: true });
  }

  const mappingState = loadMigrationMap();
  const ctx = { sourceToken: CONFIG.sourceToken, destToken: CONFIG.destToken, mappingState, destFormsByName, sourceOwnersById, destOwnersByEmail, dryRun: CONFIG.dryRun };

  const counters = { requested: FORM_NAMES.length, found: matches.length + duplicates.length, notFound: notFound.length, migrated: 0, failed: 0, manualReview: duplicates.length, dryRun: 0 };

  for (const sourceForm of matches) {
    let result;
    try {
      result = await migrateOneForm(sourceForm, ctx);
    } catch (err) {
      if (isAuthError(err)) {
        console.error(`[fatal] Auth/permission failure migrating "${sourceForm.name}" (status ${err.status}). Stopping the entire migration.`);
        break;
      }
      logError({ sourceFormId: sourceForm.id, sourceFormName: sourceForm.name, phase: 'MIGRATION', message: err.message });
      result = { status: 'FAILED' };
    }
    if (result.status === 'FULL_SUCCESS' || result.status === 'PARTIAL') counters.migrated += 1;
    else if (result.status === 'FAILED') counters.failed += 1;
    else if (result.status === 'MANUAL_REVIEW_REQUIRED') counters.manualReview += 1;
    else if (result.status === 'DRY_RUN') counters.dryRun += 1;
  }

  console.log('\n========================================');
  console.log('MIGRATION SUMMARY');
  console.log('========================================');
  console.log(`Requested: ${counters.requested}`);
  console.log(`Found: ${counters.found}`);
  console.log(`Not found: ${counters.notFound}`);
  console.log(`Migrated: ${counters.migrated}`);
  console.log(`Failed: ${counters.failed}`);
  console.log(`Manual review: ${counters.manualReview}`);
  if (CONFIG.dryRun) console.log(`Dry run previewed: ${counters.dryRun}`);
  console.log('========================================');
  console.log(`\nMapping: ${CONFIG.mappingFile}`);
  console.log(`Logs: ${CONFIG.logDirectory}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[fatal] Unexpected error:', err);
    process.exitCode = 1;
  });
}

module.exports = { main, buildDestinationName, buildFormPayload, findMatchingForms };
