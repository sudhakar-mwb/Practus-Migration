#!/usr/bin/env node

/**
 * HubSpot Marketing Campaigns Migration Script
 * =============================================
 *
 * Migrates ONLY the 32 campaigns named in CAMPAIGN_NAMES below, from a
 * SOURCE HubSpot portal to a DESTINATION HubSpot portal, with full property
 * replication, best-effort asset/CRM-association re-linking, and safe
 * re-runs (no duplicate campaigns/associations).
 *
 * FACTS CONFIRMED LIVE AGAINST REAL HUBSPOT PORTALS BEFORE WRITING THIS
 * SCRIPT (not guessed, not taken from a single doc page — several of these
 * contradict what the public docs pages summarize, so live behavior was
 * trusted over doc summaries where they disagreed):
 *
 *   - Object type name: "campaigns". CRM object type ID: 0-35. Campaigns are
 *     a full CRM object — GET /crm/v3/properties/campaigns returns live
 *     property definitions (117 on this portal), and POST to the same path
 *     creates a custom property, exactly like any other CRM object.
 *   - TWO DIFFERENT ID SPACES for the same campaign, NOT interchangeable:
 *       - The Marketing API (/marketing/v3/campaigns/{campaignGuid}) uses a
 *         GUID. Passing the numeric id here returns 400 VALIDATION_ERROR.
 *       - The CRM Associations v4 API (/crm/v4/associations/campaigns/...)
 *         and CRM Search API use the numeric `hs_object_id` property value.
 *         Passing the GUID here returns crm.associations.INVALID_IDENTIFIER.
 *     Both ids are returned together on every campaign object/list row (the
 *     top-level `id` is the GUID; `properties.hs_object_id` is the numeric
 *     id) — this script always fetches `hs_object_id` explicitly and keeps
 *     both ids next to each other rather than trying to convert one to the
 *     other (there's no documented conversion; GET-by-guid is the only
 *     confirmed way to resolve a numeric id back to its GUID, done once per
 *     campaign after matching).
 *   - `hs_name` has modificationMetadata.readOnlyValue = true, but THAT
 *     METADATA IS WRONG — CONFIRMED LIVE 2026-09-25 against sandbox 47206776:
 *     PATCH /marketing/v3/campaigns/{guid} with properties.hs_name returned
 *     200 and a read-back showed the new name persisted (campaign renamed
 *     "Touchmath | TAW2026" -> "Touchmath | TAW2026"). hs_name also appears
 *     in the write allowlist the API returns when it rejects a write. This
 *     script therefore sends hs_name on CREATE *and* UPDATE, so changing
 *     CONFIG.namePrefix re-normalises campaigns migrated by earlier runs.
 *     (It previously trusted the metadata and never sent hs_name on PATCH,
 *     which left campaigns permanently on the first run's prefix spelling.)
 *   - `hs_revenue` is writable (modificationMetadata.readOnlyValue = false)
 *     — it is NOT the read-only rollup one might assume. The actual
 *     read-only computed rollups are `hs_influenced_revenue`,
 *     `hs_budget_items_sum_amount`, and `hs_spend_items_sum_amount` — all
 *     confirmed readOnlyValue = true. This is exactly why this script reads
 *     live property metadata rather than hardcoding a read-only list.
 *   - GET /marketing/v3/campaigns/{guid} with no `properties` query param
 *     returns only a tiny default subset of fields. To get every property
 *     value, this script always passes an explicit `properties=` list.
 *   - THE MARKETING API'S `properties=` PARAM IS ITSELF RESTRICTED: both
 *     GET /marketing/v3/campaigns and GET .../campaigns/{guid} reject any
 *     property name outside a fixed allowlist (hs_start_date, hs_end_date,
 *     hs_color_hex, hs_notes, hs_audience, hs_goal, hs_owner,
 *     hs_currency_code, hs_created_by_user_id, hs_campaign_status,
 *     hs_object_id, hs_name, hs_utm, hs_budget_items_sum_amount,
 *     hs_spend_items_sum_amount, hs_business_unit_ids) plus genuinely custom
 *     properties, with HTTP 400 "Forbidden properties" — confirmed live,
 *     including for writable fields like hs_revenue and hs_projected_budget
 *     that are NOT on that list. This is unrelated to the CRM Properties API
 *     (which returns the full 117-property schema with no such
 *     restriction). Full-fidelity property reads for a matched campaign
 *     therefore go through the standard CRM Object API
 *     (GET /crm/v3/objects/campaigns/{numericId}, confirmed to accept the
 *     complete property list) instead — see getFullCampaignByObjectId /
 *     MARKETING_API_ALLOWED_STANDARD_PROPERTIES below. The Marketing API's
 *     list/get calls are still used, but only ever with the restricted
 *     allowlist, for matching, dedupe, and reading back `assets`.
 *   - THE WRITE SIDE (POST/PATCH) HAS ITS OWN, EVEN NARROWER, ALLOWLIST —
 *     confirmed from an actual migration run's
 *     CampaignApiError.PROPERTY_SET_CONTAINS_VALUES_FORBIDDEN_FOR_WRITE
 *     error, not guessed. Only hs_start_date, hs_end_date, hs_notes,
 *     hs_audience, hs_currency_code, hs_campaign_status, hs_name, hs_utm,
 *     hs_business_unit_ids (plus custom properties with
 *     modificationMetadata.readOnlyValue=false) are accepted in the
 *     properties body — hs_owner, hs_color_hex, hs_goal, hs_revenue, and
 *     everything else standard is rejected even though property metadata
 *     reports them as writable. See MARKETING_API_WRITE_ALLOWED_STANDARD_PROPERTIES.
 *   - hs_start_date/hs_end_date are `datetime`-typed (so the CRM Object API
 *     returns a full ISO datetime like "2026-05-06T00:00:00Z"), but the
 *     write endpoint rejects that with CampaignValidationError.
 *     INVALID_DATE_PROPERTY and requires a plain YYYY-MM-DD date — confirmed
 *     live. This script truncates to the date portion before writing
 *     (see toDateOnly / DATE_ONLY_PROPERTIES).
 *   - Associated marketing assets (emails, forms, social posts, etc.) come
 *     back EMBEDDED directly in the single-campaign GET response as
 *     `assets: { <ASSET_TYPE>: { results: [{id, name}] } }` — confirmed
 *     across real campaigns with MARKETING_EMAIL, FORM, and SOCIAL_BROADCAST
 *     asset types. CONFIRMED LIVE: that embedded list is capped at 50
 *     assets per type (with a `paging.next` link), so whenever there are
 *     more this script pages through GET .../assets/{assetType} to get them
 *     all (see fetchAllCampaignAssets).
 *   - Budget/spend line items: CONFIRMED LIVE that GET .../{guid}/budget/totals
 *     returns every budget and spend line item (`budgetItems`, `spendItems`),
 *     so they are enumerated there and any missing in the destination are
 *     created (see syncBudgetAndSpend).
 *   - Standard properties the Marketing API refuses to write (hs_owner,
 *     hs_color_hex, hs_goal, ...) can't be written through the CRM Object
 *     API either (campaigns aren't supported there, confirmed live). Values
 *     that differ are logged as MANUAL_PROPERTY with the exact value to set
 *     (see MANUAL_ONLY_PROPERTIES).
 *   - Custom properties OMIT `hubspotDefined` entirely (it is undefined, not
 *     false) — see isCustomProperty. Testing `=== false` once hid the dedupe
 *     property from every read and made all migrated campaigns look new.
 *   - CRM-record associations (contacts/companies/deals/tickets) use the
 *     same /crm/v4/associations/... pattern already proven elsewhere in this
 *     project (see hubspot-associations-common.js): batch/read for existing
 *     associations, GET .../labels for the default associationTypeId, and
 *     PUT /crm/v4/objects/{fromType}/{fromId}/associations/{toType}/{toId}
 *     to create one. A campaign with zero associations of a given type
 *     returns HTTP 207 with an error entry
 *     (subCategory=crm.associations.NO_ASSOCIATIONS_FOUND) rather than an
 *     empty result — this script treats that specific subCategory as "zero
 *     associations", not a failure.
 *
 * REQUIRED HUBSPOT PRIVATE APP SCOPES
 * -------------------------------------
 *   Source app:      marketing.campaigns.read, crm.objects.contacts.read,
 *                     crm.objects.companies.read, crm.objects.deals.read,
 *                     crm.objects.tickets.read
 *   Destination app:  marketing.campaigns.read, marketing.campaigns.write,
 *                     crm.objects.contacts.read, crm.objects.companies.read,
 *                     crm.objects.deals.read, crm.objects.tickets.read,
 *                     crm.schemas.custom.read (properties read),
 *                     crm.objects.marketing_events... (not needed — listed
 *                     only to be explicit that no marketing-event scope is
 *                     required by this script). Both apps additionally need
 *                     whatever scope HubSpot's UI groups the "Properties"
 *                     read/write calls under for the campaigns object in
 *                     your portal — if property creation 403s, check the
 *                     scopes tab on the destination private app for a
 *                     "Properties" or "crm.schemas" entry and enable it.
 *   Confirmed via the /crm/v3/properties/campaigns/groups endpoint that the
 *   only valid property group on this object is "campaigninformation" (no
 *   underscore) — used below when creating the dedupe property.
 *
 * REQUIRED ENVIRONMENT VARIABLES (.env, loaded via dotenv)
 * -----------------------------------------------------------
 *   SOURCE_HUBSPOT_TOKEN   Private app token for the source portal.
 *   DEST_HUBSPOT_TOKEN     Private app token for the destination portal.
 *                          (Falls back to DESTINATION_HUBSPOT_TOKEN if
 *                          DEST_HUBSPOT_TOKEN is not set, since that's the
 *                          name used by this project's other scripts.)
 *
 * OPTIONAL ENVIRONMENT VARIABLES
 * ---------------------------------
 *   HUBSPOT_API_BASE       Override API base (for testing against a mock server).
 *   MAX_RETRIES            Defaults to 5.
 *   RETRY_BASE_DELAY_MS    Defaults to 1000.
 *   REQUEST_DELAY_MS       Fixed pacing delay between calls. Defaults to 300.
 *   LOG_DIRECTORY          Defaults to ./logs
 *
 * USAGE
 * -----
 *   npm install
 *   node migrate-campaigns.js --dry-run     # preview only, no writes
 *   node migrate-campaigns.js               # real migration
 *
 * --dry-run runs the full discovery/matching/property-diff/asset-match/
 * association-match logic and prints + logs exactly what WOULD happen, but
 * skips every create/update/associate call to the destination portal.
 *
 * FILES THIS SCRIPT CREATES
 * ----------------------------
 *   logs/success-<run-timestamp>.json
 *   logs/errors-<run-timestamp>.json
 *
 * Re-running is safe: an already-migrated campaign is found via the
 * `source_campaign_id` custom property (list scan, then a direct CRM search
 * right before any create), or by name with any brand-prefix spelling
 * ("Touchmath | ", "Touchmath | ", ...); it is never created twice. Found
 * campaigns are detected via the `source_campaign_id` custom property
 * on the destination campaign (auto-created on the destination object if it
 * doesn't already exist) and only the steps that previously failed are
 * retried — a rerun always re-checks associations/assets/properties for an
 * already-found destination campaign rather than starting over.
 */

'use strict';

// dotenv is optional: `node --env-file=.env migrate-campaigns.js` already
// supplies the variables, and node_modules is not always installed in this
// project. A hard require here crashed the script with MODULE_NOT_FOUND even
// though the environment was fully configured.
try { require('dotenv').config(); } catch { /* optional — --env-file covers it */ }
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Dry run is enabled by EITHER the --dry-run flag or DRY_RUN=true in the
 * environment.
 *
 * The env var was added after this script's flag-only form caused a live
 * write: every other migration script in this project is driven by
 * `DRY_RUN=true|false`, so `DRY_RUN=true node migrate-campaigns.js` looks
 * like a preview but was silently ignored here and performed real updates.
 * Accepting both spellings removes that trap. DRY_RUN=false does NOT
 * override an explicit --dry-run flag — the safer of the two always wins.
 */
const DRY_RUN = process.argv.includes('--dry-run')
  || String(process.env.DRY_RUN || '').toLowerCase() === 'true';

/** Copy the source campaign's hs_utm. See the note in buildPropertiesPayload. */
const MIGRATE_UTM = String(process.env.MIGRATE_UTM || 'true').toLowerCase() !== 'false';

const CONFIG = {
  sourceToken: process.env.SOURCE_HUBSPOT_TOKEN,
  destToken: process.env.DEST_HUBSPOT_TOKEN || process.env.DESTINATION_HUBSPOT_TOKEN,
  namePrefix: 'Touchmath | ',
  dedupePropertyName: 'source_campaign_id',
  hubspotApiBase: process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com',
  maxRetries: Number.parseInt(process.env.MAX_RETRIES, 10) || 5,
  retryBaseDelayMs: Number.parseInt(process.env.RETRY_BASE_DELAY_MS, 10) || 1000,
  requestDelayMs: Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 300,
  logDirectory: process.env.LOG_DIRECTORY || path.join(process.cwd(), 'logs'),
  dryRun: DRY_RUN,
};

fs.mkdirSync(CONFIG.logDirectory, { recursive: true });

const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SUCCESS_LOG_PATH = path.join(CONFIG.logDirectory, `success-${RUN_TIMESTAMP}.json`);
const ERROR_LOG_PATH = path.join(CONFIG.logDirectory, `errors-${RUN_TIMESTAMP}.json`);

const OBJECT_TYPE = 'campaigns';
const CAMPAIGNS_PATH = '/marketing/v3/campaigns';
const PROPERTIES_PATH = `/crm/v3/properties/${OBJECT_TYPE}`;
const CRM_OBJECT_PATH = `/crm/v3/objects/${OBJECT_TYPE}`;

// CONFIRMED LIVE: the Marketing API's `properties=` query param (used by both
// GET /marketing/v3/campaigns and GET /marketing/v3/campaigns/{guid}) rejects
// any property name outside this fixed list with HTTP 400 "Forbidden
// properties" — even genuinely writable ones like hs_revenue or
// hs_projected_budget. This is NOT the same restriction as the CRM Properties
// API (which returns all 117 properties on this portal) — it's specific to
// the Marketing API's read path. The exact allowed set (plus "and custom
// properties you have defined for Campaign") was read directly from a live
// 400 response body, not guessed. Full-fidelity property reads therefore use
// the standard CRM Object API instead (getFullCampaignByObjectId below),
// which was confirmed to accept the complete 117-property list with no
// restriction; this list is used only for the Marketing API list/get calls
// (matching, dedupe, and the post-write asset re-fetch).
const MARKETING_API_ALLOWED_STANDARD_PROPERTIES = new Set([
  'hs_start_date', 'hs_end_date', 'hs_color_hex', 'hs_notes', 'hs_audience',
  'hs_goal', 'hs_owner', 'hs_currency_code', 'hs_created_by_user_id',
  'hs_campaign_status', 'hs_object_id', 'hs_name', 'hs_utm',
  'hs_budget_items_sum_amount', 'hs_spend_items_sum_amount', 'hs_business_unit_ids',
]);

/**
 * CONFIRMED LIVE: HubSpot sets `hubspotDefined: true` on standard properties
 * but OMITS the field entirely on custom ones (it is undefined, not false).
 * Testing `=== false` therefore never matches a custom property — which
 * silently dropped the dedupe property from every list call and made every
 * already-migrated campaign look new.
 */
function isCustomProperty(def) {
  return def.hubspotDefined !== true;
}

/** Properties safe to pass to the Marketing API's `properties=` query param: the fixed allowed set plus genuinely custom properties. */
function computeMarketingApiAllowedPropertyNames(propertyDefs) {
  return propertyDefs
    .filter((def) => MARKETING_API_ALLOWED_STANDARD_PROPERTIES.has(def.name) || isCustomProperty(def))
    .map((def) => def.name);
}

// CONFIRMED LIVE (from an actual migration run, via
// CampaignApiError.PROPERTY_SET_CONTAINS_VALUES_FORBIDDEN_FOR_WRITE): the
// properties object sent to POST/PATCH /marketing/v3/campaigns has its OWN,
// even narrower, write allowlist — separate from both the GET-side allowlist
// above and from modificationMetadata.readOnlyValue. Standard properties
// that live property metadata reports as writable (e.g. hs_owner,
// hs_color_hex, hs_goal) are still rejected here. Only these 9 standard
// properties, plus genuinely custom properties with readOnlyValue=false, are
// accepted on write — read directly from the live error body, not guessed.
const MARKETING_API_WRITE_ALLOWED_STANDARD_PROPERTIES = new Set([
  'hs_start_date', 'hs_end_date', 'hs_notes', 'hs_audience',
  'hs_currency_code', 'hs_campaign_status', 'hs_name', 'hs_utm', 'hs_business_unit_ids',
]);

// Standard properties that carry real campaign data but that NO public API
// can write: the Marketing API rejects them
// (PROPERTY_SET_CONTAINS_VALUES_FORBIDDEN_FOR_WRITE) and, CONFIRMED LIVE, the
// CRM Object API returns 400 "Object type CAMPAIGN is not supported by this
// endpoint" for PATCH. When the destination value differs from the source,
// each one is logged as MANUAL_PROPERTY with the exact value to set in the
// HubSpot UI (owners shown by email). AI-enriched, metadata and template
// fields are left out on purpose — HubSpot generates them.
const MANUAL_ONLY_PROPERTIES = new Set([
  'hs_color_hex', 'hs_goal', 'hs_goal_intention', 'hs_projected_budget', 'hs_revenue', 'hs_budget',
  'hs_new_contact_goal', 'hs_influenced_contact_goal', 'hs_influenced_closed_deal_goal', 'hs_session_goal',
  'hs_owner', 'hubspot_owner_id',
]);
const OWNER_PROPERTIES = new Set(['hs_owner', 'hubspot_owner_id']);

function isWritableViaMarketingApi(destDef) {
  // Allowlist first: it is the API's own statement of what it accepts and it
  // outranks modificationMetadata, which is wrong for hs_name and hs_utm
  // (both report readOnlyValue=true yet PATCH persists them — verified live
  // 2026-09-25). Checking metadata before the allowlist silently dropped
  // those two from every migrated campaign.
  if (MARKETING_API_WRITE_ALLOWED_STANDARD_PROPERTIES.has(destDef.name)) return true;
  if (!isWritableProperty(destDef)) return false;
  if (isCustomProperty(destDef)) return true; // genuinely custom — governed by readOnlyValue only, per the live error message
  return false;
}

// hs_start_date/hs_end_date are `datetime`-typed in the property schema (so
// the CRM Object API returns a full ISO datetime, e.g.
// "2026-05-06T00:00:00Z"), but confirmed live that the Marketing API's
// create/update endpoint rejects that with CampaignValidationError.
// INVALID_DATE_PROPERTY and requires a plain YYYY-MM-DD date.
const DATE_ONLY_PROPERTIES = new Set(['hs_start_date', 'hs_end_date']);

function toDateOnly(value) {
  if (typeof value !== 'string') return value;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : value;
}
const DEDUPE_PROPERTY_GROUP = 'campaigninformation'; // confirmed via GET /crm/v3/properties/campaigns/groups

// object types this script tries to associate CRM records for, and the
// property used as a "natural key" to match a source record to a
// destination one (these records have different ids per portal).
const CRM_ASSOCIATION_TARGETS = [
  { objectType: 'contacts', naturalKeyProperty: 'email' },
  { objectType: 'companies', naturalKeyProperty: 'domain' },
  { objectType: 'deals', naturalKeyProperty: 'dealname' },
  { objectType: 'tickets', naturalKeyProperty: 'subject' },
];

// Asset types this script can find in the destination portal, and how.
// `paged` = GET list endpoint with `after` paging; `lists` / `files` use
// their own search endpoints. Matching is by name (brand-prefix and
// case-insensitive); files also match by folder path. Workflows are matched
// by source ID through workflow_id_mapping.json first (written by
// migrate-hubspot-workflows.js), then by name. Any OTHER asset type (e.g.
// SOCIAL_BROADCAST, which has no public API to recreate posts) is logged for
// manual review rather than guessed at.
const ASSET_TYPE_SOURCES = {
  MARKETING_EMAIL: { kind: 'paged', path: '/marketing/v3/emails' },
  FORM: { kind: 'paged', path: '/marketing/v3/forms' },
  LANDING_PAGE: { kind: 'paged', path: '/cms/v3/pages/landing-pages' },
  SITE_PAGE: { kind: 'paged', path: '/cms/v3/pages/site-pages' },
  BLOG_POST: { kind: 'paged', path: '/cms/v3/blogs/posts' },
  AUTOMATION_PLATFORM_FLOW: { kind: 'paged', path: '/automation/v4/flows' },
  OBJECT_LIST: { kind: 'lists' },
  FILE_MANAGER_FILE: { kind: 'files' },
};

const WORKFLOW_ID_MAPPING_PATH = path.join(process.cwd(), 'workflow_id_mapping.json');

// ---------------------------------------------------------------------------
// The 32 campaigns to migrate — exact (case-sensitive) name match only.
// ---------------------------------------------------------------------------

const CAMPAIGN_NAMES = [
  'Survey-Tier-2-Math-FY26',
  'State-Indiana-FY26',
  'Conference | CON_KS_2026.07_KASA_CY26',
  'BTS-2026-2027',
  'State | Georgia Tier 2 | FY26',
  'TM Funding',
  'NYC District 75 Info Request',
  'FOC_Webinar_Q2026',
  'TAW2026',
  'TouchMath K-5 Sampler 2026',
  'Webinar Grades 3-5 5.7.26',
  'Grades 3-5 Sample',
  'Curriculum Bridges 2026',
  '95 Percent Group-Announcement-FY26',
  'TouchMath Curriculum Bridges',
  'Extend - 2026',
  'Dyscalculia 2026',
  'TCASE 2026',
  'Grades 3-5 Launch',
  'Winter Fun Sheets 2025',
  'National Conferences',
  'Fall Catalog 2025',
  'Workshop - 09.23.25',
  'AI Purchasing Guide 2025',
  'Regional Conferences',
  'Newsletter',
  'MyTouchMath Fall 2025 Updates',
  'Heartland',
  'Summer Workbooks 2025',
  'Texas',
  'Florida',
  'Extend - 2025 Promo',
  'Website Forms - Fun Sheets Sign Up',
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

function writeJsonFileAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Brand-prefix-insensitive key for matching a destination campaign to its
 * source by name. Campaigns created by earlier runs used other prefix
 * spellings ("Touchmath | ", "Touchmath | ", "TouchMath | "), so every
 * variant must resolve to the same key. This is what makes changing
 * CONFIG.namePrefix safe: an existing campaign is still recognised under its
 * old prefix and gets renamed, rather than being missed and re-created.
 */
function campaignNameKey(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^touchmath\s*[-|]\s*/, '');
}

function buildDestinationName(sourceName) {
  if (typeof sourceName !== 'string') return sourceName;
  return sourceName.startsWith(CONFIG.namePrefix) ? sourceName : `${CONFIG.namePrefix}${sourceName}`;
}

// ---------------------------------------------------------------------------
// HTTP layer — retries 429/5xx with exponential backoff, respects
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

// ---------------------------------------------------------------------------
// Properties API
// ---------------------------------------------------------------------------

/** getSourcePropertyDefinitions — fetches live property definitions (name, type, read-only metadata) for the campaigns object. */
async function getPropertyDefinitions(token, label) {
  const resp = await hubspotRequest(token, label, 'GET', PROPERTIES_PATH);
  return (resp && resp.results) || [];
}

function isWritableProperty(propDef) {
  return !(propDef.modificationMetadata && propDef.modificationMetadata.readOnlyValue) && propDef.name !== 'hs_object_id';
}

async function ensureDedupePropertyExists(destToken, destPropertyDefs) {
  const existing = destPropertyDefs.find((p) => p.name === CONFIG.dedupePropertyName);
  if (existing) return existing;

  if (CONFIG.dryRun) {
    console.log(`[dry-run] Would create custom property "${CONFIG.dedupePropertyName}" on the destination campaigns object (group: ${DEDUPE_PROPERTY_GROUP}).`);
    return null;
  }

  console.log(`[info] Creating dedupe property "${CONFIG.dedupePropertyName}" on the destination campaigns object...`);
  const created = await hubspotRequest(destToken, 'destination', 'POST', PROPERTIES_PATH, {
    name: CONFIG.dedupePropertyName,
    label: 'Source Campaign ID',
    type: 'string',
    fieldType: 'text',
    groupName: DEDUPE_PROPERTY_GROUP,
    description: 'Source-portal campaign hs_object_id. Used by migrate-campaigns.js to detect an already-migrated campaign and prevent duplicates on rerun. Do not edit manually.',
  });
  console.log(`[info] Created "${CONFIG.dedupePropertyName}".`);
  return created;
}

// ---------------------------------------------------------------------------
// Campaigns API
// ---------------------------------------------------------------------------

async function listAllCampaigns(token, label, propertyNames) {
  const all = [];
  let after;
  const propsQuery = propertyNames.join(',');
  do {
    const query = new URLSearchParams({ limit: '100', properties: propsQuery });
    if (after) query.set('after', after);
    const page = await hubspotRequest(token, label, 'GET', `${CAMPAIGNS_PATH}?${query.toString()}`);
    const results = (page && Array.isArray(page.results)) ? page.results : [];
    all.push(...results);
    after = page && page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : undefined;
  } while (after);
  return all;
}

async function getCampaignByGuid(token, label, guid, propertyNames) {
  const query = new URLSearchParams({ properties: propertyNames.join(',') });
  return hubspotRequest(token, label, 'GET', `${CAMPAIGNS_PATH}/${guid}?${query.toString()}`);
}

/** Full-fidelity property read via the standard CRM Object API (numeric id) — accepts every property, unlike the Marketing API's restricted `properties=` allowlist. Does not include `assets` (a Marketing-API-only field). */
async function getFullCampaignByObjectId(token, label, objectId, propertyNames) {
  const query = new URLSearchParams({ properties: propertyNames.join(',') });
  return hubspotRequest(token, label, 'GET', `${CRM_OBJECT_PATH}/${objectId}?${query.toString()}`);
}

/** Last-line duplicate guard: CRM search for a destination campaign already stamped with this source id. */
async function findDestinationCampaignByDedupeId(token, sourceObjectId) {
  const resp = await hubspotRequest(token, 'destination', 'POST', `${CRM_OBJECT_PATH}/search`, {
    filterGroups: [{ filters: [{ propertyName: CONFIG.dedupePropertyName, operator: 'EQ', value: String(sourceObjectId) }] }],
    properties: ['hs_name', 'hs_object_id', CONFIG.dedupePropertyName],
    limit: 10,
  });
  return (resp && resp.results) || [];
}

async function createCampaign(token, label, properties) {
  return hubspotRequest(token, label, 'POST', CAMPAIGNS_PATH, { properties });
}

async function updateCampaign(token, label, guid, properties) {
  return hubspotRequest(token, label, 'PATCH', `${CAMPAIGNS_PATH}/${guid}`, { properties });
}

async function addCampaignAsset(token, label, guid, assetType, assetId) {
  return hubspotRequest(token, label, 'PUT', `${CAMPAIGNS_PATH}/${guid}/assets/${assetType}/${assetId}`);
}

// ---------------------------------------------------------------------------
// CRM Associations v4 (campaigns <-> contacts/companies/deals/tickets),
// using the campaign's numeric hs_object_id — NOT the marketing-API GUID.
// Pattern proven elsewhere in this project (hubspot-associations-common.js).
// ---------------------------------------------------------------------------

/** fetchCampaignAssociations — reads which records of `toObjectType` are associated with a campaign (by hs_object_id). Returns []. on "no associations" rather than throwing. */
async function fetchCampaignAssociations(token, label, campaignObjectId, toObjectType) {
  const resp = await hubspotRequest(token, label, 'POST', `/crm/v4/associations/${OBJECT_TYPE}/${toObjectType}/batch/read`, {
    inputs: [{ id: campaignObjectId }],
  });
  const results = (resp && resp.results) || [];
  if (results.length > 0) {
    return (results[0].to || []).map((t) => String(t.toObjectId));
  }
  const errors = (resp && resp.errors) || [];
  const noneFound = errors.some((e) => e.subCategory === 'crm.associations.NO_ASSOCIATIONS_FOUND' || e.category === 'OBJECT_NOT_FOUND');
  if (noneFound) return [];
  if (errors.length > 0) {
    throw new HubSpotApiError(`Unexpected error reading ${OBJECT_TYPE}->${toObjectType} associations for campaign ${campaignObjectId}: ${JSON.stringify(errors)}`, {});
  }
  return [];
}

const associationLabelCache = new Map();

async function getDefaultAssociationTypeId(token, label, toObjectType) {
  const cacheKey = `${label}:${toObjectType}`;
  if (associationLabelCache.has(cacheKey)) return associationLabelCache.get(cacheKey);
  const resp = await hubspotRequest(token, label, 'GET', `/crm/v4/associations/${OBJECT_TYPE}/${toObjectType}/labels`);
  const results = (resp && resp.results) || [];
  const defaultType = results.find((r) => r.category === 'HUBSPOT_DEFINED') || results[0];
  if (!defaultType) throw new Error(`No association type found between ${OBJECT_TYPE} and ${toObjectType}`);
  const value = { category: defaultType.category, typeId: defaultType.typeId };
  associationLabelCache.set(cacheKey, value);
  return value;
}

async function createCampaignAssociation(destToken, campaignObjectId, toObjectType, toObjectId) {
  const type = await getDefaultAssociationTypeId(destToken, 'destination', toObjectType);
  return hubspotRequest(destToken, 'destination', 'PUT', `/crm/v4/objects/${OBJECT_TYPE}/${campaignObjectId}/associations/${toObjectType}/${toObjectId}`, [
    { associationCategory: type.category, associationTypeId: type.typeId },
  ]);
}

/** Batch-reads one natural-key property for a set of record ids of one CRM object type. Returns Map<id, value>. */
async function batchReadNaturalKeys(token, label, objectType, ids, naturalKeyProperty) {
  const map = new Map();
  if (ids.length === 0) return map;
  const resp = await hubspotRequest(token, label, 'POST', `/crm/v3/objects/${objectType}/batch/read`, {
    inputs: ids.map((id) => ({ id })),
    properties: [naturalKeyProperty],
  });
  for (const r of (resp && resp.results) || []) {
    map.set(String(r.id), r.properties ? r.properties[naturalKeyProperty] : undefined);
  }
  return map;
}

/** Finds a destination record of `objectType` whose `naturalKeyProperty` exactly equals `value`. Returns {status, id}. */
async function findDestinationRecordByNaturalKey(destToken, objectType, naturalKeyProperty, value) {
  if (value === undefined || value === null || value === '') {
    return { status: 'no_source_value' };
  }
  const resp = await hubspotRequest(destToken, 'destination', 'POST', `/crm/v3/objects/${objectType}/search`, {
    filterGroups: [{ filters: [{ propertyName: naturalKeyProperty, operator: 'EQ', value: String(value) }] }],
    properties: [naturalKeyProperty],
    limit: 2,
  });
  const results = (resp && resp.results) || [];
  if (results.length === 1) return { status: 'found', id: String(results[0].id) };
  if (results.length > 1) return { status: 'ambiguous', count: results.length };
  return { status: 'not_found' };
}

// ---------------------------------------------------------------------------
// Asset matching (see ASSET_TYPE_SOURCES).
// Other asset types encountered are logged for manual review, not guessed.
// ---------------------------------------------------------------------------

const destAssetIndexCache = new Map();

async function listPaged(token, label, listPath) {
  const all = [];
  let after;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    const page = await hubspotRequest(token, label, 'GET', `${listPath}?${query.toString()}`);
    all.push(...((page && Array.isArray(page.results)) ? page.results : []));
    after = page && page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : undefined;
  } while (after);
  return all;
}

async function listAllLists(token, label) {
  const all = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await hubspotRequest(token, label, 'POST', '/crm/v3/lists/search', { offset, count: 500 });
    all.push(...((page && page.lists) || []).map((l) => ({ id: String(l.listId), name: l.name })));
    hasMore = Boolean(page && page.hasMore);
    offset = page ? page.offset : 0;
  }
  return all;
}

const filePathKey = (value) => String(value || '').trim().toLowerCase().replace(/^\/+/, '');

/** Builds (once per type) a name-key -> [ids] index of destination assets. Returns null if the type isn't supported. */
async function getDestAssetIndex(destToken, assetType) {
  if (destAssetIndexCache.has(assetType)) return destAssetIndexCache.get(assetType);
  const source = ASSET_TYPE_SOURCES[assetType];
  if (!source) return null;

  let items;
  if (source.kind === 'lists') items = await listAllLists(destToken, 'destination');
  else if (source.kind === 'files') {
    items = (await listPaged(destToken, 'destination', '/files/v3/files/search'))
      .map((f) => ({ id: String(f.id), name: f.path || `${f.name}${f.extension ? `.${f.extension}` : ''}` }));
  } else items = await listPaged(destToken, 'destination', source.path);

  const index = new Map();
  for (const item of items) {
    const key = source.kind === 'files' ? filePathKey(item.name) : campaignNameKey(item.name);
    if (!key) continue;
    index.set(key, [...(index.get(key) || []), String(item.id)]);
  }
  destAssetIndexCache.set(assetType, index);
  return index;
}

let workflowIdMapping = null;
function destinationWorkflowIdFor(sourceWorkflowId) {
  if (workflowIdMapping === null) {
    workflowIdMapping = new Map();
    try {
      for (const e of JSON.parse(fs.readFileSync(WORKFLOW_ID_MAPPING_PATH, 'utf8') || '[]')) {
        workflowIdMapping.set(String(e.sourceWorkflowId), String(e.destinationWorkflowId));
      }
    } catch {
      // No mapping file yet: fall back to name matching only.
    }
  }
  return workflowIdMapping.get(String(sourceWorkflowId)) || null;
}

/** Finds the destination counterpart of one source campaign asset. */
async function findDestinationAsset(destToken, assetType, asset) {
  if (assetType === 'AUTOMATION_PLATFORM_FLOW') {
    const mapped = destinationWorkflowIdFor(asset.id);
    if (mapped) return { status: 'found', id: mapped, matchedName: `workflow_id_mapping.json (${asset.id} -> ${mapped})` };
  }
  let index;
  try {
    index = await getDestAssetIndex(destToken, assetType);
  } catch (err) {
    return { status: 'lookup_failed', reason: `Could not list destination ${assetType} assets (${err.status ? `HTTP ${err.status}` : err.message}); check the destination private app's scopes.` };
  }
  if (!index) return { status: 'unsupported_type' };
  const key = assetType === 'FILE_MANAGER_FILE' ? filePathKey(asset.name) : campaignNameKey(asset.name);
  const candidates = index.get(key) || [];
  if (candidates.length === 1) return { status: 'found', id: candidates[0], matchedName: asset.name };
  if (candidates.length > 1) return { status: 'ambiguous', count: candidates.length, matchedName: asset.name };
  return { status: 'not_found' };
}

/**
 * CONFIRMED LIVE: the `assets` object embedded in GET /campaigns/{guid} holds
 * at most 50 assets per type (with a `paging.next` link) — a source campaign
 * with 125 marketing emails only embeds 50. Page through the per-type assets
 * endpoint whenever there's more, so nothing is silently left behind.
 */
async function fetchAllCampaignAssets(token, label, guid) {
  const campaign = await getCampaignByGuid(token, label, guid, ['hs_name']);
  const assets = {};
  for (const [assetType, group] of Object.entries((campaign && campaign.assets) || {})) {
    let items = [...((group && group.results) || [])];
    if (group && group.paging && group.paging.next) {
      items = await listPaged(token, label, `${CAMPAIGNS_PATH}/${guid}/assets/${assetType}`);
    }
    assets[assetType] = items;
  }
  return assets;
}

// ---------------------------------------------------------------------------
// Property payload building
// ---------------------------------------------------------------------------

/**
 * Builds the `properties` object to send on CREATE or UPDATE.
 *
 * Iterates SOURCE property definitions (not destination) so that every
 * value the source portal actually has is considered — including any
 * property that exists in the source schema but not (yet) in the
 * destination's, which is logged as `skippedUnsupported` rather than
 * silently dropped. Writability is then checked against the matching
 * DESTINATION property definition (a property can be writable in one
 * portal's schema and read-only/absent in the other).
 *
 * hs_name is create-only (see file header); the dedupe property is
 * (re)stamped whenever missing.
 */
function buildPropertiesPayload(sourceCampaign, sourcePropertyDefs, destPropertyDefsByName, { forCreate, needsDedupeStamp }) {
  const properties = {};
  const crmProperties = {};
  const skippedReadOnly = [];
  const skippedUnsupported = [];
  const sourceProps = sourceCampaign.properties || {};

  for (const srcDef of sourcePropertyDefs) {
    if (srcDef.name === CONFIG.dedupePropertyName) continue; // never present in the source schema; handled separately below

    // hs_name is a special case checked BEFORE the generic writability gate:
    // live property metadata reports readOnlyValue=true, which would make the
    // generic branch below skip it unconditionally, including on create.
    //
    // CORRECTION (verified live 2026-09-25, sandbox 47206776): that metadata
    // is WRONG. hs_name IS writable after create. Proven by renaming campaign
    // b9a65952-668c-4ba4-91eb-8a750e673482 from "Touchmath | TAW2026" to
    // "Touchmath | TAW2026" via PATCH /marketing/v3/campaigns/{guid} -> 200,
    // with a read-back confirming the new value persisted. hs_name is also
    // listed in the write allowlist the API itself returns on a rejected
    // write. The previous "immutable after create" assumption left campaigns
    // stuck on whatever prefix the first run happened to use.
    //
    // It is therefore sent on update too, so a change to CONFIG.namePrefix
    // re-normalises existing campaigns instead of stranding them. This cannot
    // create duplicates: matching happens on the dedupe property
    // (source_campaign_id) and prefix-insensitive name keys, never on the
    // exact current name — see campaignNameKey().
    if (srcDef.name === 'hs_name') {
      properties.hs_name = buildDestinationName(sourceProps.hs_name);
      continue;
    }

    const hasValue = srcDef.name in sourceProps && sourceProps[srcDef.name] !== null && sourceProps[srcDef.name] !== undefined && sourceProps[srcDef.name] !== '';

    const destDef = destPropertyDefsByName.get(srcDef.name);
    if (!destDef) {
      if (hasValue) skippedUnsupported.push({ field: srcDef.name, sourceValue: sourceProps[srcDef.name], reason: 'property does not exist in the destination portal\'s campaigns schema' });
      continue;
    }
    // The API's OWN write allowlist outranks modificationMetadata, which is
    // demonstrably wrong for some standard properties. CONFIRMED LIVE
    // 2026-09-25 in sandbox 47206776: both hs_name and hs_utm report
    // readOnlyValue=true yet PATCH accepts them and the value persists on
    // read-back. hs_utm carries real data on ALL 93 source campaigns, so
    // trusting the metadata silently dropped it from every migrated campaign.
    // If a property is on the write allowlist, it is writable — full stop.
    // hs_utm is portal-derived: HubSpot generates it as "<campaignId>-<name>",
    // so the source value embeds the SOURCE campaign's numeric id. Copying it
    // makes tracking links that already carry the source UTM attribute to the
    // migrated campaign (what "100% replica" implies), at the cost of the
    // destination campaign no longer matching the UTM HubSpot would generate
    // for it. Set MIGRATE_UTM=false to leave HubSpot's own value in place.
    if (srcDef.name === 'hs_utm' && !MIGRATE_UTM) {
      if (srcDef.name in sourceProps && sourceProps[srcDef.name]) {
        skippedReadOnly.push({ field: 'hs_utm', sourceValue: sourceProps.hs_utm, reason: 'MIGRATE_UTM=false — left as the destination portal\'s own generated UTM value' });
      }
      continue;
    }

    const onWriteAllowlist = MARKETING_API_WRITE_ALLOWED_STANDARD_PROPERTIES.has(srcDef.name);
    if (!onWriteAllowlist && !isWritableProperty(destDef)) {
      if (hasValue) skippedReadOnly.push({ field: srcDef.name, sourceValue: sourceProps[srcDef.name], reason: 'read-only per live destination property metadata (modificationMetadata.readOnlyValue=true)' });
      continue;
    }
    if (!isWritableViaMarketingApi(destDef)) {
      if (MANUAL_ONLY_PROPERTIES.has(srcDef.name)) {
        if (hasValue) crmProperties[srcDef.name] = sourceProps[srcDef.name];
        continue;
      }
      if (hasValue) skippedReadOnly.push({ field: srcDef.name, sourceValue: sourceProps[srcDef.name], reason: 'writable per property metadata, but rejected by the Marketing API\'s create/update endpoint specifically (CampaignApiError.PROPERTY_SET_CONTAINS_VALUES_FORBIDDEN_FOR_WRITE) — confirmed live, not a guess' });
      continue;
    }

    if (!hasValue) continue;
    properties[srcDef.name] = DATE_ONLY_PROPERTIES.has(srcDef.name) ? toDateOnly(sourceProps[srcDef.name]) : sourceProps[srcDef.name];
  }

  if (forCreate || needsDedupeStamp) {
    properties[CONFIG.dedupePropertyName] = String(sourceProps.hs_object_id);
  }

  return { properties, crmProperties, skippedReadOnly, skippedUnsupported };
}

// ---------------------------------------------------------------------------
// Owners (portal-specific IDs, matched by email)
// ---------------------------------------------------------------------------

async function listOwners(token, label) {
  return listPaged(token, label, '/crm/v3/owners');
}

/** Maps a source owner value (owner id or user id) to the destination owner with the same email, keeping the same id kind. */
function mapOwnerValue(value, ctx) {
  const v = String(value);
  const src = ctx.sourceOwners.find((o) => String(o.id) === v || String(o.userId) === v);
  if (!src || !src.email) return { mapped: false };
  const dest = ctx.destOwners.find((o) => o.email && o.email.toLowerCase() === src.email.toLowerCase());
  if (!dest) return { mapped: false, email: src.email };
  return { mapped: true, value: String(String(src.id) === v ? dest.id : dest.userId), email: src.email };
}

/** Lists manual-only property values that differ between source and destination, as issues a human can act on. */
function reportManualProperties(manualProperties, destProps, ctx) {
  const issues = [];
  for (const [name, value] of Object.entries(manualProperties)) {
    let expected = value;
    let display = value;
    if (OWNER_PROPERTIES.has(name)) {
      const owner = mapOwnerValue(value, ctx);
      if (!owner.mapped) {
        issues.push({ kind: 'OWNER_NOT_MAPPED', field: name, sourceValue: value, reason: owner.email
          ? `Source owner ${owner.email} has no matching owner (same email) in the destination portal.`
          : `Source owner ${value} could not be resolved to an email.` });
        continue;
      }
      expected = owner.value;
      display = owner.email;
    }
    if (Object.keys(diffAgainstDestination({ [name]: expected }, destProps)).length === 0) continue;
    issues.push({ kind: 'MANUAL_PROPERTY', field: name, sourceValue: value, setTo: display,
      reason: `"${name}" can't be written by HubSpot's API for campaigns; set it manually in the destination campaign to: ${display}` });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Budget and spend line items
// ---------------------------------------------------------------------------

/**
 * CONFIRMED LIVE: GET /marketing/v3/campaigns/{guid}/budget/totals returns
 * every budget AND spend line item ({budgetItems, spendItems}), so they can
 * be enumerated after all. Items missing in the destination (matched by
 * name + amount) are created; existing ones are left alone.
 */
async function syncBudgetAndSpend(sourceGuid, destGuid, ctx) {
  const results = { created: 0, alreadyPresent: 0, issues: [] };
  const [src, dest] = await Promise.all([
    hubspotRequest(ctx.sourceToken, 'source', 'GET', `${CAMPAIGNS_PATH}/${sourceGuid}/budget/totals`),
    destGuid ? hubspotRequest(ctx.destToken, 'destination', 'GET', `${CAMPAIGNS_PATH}/${destGuid}/budget/totals`) : null,
  ]);
  const itemKey = (i) => `${String(i.name || '').trim().toLowerCase()}|${Number(i.amount)}`;

  for (const [listKey, endpoint] of [['budgetItems', 'budget'], ['spendItems', 'spend']]) {
    const existing = new Set(((dest && dest[listKey]) || []).map(itemKey));
    for (const item of (src && src[listKey]) || []) {
      if (existing.has(itemKey(item))) {
        results.alreadyPresent += 1;
        continue;
      }
      if (ctx.dryRun) {
        results.issues.push({ kind: 'DRY_RUN', reason: `[DRY RUN] Would create ${endpoint} item "${item.name}" (${item.amount}).` });
        continue;
      }
      try {
        await hubspotRequest(ctx.destToken, 'destination', 'POST', `${CAMPAIGNS_PATH}/${destGuid}/${endpoint}`, {
          name: item.name, amount: item.amount, order: item.order, description: item.description,
        });
        existing.add(itemKey(item));
        results.created += 1;
      } catch (err) {
        results.issues.push({ kind: 'BUDGET_SPEND_CREATE_FAILED', item, httpStatus: err.status, apiResponse: err.body, reason: `Could not create ${endpoint} item "${item.name}": ${err.message}` });
      }
    }
  }
  return results;
}

/** Keeps only the payload fields whose value differs from the destination's current value. */
function diffAgainstDestination(payload, destProps) {
  const changed = {};
  for (const [name, value] of Object.entries(payload)) {
    const current = destProps ? destProps[name] : undefined;
    const normalize = (v) => (v === null || v === undefined ? '' : String(DATE_ONLY_PROPERTIES.has(name) ? toDateOnly(v) : v));
    if (normalize(value) !== normalize(current)) changed[name] = value;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const successEntries = [];
const errorEntries = [];

function writeLogs() {
  writeJsonFileAtomic(SUCCESS_LOG_PATH, successEntries);
  writeJsonFileAtomic(ERROR_LOG_PATH, errorEntries);
}

function logSuccess(entry) {
  successEntries.push({ timestamp: nowIso(), ...entry });
  writeLogs();
}

function logError(entry) {
  errorEntries.push({ timestamp: nowIso(), severity: entry.severity || 'ERROR', ...entry });
  writeLogs();
}

// ---------------------------------------------------------------------------
// Per-campaign migration
// ---------------------------------------------------------------------------

/** Numeric hs_object_id -> Marketing API GUID, using the destination campaigns already listed this run. */
async function resolveGuidForObjectId(ctx, objectId) {
  const hit = ctx.destinationCampaigns.find((c) => String(c.properties.hs_object_id) === String(objectId));
  return hit ? hit.id : null;
}

/** findOrCreateDestinationCampaign — dedupe-property match, then name-match "heal", then create. Returns { campaign, action, wasHealed }. */
async function findOrCreateDestinationCampaign(sourceCampaign, ctx) {
  const sourceObjectId = String(sourceCampaign.properties.hs_object_id);
  const expectedName = buildDestinationName(sourceCampaign.properties.hs_name);

  const byDedupe = ctx.destByDedupeId.get(sourceObjectId);
  if (byDedupe) {
    return { campaign: byDedupe, action: 'UPDATE', wasHealed: false };
  }

  const byNameCandidates = (ctx.destByName.get(campaignNameKey(expectedName)) || [])
    // A campaign already stamped for a DIFFERENT source campaign is not a match.
    .filter((c) => !c.properties[CONFIG.dedupePropertyName] || String(c.properties[CONFIG.dedupePropertyName]) === sourceObjectId);
  if (byNameCandidates.length === 1) {
    return { campaign: byNameCandidates[0], action: 'UPDATE', wasHealed: true };
  }
  if (byNameCandidates.length > 1) {
    return { status: 'ambiguous_name', count: byNameCandidates.length };
  }

  // Belt and braces: the list-based maps above could be incomplete (e.g. a
  // campaign created moments ago, or a list call missing a property), so
  // ask the CRM search API directly before creating anything.
  const alreadyStamped = await findDestinationCampaignByDedupeId(ctx.destToken, sourceObjectId);
  if (alreadyStamped.length > 1) {
    return { status: 'ambiguous_dedupe', count: alreadyStamped.length };
  }
  if (alreadyStamped.length === 1) {
    const guid = await resolveGuidForObjectId(ctx, alreadyStamped[0].id);
    if (!guid) return { status: 'ambiguous_dedupe', count: 1 };
    const campaign = await getCampaignByGuid(ctx.destToken, 'destination', guid, ctx.destMarketingListProps);
    return { campaign, action: 'UPDATE', wasHealed: false };
  }

  if (ctx.dryRun) {
    return { action: 'CREATE', dryRun: true };
  }

  const { properties, crmProperties, skippedReadOnly, skippedUnsupported } = buildPropertiesPayload(sourceCampaign, ctx.sourcePropertyDefs, ctx.destPropertyDefsByName, { forCreate: true });
  const created = await createCampaign(ctx.destToken, 'destination', properties);
  return { campaign: created, action: 'CREATE', wasHealed: false, crmProperties, skippedReadOnly, skippedUnsupported };
}

/** syncAssets — links the destination counterpart of every source campaign asset; logs anything it can't confidently match. `existingDestAssets` is { type: [{id,name}] }. */
async function syncAssets(sourceCampaign, destCampaignGuid, existingDestAssets, ctx) {
  const results = { linked: 0, alreadyLinked: 0, issues: [] };

  for (const [assetType, items] of Object.entries(sourceCampaign.assets || {})) {
    const alreadyLinkedIds = new Set((existingDestAssets[assetType] || []).map((a) => String(a.id)));
    for (const asset of items) {
      const match = await findDestinationAsset(ctx.destToken, assetType, asset);
      if (match.status === 'found') {
        if (alreadyLinkedIds.has(match.id)) {
          results.alreadyLinked += 1;
          continue;
        }
        if (ctx.dryRun) {
          results.issues.push({ kind: 'DRY_RUN', assetType, assetName: asset.name, reason: `[DRY RUN] Would link destination ${assetType} ${match.id} (${match.matchedName}).` });
          continue;
        }
        try {
          await addCampaignAsset(ctx.destToken, 'destination', destCampaignGuid, assetType, match.id);
          alreadyLinkedIds.add(match.id);
          results.linked += 1;
        } catch (err) {
          results.issues.push({ kind: 'ASSET_LINK_FAILED', assetType, assetName: asset.name, assetId: asset.id, destinationAssetId: match.id, httpStatus: err.status, apiResponse: err.body, reason: `Could not link destination ${assetType} ${match.id}: ${err.message}` });
        }
      } else if (match.status === 'unsupported_type') {
        results.issues.push({ kind: 'UNSUPPORTED_ASSET_TYPE', assetType, assetName: asset.name, assetId: asset.id, reason: assetType === 'SOCIAL_BROADCAST'
          ? 'Social posts cannot be recreated or looked up through HubSpot\'s public API; recreate/attach them manually in the destination campaign if needed.'
          : `No destination lookup is wired up for asset type "${assetType}". Link this asset to the destination campaign manually.` });
      } else if (match.status === 'lookup_failed') {
        results.issues.push({ kind: 'ASSET_LOOKUP_FAILED', assetType, assetName: asset.name, assetId: asset.id, reason: match.reason });
      } else if (match.status === 'ambiguous') {
        results.issues.push({ kind: 'ASSET_MATCH_AMBIGUOUS', assetType, assetName: asset.name, assetId: asset.id, reason: `${match.count} destination ${assetType} records match "${match.matchedName}"; cannot confidently pick one.` });
      } else {
        results.issues.push({ kind: 'ASSET_MATCH_NOT_FOUND', assetType, assetName: asset.name, assetId: asset.id, reason: `No destination ${assetType} matches "${asset.name}" (with or without the brand prefix). It likely hasn't been migrated to the destination portal yet.` });
      }
    }
  }
  return results;
}

/** syncAssociations — re-links contacts/companies/deals/tickets by natural key; logs anything it can't confidently match. */
async function syncAssociations(sourceCampaign, destCampaignObjectId, ctx) {
  const results = { linked: 0, alreadyLinked: 0, issues: [] };
  const sourceObjectId = String(sourceCampaign.properties.hs_object_id);

  for (const target of CRM_ASSOCIATION_TARGETS) {
    let sourceIds;
    try {
      sourceIds = await fetchCampaignAssociations(ctx.sourceToken, 'source', sourceObjectId, target.objectType);
    } catch (err) {
      results.issues.push({ kind: 'ASSOCIATION_READ_FAILED', objectType: target.objectType, reason: err.message });
      continue;
    }
    if (sourceIds.length === 0) continue;

    const naturalKeys = await batchReadNaturalKeys(ctx.sourceToken, 'source', target.objectType, sourceIds, target.naturalKeyProperty);

    let existingDestIds = new Set();
    if (destCampaignObjectId) {
      try {
        existingDestIds = new Set(await fetchCampaignAssociations(ctx.destToken, 'destination', destCampaignObjectId, target.objectType));
      } catch (err) {
        results.issues.push({ kind: 'ASSOCIATION_READ_FAILED', objectType: target.objectType, reason: `Could not read existing destination associations: ${err.message}` });
      }
    }

    for (const sourceId of sourceIds) {
      const naturalKeyValue = naturalKeys.get(sourceId);
      if (naturalKeyValue === undefined || naturalKeyValue === null || naturalKeyValue === '') {
        results.issues.push({ kind: 'ASSOCIATION_NO_NATURAL_KEY', objectType: target.objectType, sourceRecordId: sourceId, reason: `Source ${target.objectType} ${sourceId} has no value for "${target.naturalKeyProperty}" — cannot match it to a destination record confidently.` });
        continue;
      }

      const match = await findDestinationRecordByNaturalKey(ctx.destToken, target.objectType, target.naturalKeyProperty, naturalKeyValue);
      if (match.status === 'found') {
        if (existingDestIds.has(match.id)) {
          results.alreadyLinked += 1;
          continue;
        }
        if (ctx.dryRun) {
          results.issues.push({ kind: 'DRY_RUN', objectType: target.objectType, sourceRecordId: sourceId, reason: `[DRY RUN] Would associate destination ${target.objectType} ${match.id} (matched by ${target.naturalKeyProperty}="${naturalKeyValue}").` });
          continue;
        }
        await createCampaignAssociation(ctx.destToken, destCampaignObjectId, target.objectType, match.id);
        results.linked += 1;
      } else if (match.status === 'ambiguous') {
        results.issues.push({ kind: 'ASSOCIATION_MATCH_AMBIGUOUS', objectType: target.objectType, sourceRecordId: sourceId, naturalKeyProperty: target.naturalKeyProperty, naturalKeyValue, reason: `${match.count} destination ${target.objectType} records share ${target.naturalKeyProperty}="${naturalKeyValue}"; cannot confidently pick one.` });
      } else if (match.status === 'not_found') {
        results.issues.push({ kind: 'ASSOCIATION_MATCH_NOT_FOUND', objectType: target.objectType, sourceRecordId: sourceId, naturalKeyProperty: target.naturalKeyProperty, naturalKeyValue, reason: `No destination ${target.objectType} found with ${target.naturalKeyProperty}="${naturalKeyValue}". This record likely doesn't exist in the destination portal yet.` });
      }
    }
  }
  return results;
}

/**
 * The matched campaign summary comes from the Marketing API list, which only
 * carries the restricted property set (see MARKETING_API_ALLOWED_STANDARD_PROPERTIES).
 * Before building any payload, fetch the FULL property set via the
 * unrestricted CRM Object API, and the embedded `assets` via one Marketing
 * API get-by-guid call (assets aren't exposed by the CRM Object API).
 */
async function fetchFullSourceCampaign(sourceSummary, ctx) {
  const guid = sourceSummary.id;
  const objectId = String(sourceSummary.properties.hs_object_id);
  const [fullRecord, assets] = await Promise.all([
    getFullCampaignByObjectId(ctx.sourceToken, 'source', objectId, ctx.sourcePropertyNames),
    fetchAllCampaignAssets(ctx.sourceToken, 'source', guid),
  ]);

  const properties = { ...fullRecord.properties };

  // DATE OFF-BY-ONE FIX — CONFIRMED LIVE 2026-09-25.
  // hs_start_date/hs_end_date are datetime-typed. The CRM Object API returns
  // them in UTC, while the Marketing API returns the plain YYYY-MM-DD the
  // portal actually displays (rendered in the portal's timezone). For most
  // campaigns the stored time is portal-local midnight (04:00Z/05:00Z in
  // America/New_York) and truncating the UTC value happens to agree. But
  // campaigns stored at TRUE UTC midnight (00:00:00Z) render as the PREVIOUS
  // day locally, so truncating shifted them a day later on write — e.g.
  // FOC_Webinar_Q2026 reads 2026-05-05 from the Marketing API but
  // 2026-05-06T00:00:00Z from the CRM API, and was migrated as 2026-05-06.
  // The write endpoint expects a plain date, so use the Marketing API's
  // already-localised value, which is what a human sees in the campaign.
  for (const dateProp of DATE_ONLY_PROPERTIES) {
    const displayed = sourceSummary.properties?.[dateProp];
    if (typeof displayed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(displayed)) {
      properties[dateProp] = displayed;
    }
  }

  return { id: guid, properties, assets };
}

async function migrateOneCampaign(sourceSummary, ctx) {
  const startedAt = Date.now();
  const sourceName = sourceSummary.properties.hs_name;
  const sourceObjectId = String(sourceSummary.properties.hs_object_id);

  let sourceCampaign;
  try {
    sourceCampaign = await fetchFullSourceCampaign(sourceSummary, ctx);
  } catch (err) {
    logError({ campaignName: sourceName, sourceCampaignId: sourceObjectId, step: 'SOURCE_FETCH', httpStatus: err.status, apiResponse: err.body, message: err.message });
    return { status: 'FAILED' };
  }

  let resolved;
  try {
    resolved = await findOrCreateDestinationCampaign(sourceCampaign, ctx);
  } catch (err) {
    logError({ campaignName: sourceName, sourceCampaignId: sourceObjectId, step: 'FIND_OR_CREATE', httpStatus: err.status, apiResponse: err.body, message: err.message });
    return { status: 'FAILED' };
  }

  if (resolved.status === 'ambiguous_dedupe') {
    logError({ campaignName: sourceName, sourceCampaignId: sourceObjectId, step: 'FIND_OR_CREATE', message: `${resolved.count} destination campaign(s) already carry ${CONFIG.dedupePropertyName}=${sourceObjectId} but could not be resolved to a single campaign; not creating another.`, whatNeedsToBeDone: 'Delete the duplicate destination campaigns (keep one), then re-run.' });
    return { status: 'MANUAL_REVIEW_REQUIRED' };
  }

  if (resolved.status === 'ambiguous_name') {
    logError({ campaignName: sourceName, sourceCampaignId: sourceObjectId, step: 'FIND_OR_CREATE', message: `${resolved.count} destination campaigns are already named exactly "${buildDestinationName(sourceName)}"; cannot confidently pick one.`, whatNeedsToBeDone: `Manually identify the correct destination campaign, then set its "${CONFIG.dedupePropertyName}" property to ${sourceObjectId} so future runs resolve it via the dedupe property instead of by name.` });
    return { status: 'MANUAL_REVIEW_REQUIRED' };
  }

  if (ctx.dryRun) {
    const budgetNote = (sourceCampaign.properties.hs_budget_items_sum_amount || sourceCampaign.properties.hs_spend_items_sum_amount)
      ? ` Budget total: ${sourceCampaign.properties.hs_budget_items_sum_amount ?? 0}, spend total: ${sourceCampaign.properties.hs_spend_items_sum_amount ?? 0} (not auto-migrated — see file header; recreate manually if needed).`
      : '';
    if (resolved.action !== 'UPDATE') {
      console.log(`[DRY RUN] CREATE "${sourceName}" (source ${sourceObjectId}) -> "${buildDestinationName(sourceName)}"${budgetNote}`);
      logSuccess({ campaignName: sourceName, sourceCampaignId: sourceObjectId, destinationCampaignId: null, action: 'DRY_RUN_CREATE', note: budgetNote || undefined });
      return { status: 'DRY_RUN' };
    }

    // Existing destination campaign: preview exactly what a real run would
    // change (all reads, no writes).
    const dest = resolved.campaign;
    const destFullProps = await getFullCampaignByObjectId(ctx.destToken, 'destination', String(dest.properties.hs_object_id), ctx.destPropertyNames);
    const built = buildPropertiesPayload(sourceCampaign, ctx.sourcePropertyDefs, ctx.destPropertyDefsByName, { forCreate: false, needsDedupeStamp: resolved.wasHealed });
    const changed = diffAgainstDestination(built.properties, destFullProps.properties);
    const manualIssues = reportManualProperties(built.crmProperties, destFullProps.properties, ctx);
    const budgetPreview = await syncBudgetAndSpend(sourceCampaign.id, dest.id, ctx);
    const destAssets = await fetchAllCampaignAssets(ctx.destToken, 'destination', dest.id);
    const assetPreview = await syncAssets(sourceCampaign, dest.id, destAssets, ctx);
    const assocPreview = await syncAssociations(sourceCampaign, String(dest.properties.hs_object_id), ctx);
    const wouldLinkAssets = assetPreview.issues.filter((i) => i.kind === 'DRY_RUN').length;
    const wouldLinkAssocs = assocPreview.issues.filter((i) => i.kind === 'DRY_RUN').length;
    const problems = [...assetPreview.issues, ...assocPreview.issues, ...manualIssues, ...budgetPreview.issues].filter((i) => i.kind !== 'DRY_RUN');
    const wouldCreateBudget = budgetPreview.issues.filter((i) => i.kind === 'DRY_RUN').length;
    // Only report values a human could still set by hand; computed/read-only
    // rollups (counts, timestamps) are recalculated by HubSpot itself.
    const notReplicable = built.skippedReadOnly.filter((x) => x.reason.startsWith('writable per property metadata') && !/^hs_enriched_|^hs_last_interaction_timestamp$/.test(x.field));

    console.log(`[DRY RUN] UPDATE "${sourceName}" -> existing "${dest.properties.hs_name}" (${dest.id})` +
      ` | properties to change: ${Object.keys(changed).length ? Object.keys(changed).join(', ') : 'none'}` +
      ` | assets: ${assetPreview.alreadyLinked} linked, ${wouldLinkAssets} to link` +
      ` | CRM associations: ${assocPreview.alreadyLinked} linked, ${wouldLinkAssocs} to link` +
      ` | budget/spend items: ${budgetPreview.alreadyPresent} present, ${wouldCreateBudget} to create` +
      (problems.length ? ` | ${problems.length} issue(s)` : '') +
      (notReplicable.length ? ` | not writable via API: ${notReplicable.map((x) => x.field).join(', ')}` : '') + budgetNote);
    for (const issue of problems) {
      logError({ campaignName: sourceName, sourceCampaignId: sourceObjectId, destinationCampaignId: dest.id, step: issue.kind, severity: 'WARNING', message: issue.reason, details: issue });
    }
    logSuccess({ campaignName: sourceName, sourceCampaignId: sourceObjectId, destinationCampaignId: dest.id, action: 'DRY_RUN_UPDATE', propertiesToChange: changed, assetsToLink: wouldLinkAssets, associationsToLink: wouldLinkAssocs, issues: problems.length, notWritableViaApi: notReplicable, note: budgetNote || undefined });
    return { status: 'DRY_RUN' };
  }

  let destCampaign = resolved.campaign;
  const destGuid = destCampaign.id;

  // CONFIRMED LIVE 2026-09-25 (production 414445): POST /marketing/v3/campaigns
  // returns the campaign GUID but NOT hs_object_id, so on the CREATE path
  // destCampaign.properties.hs_object_id is undefined. That produced
  // `GET /crm/v3/objects/campaigns/undefined` on all 31 newly created
  // campaigns — breaking the manual-property report and the CRM association
  // sync, which both key off the numeric object id. Every sandbox run before
  // this was an UPDATE (the campaigns already existed, so hs_object_id came
  // back on the read), which is why it only appeared against production.
  // Fetch the numeric id explicitly whenever it is missing.
  let destObjectId = destCampaign.properties?.hs_object_id;
  if (destObjectId === undefined || destObjectId === null || destObjectId === '') {
    const reread = await getCampaignByGuid(ctx.destToken, 'destination', destGuid, ['hs_object_id', 'hs_name']);
    destObjectId = reread?.properties?.hs_object_id;
    if (destObjectId) {
      destCampaign = { ...destCampaign, properties: { ...destCampaign.properties, hs_object_id: destObjectId } };
    }
  }
  destObjectId = destObjectId === undefined || destObjectId === null ? null : String(destObjectId);

  // For an UPDATE (mapping-matched or name-healed), PATCH every writable
  // property (never hs_name) and stamp the dedupe property if this record
  // was healed (found by name, not previously linked). CREATE already sent
  // its full property payload inside findOrCreateDestinationCampaign, so
  // there's nothing further to build/send here for that path.
  let skippedUnsupported = resolved.skippedUnsupported || [];
  let crmPropertiesToWrite = resolved.crmProperties || {};
  if (resolved.action === 'UPDATE') {
    try {
      const built = buildPropertiesPayload(sourceCampaign, ctx.sourcePropertyDefs, ctx.destPropertyDefsByName, { forCreate: false, needsDedupeStamp: resolved.wasHealed });
      skippedUnsupported = built.skippedUnsupported;
      const destFullProps = await getFullCampaignByObjectId(ctx.destToken, 'destination', destObjectId, ctx.destPropertyNames);
      const changed = diffAgainstDestination(built.properties, destFullProps.properties);
      if (Object.keys(changed).length > 0) {
        await updateCampaign(ctx.destToken, 'destination', destGuid, changed);
      }
      crmPropertiesToWrite = built.crmProperties;
    } catch (err) {
      logError({ campaignName: sourceName, sourceCampaignId: sourceObjectId, destinationCampaignId: destGuid, step: 'UPDATE_PROPERTIES', httpStatus: err.status, apiResponse: err.body, message: err.message });
      return { status: 'FAILED' };
    }
  }
  if (skippedUnsupported.length > 0) {
    logError({ campaignName: sourceName, sourceCampaignId: sourceObjectId, destinationCampaignId: destGuid, step: 'PROPERTY_UNSUPPORTED_IN_DESTINATION', severity: 'WARNING', message: `${skippedUnsupported.length} source property value(s) could not be migrated because the property doesn't exist in the destination portal's campaigns schema.`, details: skippedUnsupported });
  }

  // Values no API can write: report the ones that differ for manual entry.
  const extraIssues = [];
  try {
    const destNow = await getFullCampaignByObjectId(ctx.destToken, 'destination', destObjectId, ctx.destPropertyNames);
    extraIssues.push(...reportManualProperties(crmPropertiesToWrite, destNow.properties, ctx));
  } catch (err) {
    extraIssues.push({ kind: 'MANUAL_PROPERTY_CHECK_FAILED', reason: err.message });
  }
  try {
    const budget = await syncBudgetAndSpend(sourceCampaign.id, destGuid, ctx);
    extraIssues.push(...budget.issues);
  } catch (err) {
    extraIssues.push({ kind: 'BUDGET_SPEND_SYNC_FAILED', httpStatus: err.status, reason: err.message });
  }

  // Re-fetch full destination campaign (with assets) after create/update so
  // syncAssets/syncAssociations see current, authoritative destination state.
  let destFull;
  try {
    destFull = await getCampaignByGuid(ctx.destToken, 'destination', destGuid, ctx.destMarketingListProps);
  } catch (err) {
    logError({ campaignName: sourceName, sourceCampaignId: sourceObjectId, destinationCampaignId: destGuid, step: 'VALIDATION', httpStatus: err.status, apiResponse: err.body, message: `Could not re-fetch destination campaign after ${resolved.action}: ${err.message}` });
    return { status: 'FAILED' };
  }

  let assetResults;
  try {
    assetResults = await syncAssets(sourceCampaign, destGuid, await fetchAllCampaignAssets(ctx.destToken, 'destination', destGuid), ctx);
  } catch (err) {
    assetResults = { linked: 0, alreadyLinked: 0, issues: [{ kind: 'ASSET_SYNC_FAILED', reason: err.message }] };
  }

  let associationResults;
  try {
    associationResults = await syncAssociations(sourceCampaign, destObjectId, ctx);
  } catch (err) {
    associationResults = { linked: 0, alreadyLinked: 0, issues: [{ kind: 'ASSOCIATION_SYNC_FAILED', reason: err.message }] };
  }

  const hardIssues = [...extraIssues, ...assetResults.issues, ...associationResults.issues].filter((i) => i.kind !== 'DRY_RUN');
  for (const issue of hardIssues) {
    logError({ campaignName: sourceName, sourceCampaignId: sourceObjectId, destinationCampaignId: destGuid, step: issue.kind, severity: 'WARNING', message: issue.reason, details: issue });
  }

  const budgetSpendNote = `Source budget/spend totals: budget=${sourceCampaign.properties.hs_budget_items_sum_amount ?? 0}, spend=${sourceCampaign.properties.hs_spend_items_sum_amount ?? 0} (line items synced via /budget/totals).`;

  const status = (hardIssues.length === 0 && skippedUnsupported.length === 0) ? 'FULL_SUCCESS' : 'PARTIAL';
  logSuccess({
    campaignName: sourceName,
    sourceCampaignId: sourceObjectId,
    destinationCampaignId: destGuid,
    destinationCampaignName: destFull.properties.hs_name,
    action: resolved.action,
    status,
    assetsLinked: assetResults.linked,
    assetsAlreadyLinked: assetResults.alreadyLinked,
    associationsLinked: associationResults.linked,
    associationsAlreadyLinked: associationResults.alreadyLinked,
    issuesLogged: hardIssues.length,
    unsupportedPropertiesCount: skippedUnsupported.length,
    budgetSpendNote,
    durationMs: Date.now() - startedAt,
  });

  console.log(`[${status === 'FULL_SUCCESS' ? 'ok' : 'warn'}] ${resolved.action} "${sourceName}" (source ${sourceObjectId} -> destination ${destGuid}) [${status}]${hardIssues.length ? ` ${hardIssues.length} issue(s) logged` : ''}`);
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

function isAuthError(err) {
  return err instanceof HubSpotApiError && (err.status === 401 || err.status === 403);
}

/** findMatchingCampaigns — exact-name match against CAMPAIGN_NAMES; flags source duplicate names for manual review rather than guessing. */
function findMatchingCampaigns(sourceCampaigns) {
  const byName = new Map();
  for (const c of sourceCampaigns) {
    const name = c.properties.hs_name;
    const arr = byName.get(name) || [];
    arr.push(c);
    byName.set(name, arr);
  }

  const matches = [];
  const notFound = [];
  const duplicates = [];
  for (const requestedName of CAMPAIGN_NAMES) {
    const candidates = byName.get(requestedName) || [];
    if (candidates.length === 0) notFound.push(requestedName);
    else if (candidates.length === 1) matches.push(candidates[0]);
    else duplicates.push({ name: requestedName, candidates });
  }
  return { matches, notFound, duplicates };
}

async function main() {
  console.log('HubSpot Marketing Campaigns Migration');
  console.log('======================================');
  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log(`Name prefix: "${CONFIG.namePrefix}"`);

  if (!CONFIG.sourceToken || !CONFIG.destToken) {
    console.error('[fatal] SOURCE_HUBSPOT_TOKEN and DEST_HUBSPOT_TOKEN (or DESTINATION_HUBSPOT_TOKEN) are both required.');
    process.exitCode = 1;
    return;
  }
  if (CONFIG.sourceToken === CONFIG.destToken) {
    console.error('[fatal] Source and destination tokens are identical. Refusing to run.');
    process.exitCode = 1;
    return;
  }

  const [sourcePortalId, destPortalId] = await Promise.all([
    fetchPortalId(CONFIG.sourceToken, 'source'),
    fetchPortalId(CONFIG.destToken, 'destination'),
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
    console.log('[info] Could not verify portal IDs — proceeding anyway.');
  }

  // Property definitions are fetched separately per portal (not shared) —
  // requesting a property name in `properties=` that doesn't exist in that
  // specific portal's schema is a hard HTTP 400 ("Forbidden properties"),
  // confirmed live. The dedupe property in particular only ever exists on
  // the destination (often not yet, on a first dry run) — reusing one
  // shared list across both portals would 400 on every single run.
  console.log('\n[info] Fetching campaign property definitions from both portals...');
  let sourcePropertyDefs;
  let destPropertyDefs;
  try {
    [sourcePropertyDefs, destPropertyDefs] = await Promise.all([
      getPropertyDefinitions(CONFIG.sourceToken, 'source'),
      getPropertyDefinitions(CONFIG.destToken, 'destination'),
    ]);
  } catch (err) {
    if (isAuthError(err)) {
      console.error(`[fatal] Auth/permission failure reading campaign properties (status ${err.status}). Verify both tokens have marketing.campaigns.read/write and properties scopes.`);
    } else {
      console.error(`[fatal] Could not read campaign properties: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  await ensureDedupePropertyExists(CONFIG.destToken, destPropertyDefs);
  if (!destPropertyDefs.some((p) => p.name === CONFIG.dedupePropertyName) && !CONFIG.dryRun) {
    destPropertyDefs = await getPropertyDefinitions(CONFIG.destToken, 'destination');
  }

  // destPropertyDefsByName drives in-memory writability classification in
  // buildPropertiesPayload — it may simulate the dedupe property's presence
  // during a dry run so the preview reflects what a real run would do. It is
  // never sent as an HTTP query param itself, so simulating an
  // not-yet-existing property here is safe.
  const destPropertyDefsByName = new Map(destPropertyDefs.map((p) => [p.name, p]));
  if (CONFIG.dryRun && !destPropertyDefsByName.has(CONFIG.dedupePropertyName)) {
    destPropertyDefsByName.set(CONFIG.dedupePropertyName, { name: CONFIG.dedupePropertyName, type: 'string', modificationMetadata: { readOnlyValue: false } });
  }

  // Full property-name lists (used only for the unrestricted CRM Object API
  // full-fidelity read of matched campaigns — see getFullCampaignByObjectId).
  const sourcePropertyNames = sourcePropertyDefs.map((p) => p.name);

  // Restricted lists safe for the Marketing API's `properties=` query param
  // (list/get-by-guid) — see MARKETING_API_ALLOWED_STANDARD_PROPERTIES above.
  const sourceMarketingListProps = computeMarketingApiAllowedPropertyNames(sourcePropertyDefs);
  const destMarketingListProps = computeMarketingApiAllowedPropertyNames(destPropertyDefs);

  console.log('[info] Fetching campaigns from the source portal...');
  let sourceCampaigns;
  try {
    sourceCampaigns = await listAllCampaigns(CONFIG.sourceToken, 'source', sourceMarketingListProps);
  } catch (err) {
    if (isAuthError(err)) {
      console.error(`[fatal] Auth/permission failure listing source campaigns (status ${err.status}). Verify SOURCE_HUBSPOT_TOKEN has marketing.campaigns.read.`);
    } else {
      console.error(`[fatal] Could not list source campaigns: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[info] Found ${sourceCampaigns.length} campaign(s) in the source portal.`);

  console.log('[info] Fetching campaigns from the destination portal (for dedupe/name matching)...');
  let destinationCampaigns;
  try {
    destinationCampaigns = await listAllCampaigns(CONFIG.destToken, 'destination', destMarketingListProps);
  } catch (err) {
    if (isAuthError(err)) {
      console.error(`[fatal] Auth/permission failure listing destination campaigns (status ${err.status}). Verify DEST_HUBSPOT_TOKEN has marketing.campaigns.read/write.`);
    } else {
      console.error(`[fatal] Could not list destination campaigns: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[info] Found ${destinationCampaigns.length} campaign(s) already in the destination portal.`);

  if (destPropertyDefs.some((p) => p.name === CONFIG.dedupePropertyName) && !destMarketingListProps.includes(CONFIG.dedupePropertyName)) {
    console.error(`[fatal] "${CONFIG.dedupePropertyName}" exists on the destination but is not being read from destination campaigns; refusing to run (duplicates would be created).`);
    process.exitCode = 1;
    return;
  }

  const destByDedupeId = new Map();
  const destByName = new Map();
  for (const c of destinationCampaigns) {
    const dedupeVal = c.properties[CONFIG.dedupePropertyName];
    if (dedupeVal) destByDedupeId.set(String(dedupeVal), c);
    const key = campaignNameKey(c.properties.hs_name);
    destByName.set(key, [...(destByName.get(key) || []), c]);
  }
  console.log(`[info] ${destByDedupeId.size} destination campaign(s) are already linked to a source campaign via "${CONFIG.dedupePropertyName}".`);

  const { matches, notFound, duplicates } = findMatchingCampaigns(sourceCampaigns);

  console.log('\nPre-migration summary');
  console.log('----------------------');
  console.log(`Requested campaigns: ${CAMPAIGN_NAMES.length}`);
  console.log(`Found: ${matches.length + duplicates.length}`);
  console.log(`Not found: ${notFound.length}`);
  console.log(`Duplicate-name matches: ${duplicates.length}`);
  console.log(`Ready for migration: ${matches.length}\n`);

  for (const name of notFound) {
    logError({ campaignName: name, sourceCampaignId: null, step: 'SOURCE_LIST', severity: 'WARNING', message: `No campaign in the source portal has the exact name "${name}". Likely a typo, or the campaign was renamed/deleted.` });
  }
  for (const dup of duplicates) {
    logError({
      campaignName: dup.name, sourceCampaignId: dup.candidates.map((c) => c.properties.hs_object_id).join(', '),
      step: 'SOURCE_LIST', severity: 'WARNING',
      message: `${dup.candidates.length} source campaigns share the exact name "${dup.name}". Exact-name matching cannot disambiguate them.`,
      whatNeedsToBeDone: 'Identify the correct source campaign id and migrate it directly (a one-off run targeting that id) instead of relying on name matching.',
    });
  }

  let sourceOwners = [];
  let destOwners = [];
  try {
    [sourceOwners, destOwners] = await Promise.all([listOwners(CONFIG.sourceToken, 'source'), listOwners(CONFIG.destToken, 'destination')]);
  } catch (err) {
    console.warn(`[warn] Could not list owners (${err.status ? `HTTP ${err.status}` : err.message}); campaign owner fields will not be migrated. Grant crm.objects.owners.read to both apps.`);
  }

  const ctx = {
    sourceOwners,
    destOwners,
    sourceToken: CONFIG.sourceToken,
    destToken: CONFIG.destToken,
    sourcePropertyDefs,
    sourcePropertyNames,
    destPropertyDefsByName,
    destMarketingListProps,
    destPropertyNames: destPropertyDefs.map((p) => p.name),
    destByDedupeId,
    destByName,
    destinationCampaigns,
    dryRun: CONFIG.dryRun,
  };

  const counters = { requested: CAMPAIGN_NAMES.length, found: matches.length + duplicates.length, notFound: notFound.length, migrated: 0, failed: 0, notFoundInSource: notFound.length, dryRun: 0, manualReview: duplicates.length };

  for (const sourceCampaign of matches) {
    let result;
    try {
      result = await migrateOneCampaign(sourceCampaign, ctx);
    } catch (err) {
      if (isAuthError(err)) {
        console.error(`[fatal] Auth/permission failure migrating "${sourceCampaign.properties.hs_name}" (status ${err.status}). Stopping the entire migration.`);
        break;
      }
      logError({ campaignName: sourceCampaign.properties.hs_name, sourceCampaignId: sourceCampaign.properties.hs_object_id, step: 'MIGRATION', message: err.message, stack: err.stack });
      result = { status: 'FAILED' };
    }

    if (result.status === 'FULL_SUCCESS' || result.status === 'PARTIAL') counters.migrated += 1;
    else if (result.status === 'FAILED') counters.failed += 1;
    else if (result.status === 'MANUAL_REVIEW_REQUIRED') counters.manualReview += 1;
    else if (result.status === 'DRY_RUN') counters.dryRun += 1;
  }

  writeLogs();

  console.log('\n========================================');
  console.log('MIGRATION SUMMARY');
  console.log('========================================');
  console.log(`Requested: ${counters.requested}`);
  console.log(`Found: ${counters.found}`);
  console.log(`Not found in source: ${counters.notFoundInSource}`);
  console.log(`Migrated: ${counters.migrated}`);
  console.log(`Failed: ${counters.failed}`);
  console.log(`Manual review: ${counters.manualReview}`);
  if (CONFIG.dryRun) console.log(`Dry run previewed: ${counters.dryRun}`);
  console.log('========================================');
  console.log(`\nSuccess log: ${SUCCESS_LOG_PATH}`);
  console.log(`Error log:   ${ERROR_LOG_PATH}`);
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
  buildPropertiesPayload,
  findMatchingCampaigns,
  isWritableProperty,
};
