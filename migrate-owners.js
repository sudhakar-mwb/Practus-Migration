#!/usr/bin/env node

/**
 * OWNER / CREATED-BY / UPDATED-BY MIGRATION
 * source HubSpot portal -> destination HubSpot portal
 * =============================================================================
 *
 * For assets previously copied from the source portal into the destination
 * portal under a name prefix (e.g. "Touchmath | <source name>"), this script
 * resolves THREE user associations per asset and migrates them where HubSpot
 * allows it:
 *
 *     1. owner      — the asset's owner
 *     2. createdBy  — the user who created the asset
 *     3. updatedBy  — the user who last updated the asset
 *
 * Asset types in scope: workflows, forms, campaigns, segment/active lists,
 * marketing emails.
 *
 * SOURCE-FIRST AND NON-DESTRUCTIVE BY DEFAULT: nothing is written to the
 * destination unless the source record, the source user, the mapping, the
 * destination record AND the destination owner have all been resolved and
 * validated, and DRY_RUN has been explicitly turned off. Only owner/audit
 * fields are ever touched — never a name, content, criteria, filter, action,
 * field, subject, sender or association.
 *
 * -----------------------------------------------------------------------------
 * CAPABILITY MATRIX — VERIFIED LIVE AGAINST BOTH PORTALS (source 46378923,
 * destination sandbox 47206776), not assumed from documentation.
 * -----------------------------------------------------------------------------
 *
 * WORKFLOW
 *   owner     : NO SUCH FIELD. GET /automation/v4/flows[/{id}] returns
 *               id, isEnabled, flowType, revisionId, name, description,
 *               createdAt, updatedAt, startActionId, nextAvailableActionId,
 *               actions, enrollmentCriteria, timeWindows, blockedDates,
 *               customProperties, dataSources, crmObjectCreationStatus,
 *               suppressionListIds, canEnrollFromSalesforce, type,
 *               objectTypeId. A recursive /owner/i scan finds nothing.
 *   createdBy : READABLE via the legacy GET /automation/v3/workflows list as
 *               creationSource.createdByUser.{userId,userEmail} (also
 *               originalAuthorUserId). The legacy list uses LEGACY workflow
 *               ids that do NOT match v4 flow ids (0 of 84 overlap), so this
 *               script joins the two on migrationStatus.flowId (84/84 carry
 *               it, 83 resolve to a live v4 flow).
 *   updatedBy : READABLE the same way via
 *               updateSource.updatedByUser.{userId,userEmail} /
 *               lastUpdatedByUserId.
 *   WRITABLE? : NO. PATCH /automation/v4/flows/{id} -> 405. PUT and PATCH
 *               /automation/v3/workflows/{id} -> 405. The only update method,
 *               PUT /automation/v4/flows/{id}, is a FULL-BODY REPLACE
 *               ("Some required fields were not set: [type, isEnabled,
 *               revisionId]") whose schema contains no owner/createdBy/
 *               updatedBy field at all — using it could only rewrite actions
 *               and enrollment settings, which is explicitly out of scope.
 *
 * FORM
 *   owner/createdBy/updatedBy : NO SUCH FIELDS. GET /marketing/v3/forms[/{id}]
 *               returns id, name, createdAt, updatedAt, archived, fieldGroups,
 *               configuration, displayOptions, legalConsentOptions, formType.
 *               The only /owner/i hit is configuration.notifyContactOwner, a
 *               BOOLEAN notification toggle. The legacy GET /forms/v2/forms
 *               exposes no author/user id either.
 *   WRITABLE? : Nothing to write.
 *
 * CAMPAIGN
 *   owner     : hs_owner — EXISTS and is populated (e.g. source campaign
 *               "TAW2026" -> 88495508). Documented as "the user id of the user
 *               that owns the campaign", i.e. a HUBSPOT USER ID rather than a
 *               CRM ownerId, so this script writes the destination owner's
 *               userId (see resolveWriteValue).
 *   createdBy : hs_created_by_user_id — readable (Marketing API or CRM read).
 *   updatedBy : hs_updated_by_user_id — readable ONLY through
 *               GET /crm/v3/objects/campaigns; the Marketing API rejects it in
 *               `properties=` with 400 "Forbidden properties". This script
 *               therefore enriches each campaign with a CRM object read,
 *               joined on hs_object_id.
 *   WRITABLE? : NO, for all three. Verified live:
 *               - PATCH /marketing/v3/campaigns {properties:{hs_owner}}
 *                 -> 400 "Forbidden properties: [hs_owner] ... Correct ones
 *                 are [hs_start_date, hs_end_date, hs_notes, hs_audience,
 *                 hs_currency_code, hs_campaign_status, hs_name, hs_utm,
 *                 hs_business_unit_ids]".
 *               - same 400 for hs_created_by_user_id.
 *               - PATCH /crm/v3/objects, /crm/v4/objects and
 *                 /crm/v3/objects/campaigns/batch/update -> 400 "Object type
 *                 CAMPAIGN is not supported by this endpoint".
 *               - PATCH /marketing/v3/campaigns with a TOP-LEVEL hs_owner ->
 *                 HTTP 200 but the value is SILENTLY DISCARDED (read-back
 *                 still null). A naive script would report success here; see
 *                 attemptCampaignOwnerUpdate(), which always re-reads.
 *               The CRM property schema agrees: hs_created_by_user_id and
 *               hs_updated_by_user_id are readOnlyValue=true.
 *
 * LIST
 *   owner     : NO SUCH FIELD. POST /crm/v3/lists/search and
 *               GET /crm/v3/lists/{id} return listId, listVersion, createdAt,
 *               updatedAt, filtersUpdatedAt, processingStatus, createdById,
 *               updatedById, processingType, objectTypeId, name, size,
 *               listPermissions, membershipSettings, additionalProperties.
 *               A recursive /owner/i scan finds nothing.
 *   createdBy : createdById — readable (a HubSpot user id).
 *   updatedBy : updatedById — readable (a HubSpot user id).
 *   WRITABLE? : NO. PATCH and PUT /crm/v3/lists/{listId} both -> 405 Method
 *               Not Allowed; the Lists API only exposes name/filter updates.
 *
 * MARKETING EMAIL
 *   owner     : NO SUCH FIELD (recursive /owner/i scan finds nothing).
 *   createdBy : createdById — readable (a HubSpot user id).
 *   updatedBy : updatedById — readable (publishedById/publishedByEmail also
 *               exist and are likewise audit-only).
 *   WRITABLE? : NO. These are platform-written audit fields, and in this
 *               portal PATCH /marketing/v3/emails/{id} cannot even resolve the
 *               migrated emails (404 with and without archived=true) — see the
 *               stale-index note below.
 *
 * NET EFFECT: no owner, createdBy or updatedBy field on any asset type in
 * scope can be written through the public HubSpot API today. Every one is
 * reported as UNSUPPORTED_OWNER_UPDATE — never faked. The script still runs
 * the complete source-first audit and writes a full JSON report, so the
 * intended user for every asset and every field is documented and can be
 * applied by hand — or automatically, the day HubSpot opens these fields up
 * (see ATTEMPT_UNSUPPORTED_UPDATES).
 *
 * -----------------------------------------------------------------------------
 * USER / OWNER MAPPING — three channels, in order
 * -----------------------------------------------------------------------------
 *   1. ownerIdMapping   source owner id -> destination owner id (configured
 *                       below). Source values that are user ids are first
 *                       resolved to their source owner record via the Owners
 *                       API (by ownerId, then by userId).
 *   2. EMAIL_MATCH      for source users that have NO owner record — common
 *                       for createdBy/updatedBy, e.g. source user 67684615
 *                       (emily.triplett@touchmath.com) is in the Users API but
 *                       not the Owners API — the source Users API
 *                       (GET /settings/v3/users, available on the source
 *                       token) supplies the email, which is matched against
 *                       the destination Owners API. Disable with
 *                       USER_EMAIL_FALLBACK=false.
 *                       NOTE: the destination token lacks settings.users.read
 *                       (403), so destination-side resolution always goes
 *                       through the Owners API.
 *   3. DEFAULT          DEFAULT_DESTINATION_OWNER_ID (89103420) when the
 *                       source value is missing, unmapped, or maps to an
 *                       unusable destination owner. Disable with
 *                       USE_DEFAULT_OWNER_FALLBACK=false to skip instead.
 * Every resolution records which channel produced it (mappingChannel).
 *
 * -----------------------------------------------------------------------------
 * DESTINATION NAME PREFIXES — VERIFIED LIVE
 * -----------------------------------------------------------------------------
 * The destination portal is NOT internally consistent, so an exact
 * "Touchmath | " match alone reports most assets as NOT_FOUND:
 *     workflows        -> "Touchmath | "   (25 flows)
 *     segment lists    -> "Touchmath | "   (16 lists)
 *     marketing emails -> "Touchmath | "   (per marketing-email-migration-map.json)
 *     campaigns        -> "Touchmath - "   (all 33 campaigns)
 *     forms            -> "Touchmath - "   (45 forms), with trailing spaces in
 *                        the source name trimmed, e.g.
 *                        "Curriculum Bridges - Reveal Math " ->
 *                        "Touchmath - Curriculum Bridges - Reveal Math"
 * Matching tries a small ordered list of EXACT candidate names
 * (DESTINATION_PREFIX, then DESTINATION_PREFIX_FALLBACKS, each with the raw
 * and trimmed source name), then a second pass on Unicode-NFC,
 * whitespace-collapsed whole names. Both passes are whole-name equality —
 * never fuzzy, never partial — and each row records which pass matched
 * (sourceMatchMode / destinationMatchMode).
 *
 * The normalised pass is needed because real names carry trailing and doubled
 * spaces the configured allowlists omit — VERIFIED LIVE: the source workflow
 * is actually "TouchMath Grades 3-5 Sampler | Sync to SF Campaign " and
 * "OD Webinar | Grades 3-5 | 5.7.26 |  Sync to SF Campaign " (two spaces), and
 * the source form is "Curriculum Bridges - Eureka Math² ".
 *
 * -----------------------------------------------------------------------------
 * MARKETING EMAIL LOOKUP CAVEAT — VERIFIED LIVE
 * -----------------------------------------------------------------------------
 * The destination GET /marketing/v3/emails index is STALE: 431 live + 317
 * archived emails, newest created 2025-03-27, and it does not contain the
 * emails migrated on 2026-09-23 under any archived flag or state filter. They
 * do exist — GET /marketing/v3/emails/{id}?archived=true returns them. So
 * email destination lookup uses two channels: the name index, and a fallback
 * through the project's marketing-email-migration-map.json, resolving each
 * mapped id by direct GET and ACCEPTING IT ONLY IF the returned name is an
 * exact destination candidate name.
 *
 * -----------------------------------------------------------------------------
 * REQUIRED ENV VARS
 *   SOURCE_HUBSPOT_TOKEN        (alias: SOURCE_HUBSPOT_ACCESS_TOKEN / SOURCE_ACCESS_TOKEN)
 *   DESTINATION_HUBSPOT_TOKEN   (alias: DESTINATION_HUBSPOT_ACCESS_TOKEN / DESTINATION_ACCESS_TOKEN)
 * Scopes — source: automation, forms, marketing.campaigns.read, crm.lists.read,
 *   marketing-email (read), crm.objects.owners.read, settings.users.read
 *   (optional, enables the email-match channel).
 * Destination: the same read scopes + crm.objects.owners.read (and
 *   marketing.campaigns.write only if ATTEMPT_UNSUPPORTED_UPDATES is used).
 *
 * OPTIONAL ENV VARS
 *   DRY_RUN                        "true" (default) | "false"
 *   FIELDS                         csv subset of owner,createdBy,updatedBy
 *   CONCURRENCY                    worker pool size, default 3
 *   ASSET_TYPES                    csv subset of workflow,form,campaign,list,marketing_email
 *   DESTINATION_PREFIX             default "Touchmath | "
 *   DESTINATION_PREFIX_FALLBACKS   csv, default "Touchmath - "
 *   DEFAULT_DESTINATION_OWNER_ID   default 89103420
 *   USE_DEFAULT_OWNER_FALLBACK     "true" (default) | "false"
 *   USER_EMAIL_FALLBACK            "true" (default) | "false"
 *   ALLOW_ARCHIVED_DESTINATION_OWNER "false" (default)
 *   ATTEMPT_UNSUPPORTED_UPDATES    "false" (default)
 *   EMAIL_ID_MAP_FILE              default ./marketing-email-migration-map.json
 *   OUTPUT_DIR                     default cwd
 *   HUBSPOT_API_BASE               default https://api.hubapi.com
 *   REQUEST_DELAY_MS               per-portal min gap between calls, default 120
 *   MAX_RETRIES                    429/5xx/network retries, default 5
 *   RETRY_BASE_DELAY_MS            backoff base, default 1000
 *   REQUEST_TIMEOUT_MS             per-request timeout, default 60000
 *
 * USAGE
 *   node --env-file=.env migrate-owners.js              # dry run (default)
 *   DRY_RUN=false node --env-file=.env migrate-owners.js
 *
 * OUTPUT
 *   owner-migration-report-YYYY-MM-DD-HH-mm-ss.json
 *   — one object per source record, each carrying a `fields` array with the
 *     owner / createdBy / updatedBy resolution and status.
 */

'use strict';

const fs = require('fs');
const path = require('path');

try {
  // The project already depends on dotenv; --env-file=.env works too.
  require('dotenv').config();
} catch {
  /* dotenv is optional */
}

// ===========================================================================
// Configuration
// ===========================================================================

function envStr(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|y|on)$/i.test(value.trim());
}

function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envList(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value
    .split(',')
    .map((entry) => entry.replace(/^"|"$/g, ''))
    .filter((entry) => entry !== '');
}

/** Safety switch. true = look everything up and report, write nothing. */
const DRY_RUN = envBool('DRY_RUN', true);

/** Which user associations to process. */
const PROCESS_FIELDS = envList('FIELDS', ['owner', 'createdBy', 'updatedBy']);

/** Worker pool size for per-record processing. */
const CONCURRENCY = Math.max(1, envInt('CONCURRENCY', 3));

const HUBSPOT_API_BASE = envStr('HUBSPOT_API_BASE', 'https://api.hubapi.com');
const REQUEST_DELAY_MS = envInt('REQUEST_DELAY_MS', 120);
const MAX_RETRIES = envInt('MAX_RETRIES', 5);
const RETRY_BASE_DELAY_MS = envInt('RETRY_BASE_DELAY_MS', 1000);
const REQUEST_TIMEOUT_MS = envInt('REQUEST_TIMEOUT_MS', 60000);
const OUTPUT_DIR = envStr('OUTPUT_DIR', process.cwd());

/** Prefix applied to destination asset names during the original migration. */
const DESTINATION_PREFIX = envStr('DESTINATION_PREFIX', 'Touchmath | ');
/** Additional exact prefixes actually observed in the destination portal. */
const DESTINATION_PREFIX_FALLBACKS = envList('DESTINATION_PREFIX_FALLBACKS', ['Touchmath - ']);

/** Fallback owner when the source has no user / no mapping entry exists. */
const DEFAULT_DESTINATION_OWNER_ID = envStr('DEFAULT_DESTINATION_OWNER_ID', '89103420');
const USE_DEFAULT_OWNER_FALLBACK = envBool('USE_DEFAULT_OWNER_FALLBACK', true);

/** Resolve source users with no owner record by email (source Users API). */
const USER_EMAIL_FALLBACK = envBool('USER_EMAIL_FALLBACK', true);

/** HubSpot refuses to assign deactivated (archived) owners. */
const ALLOW_ARCHIVED_DESTINATION_OWNER = envBool('ALLOW_ARCHIVED_DESTINATION_OWNER', false);

/**
 * When true, fields whose HubSpot API is read-only are still attempted (and
 * verified by read-back) instead of being reported as
 * UNSUPPORTED_OWNER_UPDATE. Off by default; see the capability matrix above.
 */
const ATTEMPT_UNSUPPORTED_UPDATES = envBool('ATTEMPT_UNSUPPORTED_UPDATES', false);

const EMAIL_ID_MAP_FILE = envStr(
  'EMAIL_ID_MAP_FILE',
  path.join(process.cwd(), 'marketing-email-migration-map.json'),
);

/**
 * Optional but strongly recommended for a live run: the script aborts if the
 * token resolves to a different portal than the one named here. Cheap
 * insurance against a mis-set .env pointing writes at the wrong portal.
 */
const EXPECTED_SOURCE_PORTAL_ID = envStr('EXPECTED_SOURCE_PORTAL_ID', null);
const EXPECTED_DESTINATION_PORTAL_ID = envStr('EXPECTED_DESTINATION_PORTAL_ID', null);

// ===========================================================================
// Owner mapping
// ===========================================================================

/** source owner id -> destination owner id. All ids treated as strings. */
const ownerIdMapping = {
  '3763203': '18525422',  // bpatterson@95percentgroup.com
  '8723786': '8723786',  // pankaj@makewebbetter.com
  '9173446': '9173446',  // gauravtripathi@makewebbetter.com
  '27694956': '27694956',  // sudhakarpandey@makewebbetter.com
  '45451065': '181577832',  // lsullivan@95percentgroup.com
  '46408374': '211744580',  // bbaker@95percentgroup.com
  '47151327': '230064129',  // mmiller@95percentgroup.com
  '50253463': '352206340',  // kharper@95percentgroup.com
  '60730063': '550455864',  // wchang@95percentgroup.com
  '60935026': '560319513',  // rclark@95percentgroup.com
  '61676858': '601290148',  // pfreedman@95percentgroup.com
  '63179672': '672850242',  // gkesler@95percentgroup.com
  '64491847': '751955723',  // tsmith@95percentgroup.com
  '67008404': '1936566360',  // tmiller@95percentgroup.com
  '67855975': '1404151225',  // rgrounds@95percentgroup.com
  '69123696': '1117200836',  // browe@95percentgroup.com
  '69259141': '69259141',  // sourabhsingh@makewebbetter.com
  '71024339': '71024339',  // anveshikamishra@makewebbetter.com
  '72068007': '72068007',  // suryaprakashgupta@makewebbetter.com
  '79411216': '79411216',  // pallavisingh@makewebbetter.com
  '84059163': '2029241262',  // pwang@95percentgroup.com
  '86254828': '86254828',  // ravikantpandey@makewebbetter.com
  '88490010': '88490010',  // jdemarco@95percentgroup.com
  '88495508': '88495508',  // ablack@95percentgroup.com
  '89103420': '89103420',  // kjohnson@95percentgroup.com
  '90007237': '90007237',  // sburns@95percentgroup.com
  '90242737': '90242737',  // rdesouza@95percentgroup.com
  '90889758': '1168039153',  // jthomsen@95percentgroup.com
  '91525249': '1021226174',  // jtreichler@95percentgroup.com
  '279435637': '88104500',  // epichman@95percentgroup.com
  '337849529': '76181927',  // kstehr@95percentgroup.com
  '340707348': '402013449',  // kpiranio@95percentgroup.com
  '387987833': '70401043',  // ewilliams@95percentgroup.com
  '400765253': '214905858',  // scox@95percentgroup.com
  '429491177': '39887254',  // admin+95@englhardconsulting.com
  '527530834': '77766607',  // atate@95percentgroup.com
  '640129291': '164227621',  // mpatel@95percentgroup.com
  '793589287': '468788581',  // noreply@salesforce.com
  '837124165': '468788581',  // noreply@salesforce.com
  '1003211342': '468788581',  // noreply@salesforce.com
  '1113666268': '179031424',  // ialdawoud@95percentgroup.com
  '1120336442': '1411093930',  // dadzema@95percentgroup.com
  '1173555779': '134876914',  // jbobrowski@95percentgroup.com
  '1214949576': '95116677',  // mjohnson@95percentgroup.com
  '1310999875': '398423594',  // kmolina@95percentgroup.com
  '1567814466': '1732582595',  // lwindus@95percentgroup.com
  '1756593623': '445394756',  // kwheeler@95percentgroup.com
  '1773655144': '453548113',  // schavez@95percentgroup.com
  '2074721972': '417500287',  // dcoombs@95percentgroup.com
  '2098187823': '592363878',  // kkick@95percentgroup.com
  '2114582877': '672850241',  // rnagle@95percentgroup.com
};

// ===========================================================================
// Asset allowlists (exact source names — trailing spaces are significant)
// ===========================================================================

const WORKFLOW_NAME_ALLOWLIST = [
  'State | Indiana | FY26 - Sync to SF Campaign',
  'State | Indiana | FY26 - Send a follow-up email after form submission',
  '* FINAL Revised Email Campaign | (Starting with EM3) State - Georgia | FY26  ',
  '* Revised Email Campaign | (Starting with EM3) State - Georgia | FY26 ',
  'Conferences - CON_KS_2026.07_KASA_CY26 - Sync to SF',
  'Email Campaign | State - Georgia | FY26',
  'Database Assigning 08.04.2026',
  'State | Georgia | FY26 - Sync to SF',
  'State | TM Georgia Tier 2 | FY26 - Send a follow-up email after form submission',
  'Funding Alignment Guide - Sync to SF',
  'OD Webinar | Grades 3-5 | 5.7.26 |  Sync to SF Campaign ',
  'Website Forms | NYC District 75 Info Request | Sync to SF Campaign ',
  'Webinar | Grades 3-5 | 5.7.26 - Handraisers | Sync to SF Campaign ',
  'Webinar | Grades 3-5 | 5.7.26 - Live Attendees | Sync to SF Campaign ',
  'Send a follow-up email after form submission',
  'TouchMath K - 5 Sampler | Sync to SF Campaign ',
  'Grades 3-5 Sample',
  'Paid Search Book a Meeting | Sync to SF Campaign',
  'Webinar | Grades 3-5 | 5.7.26 | Registrants Sync to SF Campaign',
  'TouchMath Grades 3-5 Sampler | Sync to SF Campaign ',
  'Dyscalculia Toolkit | Sync to SF Campaign',
  'Black List to Non Marketing Contact',
  'Fun Sheet Sign Up to Email List',
  'Alignments Form to SalesForce',
  'Contact Us Form to SalesForce',
  'Scope & Sequence Form to SalesForce',
  'Past Workshops Form to SalesForce',
  'Dysc 101 Form to SalesForce',
  'Research Form to SalesForce',
];

const FORM_NAMES = [
  'TouchMath Grades 3-5 Sampler',
  'Scope & Sequence',
  'TouchMath K-5 Program Sampler',
  'Webinar | TouchMath 3-5 | 5.7.26',
  'Dyscalculia Toolkit ',
  'Contact Form',
  'Fun Sheets',
  'Alignments (Gravity Forms)',
  'Past Recordings',
  'Summer Math Workbook 2025 - Downloads',
  'Summer Scavenger Hunt 2025 - Downloads',
  'Funding Alignments Guide',
  'On-Demand Webinar | TouchMath 3-5 | 5.7.26 ',
  'Winter Fun Sheets 2025 - Download',
  'Book meeting form | Advertising',
  'Summer Activities 2025 - Downloads',
  'Student Input Form Example (IEPs)',
  'State | TM Georgia Tier 2 | FY26',
  'Research',
  'Grades 3-5 Fun Sheets - Download ',
  'Funding Alignments - Guidance',
  'Dysc 101 Page',
  'Dyscalculia White Paper Download',
  'Dyscalculia Blogs - Mini Memory Mart',
  'Dyscalculia | Share My Story',
  'Curriculum Bridges - TeachTown enCore Math ',
  'Curriculum Bridges - SwunMath',
  'Curriculum Bridges - StemScopes Math',
  'Curriculum Bridges - Reveal Math ',
  'Curriculum Bridges - Paradigm by SwunMath',
  'Curriculum Bridges - iReady Math ',
  'Curriculum Bridges - Into Math ',
  'Curriculum Bridges - Illustrative Math ',
  'Curriculum Bridges - HMH Math in Focus',
  'Curriculum Bridges - HMH Go Math ',
  'Curriculum Bridges - Everway ULS Math  ',
  'Curriculum Bridges - Eureka Math² ',
  'Curriculum Bridges - Envision Math ',
  'Curriculum Bridges - Bridges Mathematics ',
  'Curriculum Bridges - Bluebonnet Math ',
  'Curriculum Bridges - Amplify Desmos ',
  'Conferences - IAASE 2026',
  'NYC District 75 Info Request',
  'Dyscalculia Toolkit (Landing Page) | advertising',
  'Dyscalculia Blogs - Math Pocket Card',
  'Fundraising Guide',
];

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

const REQUESTED_SEGMENT_LISTS = [
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

const REQUESTED_MARKETING_EMAIL_NAMES = [
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

// ===========================================================================
// Statuses
// ===========================================================================

const STATUS = {
  UPDATED: 'UPDATED',
  WOULD_UPDATE: 'WOULD_UPDATE',
  OWNER_ALREADY_CORRECT: 'OWNER_ALREADY_CORRECT',
  OWNER_MAPPING_NOT_FOUND: 'OWNER_MAPPING_NOT_FOUND',
  DESTINATION_OWNER_NOT_FOUND: 'DESTINATION_OWNER_NOT_FOUND',
  SOURCE_OWNER_MISSING: 'SOURCE_OWNER_MISSING',
  UNSUPPORTED_OWNER_UPDATE: 'UNSUPPORTED_OWNER_UPDATE',
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  DESTINATION_NOT_FOUND: 'DESTINATION_NOT_FOUND',
  AMBIGUOUS_SOURCE_MATCH: 'AMBIGUOUS_SOURCE_MATCH',
  AMBIGUOUS_DESTINATION_MATCH: 'AMBIGUOUS_DESTINATION_MATCH',
  API_ERROR: 'API_ERROR',
};

/** Statuses that mean "we deliberately did not write". */
const SKIPPED_STATUSES = new Set([
  STATUS.OWNER_MAPPING_NOT_FOUND,
  STATUS.DESTINATION_OWNER_NOT_FOUND,
  STATUS.SOURCE_OWNER_MISSING,
  STATUS.UNSUPPORTED_OWNER_UPDATE,
  STATUS.SOURCE_NOT_FOUND,
  STATUS.DESTINATION_NOT_FOUND,
  STATUS.AMBIGUOUS_SOURCE_MATCH,
  STATUS.AMBIGUOUS_DESTINATION_MATCH,
]);

/** Most significant first — used to roll per-field statuses up to the record. */
const STATUS_PRIORITY = [
  STATUS.API_ERROR,
  STATUS.UPDATED,
  STATUS.WOULD_UPDATE,
  STATUS.DESTINATION_OWNER_NOT_FOUND,
  STATUS.OWNER_MAPPING_NOT_FOUND,
  STATUS.SOURCE_OWNER_MISSING,
  STATUS.OWNER_ALREADY_CORRECT,
  STATUS.UNSUPPORTED_OWNER_UPDATE,
];

// ===========================================================================
// HTTP client (native fetch — the HTTP client this project already uses)
// ===========================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HubSpotApiError extends Error {
  constructor(message, { status, body, method, urlPath } = {}) {
    super(message);
    this.name = 'HubSpotApiError';
    this.status = status ?? null;
    this.body = body ?? null;
    this.method = method ?? null;
    this.urlPath = urlPath ?? null;
  }
}

/** Per-portal serialised gate so two portals never share a rate-limit budget. */
const portalGates = new Map();

async function rateLimitGate(portalLabel) {
  const previous = portalGates.get(portalLabel) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  portalGates.set(
    portalLabel,
    previous.then(() => current),
  );
  await previous;
  return async () => {
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
    release();
  };
}

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
 * One HubSpot call with rate-limit gating, 429/5xx/network retries with
 * exponential backoff + jitter, a hard timeout, and fail-fast on auth errors.
 *
 * @param {{label: string, token: string}} portal
 */
async function hubspotRequest(portal, method, urlPath, { query, body, allowStatuses = [] } = {}) {
  const url = new URL(urlPath, HUBSPOT_API_BASE);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
  }

  for (let attempt = 0; ; attempt += 1) {
    const releaseGate = await rateLimitGate(portal.label);
    let response;
    let networkError = null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${portal.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      networkError = error;
    } finally {
      clearTimeout(timeout);
      await releaseGate();
    }

    // Network failure / timeout — retryable.
    if (networkError) {
      const label = networkError.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : networkError.message;
      if (attempt < MAX_RETRIES) {
        const waitMs = backoffDelay(attempt);
        console.warn(`    [retry] ${portal.label} ${method} ${url.pathname} — ${label}; retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      throw new HubSpotApiError(`${method} ${url.pathname} network failure: ${label}`, {
        method,
        urlPath: url.pathname,
      });
    }

    if (response.ok || allowStatuses.includes(response.status)) {
      const parsed = await readBody(response);
      return { status: response.status, body: parsed };
    }

    // 401/403 are configuration problems — retrying only wastes quota.
    if (response.status === 401 || response.status === 403) {
      const errorBody = await readBody(response);
      throw new HubSpotApiError(
        `${method} ${url.pathname} failed with ${response.status} — check the ${portal.label} token and its scopes`,
        { status: response.status, body: errorBody, method, urlPath: url.pathname },
      );
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after'), 10);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffDelay(attempt);
      console.warn(
        `    [retry] ${portal.label} ${method} ${url.pathname} -> ${response.status}; retrying in ${waitMs}ms` +
          ` (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(waitMs);
      continue;
    }

    const errorBody = await readBody(response);
    throw new HubSpotApiError(`${method} ${url.pathname} failed with ${response.status}`, {
      status: response.status,
      body: errorBody,
      method,
      urlPath: url.pathname,
    });
  }
}

function backoffDelay(attempt) {
  const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
  return base + Math.floor(Math.random() * 250); // jitter
}

function describeApiError(error) {
  if (!(error instanceof HubSpotApiError)) return error.message;
  const bodyText =
    error.body && typeof error.body === 'object'
      ? error.body.message || JSON.stringify(error.body).slice(0, 400)
      : String(error.body || '').slice(0, 400);
  return `${error.message}${bodyText ? ` :: ${bodyText}` : ''}`;
}

// ===========================================================================
// Pagination helpers
// ===========================================================================

/** Pages any `{results, paging.next.after}` endpoint (v3/v4 style). */
async function pageCursor(portal, urlPath, query = {}, { pageSize = 100, maxPages = 500 } = {}) {
  const collected = [];
  let after;
  for (let pages = 0; pages < maxPages; pages += 1) {
    const { body } = await hubspotRequest(portal, 'GET', urlPath, {
      query: { ...query, limit: pageSize, after },
    });
    if (!body || !Array.isArray(body.results)) {
      // Invalid / empty response shape — fail loudly rather than silently
      // treating a broken response as "no records".
      if (body && typeof body === 'object' && body.results === undefined) {
        throw new HubSpotApiError(`Unexpected response shape from ${urlPath} (no "results" array)`, {
          urlPath,
          body,
        });
      }
      break;
    }
    collected.push(...body.results);
    after = body.paging?.next?.after;
    if (!after) break;
  }
  return collected;
}

/** Pages POST /crm/v3/lists/search, which uses offset/hasMore instead of a cursor. */
async function pageListSearch(portal, query = '', { pageSize = 100, maxPages = 200 } = {}) {
  const collected = [];
  let offset = 0;
  for (let pages = 0; pages < maxPages; pages += 1) {
    const { body } = await hubspotRequest(portal, 'POST', '/crm/v3/lists/search', {
      body: { query, count: pageSize, offset },
    });
    const lists = body?.lists;
    if (!Array.isArray(lists) || lists.length === 0) break;
    collected.push(...lists);
    if (!body.hasMore) break;
    offset = typeof body.offset === 'number' ? body.offset : offset + lists.length;
  }
  return collected;
}

// ===========================================================================
// Name matching (exact only — never fuzzy)
// ===========================================================================

/**
 * Exact destination candidates for a source name: every configured prefix
 * crossed with the raw and trimmed source name (the original migration trimmed
 * trailing spaces on form names). Order matters — first match wins.
 */
function destinationNameCandidates(sourceName) {
  const prefixes = [DESTINATION_PREFIX, ...DESTINATION_PREFIX_FALLBACKS];
  const bases = sourceName === sourceName.trim() ? [sourceName] : [sourceName, sourceName.trim()];
  const candidates = [];
  for (const prefix of prefixes) {
    for (const base of bases) {
      const candidate = `${prefix}${base}`;
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * Second-pass key: Unicode-normalised (NFC), whitespace-collapsed, trimmed.
 * Needed because real names in these portals carry trailing and doubled spaces
 * the configured allowlists omit. Still whole-name equality — NOT fuzzy.
 */
function normalizeNameKey(name) {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Builds strict and normalised name indexes; duplicates stay visible. */
function indexByName(records, nameOf) {
  const exact = new Map();
  const normalized = new Map();
  for (const record of records) {
    const name = nameOf(record);
    if (typeof name !== 'string') continue;
    if (!exact.has(name)) exact.set(name, []);
    exact.get(name).push(record);
    const key = normalizeNameKey(name);
    if (!normalized.has(key)) normalized.set(key, []);
    normalized.get(key).push(record);
  }
  return { exact, normalized };
}

/** @returns {{matches: any[], name: string|null, matchMode: string|null}} */
function lookupSource(index, sourceName) {
  const exactMatches = index.exact.get(sourceName);
  if (exactMatches && exactMatches.length > 0) {
    return { matches: exactMatches, name: sourceName, matchMode: 'EXACT' };
  }
  const normalizedMatches = index.normalized.get(normalizeNameKey(sourceName));
  if (normalizedMatches && normalizedMatches.length > 0) {
    return { matches: normalizedMatches, name: null, matchMode: 'WHITESPACE_NORMALIZED' };
  }
  return { matches: [], name: null, matchMode: null };
}

/**
 * @param {string[]} sourceNames configured name first, then the source
 *   record's real name when it differs (the original migration built the
 *   destination name from the real one).
 * @returns {{matches, name, prefixUsed, matchMode}}
 */
function lookupDestination(index, sourceNames) {
  const names = [...new Set([].concat(sourceNames).filter((name) => typeof name === 'string'))];
  const candidates = [...new Set(names.flatMap((name) => destinationNameCandidates(name)))];
  const prefixOf = (candidate) =>
    [DESTINATION_PREFIX, ...DESTINATION_PREFIX_FALLBACKS].find((prefix) => candidate.startsWith(prefix)) || null;

  for (const candidate of candidates) {
    const matches = index.exact.get(candidate);
    if (matches && matches.length > 0) {
      return { matches, name: candidate, prefixUsed: prefixOf(candidate), matchMode: 'EXACT' };
    }
  }
  for (const candidate of candidates) {
    const matches = index.normalized.get(normalizeNameKey(candidate));
    if (matches && matches.length > 0) {
      return { matches, name: candidate, prefixUsed: prefixOf(candidate), matchMode: 'WHITESPACE_NORMALIZED' };
    }
  }
  return { matches: [], name: null, prefixUsed: null, matchMode: null };
}

const EMPTY_NAME_INDEX = { exact: new Map(), normalized: new Map() };

// ===========================================================================
// Owner / user retrieval and validation
// ===========================================================================

/** Fetches every owner (active + archived) and indexes by ownerId/userId/email. */
async function loadOwnerIndex(portal) {
  const raw = [];
  for (const archived of [false, true]) {
    raw.push(...(await pageCursor(portal, '/crm/v3/owners', { archived }, { pageSize: 500 })));
  }

  const owners = raw.map((owner) => ({
    ownerId: String(owner.id),
    userId: owner.userId != null ? String(owner.userId) : null,
    email: owner.email || null,
    name: [owner.firstName, owner.lastName].filter(Boolean).join(' ') || null,
    archived: Boolean(owner.archived),
  }));

  const byOwnerId = new Map();
  const byUserId = new Map();
  const byEmail = new Map();
  const put = (map, key, owner) => {
    if (!key) return;
    const existing = map.get(key);
    // On a collision prefer the active record over the archived one.
    if (!existing || (existing.archived && !owner.archived)) map.set(key, owner);
  };
  for (const owner of owners) {
    put(byOwnerId, owner.ownerId, owner);
    put(byUserId, owner.userId, owner);
    put(byEmail, owner.email ? owner.email.toLowerCase() : null, owner);
  }

  return { owners, byOwnerId, byUserId, byEmail };
}

/**
 * Users API index. Many createdBy/updatedBy user ids have no owner record at
 * all (verified: source user 67684615 emily.triplett@touchmath.com), so this
 * supplies the email used by the EMAIL_MATCH channel. Optional — the
 * destination token lacks settings.users.read (403), which is handled here
 * rather than aborting the run.
 */
async function loadUserIndex(portal) {
  try {
    const users = await pageCursor(portal, '/settings/v3/users', {}, { pageSize: 100 });
    const byId = new Map();
    for (const user of users) {
      byId.set(String(user.id), {
        userId: String(user.id),
        email: user.email || null,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
      });
    }
    return { byId, available: true, count: users.length };
  } catch (error) {
    console.warn(
      `[warn] ${portal.label} Users API unavailable (${describeApiError(error)}) — email-based user resolution disabled for that portal.`,
    );
    return { byId: new Map(), available: false, count: 0 };
  }
}

/** source owner id -> destination owner id, per the configured mapping. */
function mapOwnerId(sourceOwnerId) {
  if (sourceOwnerId === null || sourceOwnerId === undefined) return null;
  const mapped = ownerIdMapping[String(sourceOwnerId)];
  return mapped === undefined ? null : String(mapped);
}

/** Confirms the mapped destination owner really exists (and is usable). */
function verifyDestinationOwner(destinationOwnerIndex, destinationOwnerId) {
  if (!destinationOwnerId) return { ok: false, reason: 'no destination owner id resolved', owner: null };
  const owner = destinationOwnerIndex.byOwnerId.get(String(destinationOwnerId));
  if (!owner) {
    return { ok: false, reason: `owner id ${destinationOwnerId} does not exist in the destination portal`, owner: null };
  }
  if (owner.archived && !ALLOW_ARCHIVED_DESTINATION_OWNER) {
    return {
      ok: false,
      reason: `destination owner ${destinationOwnerId} (${owner.email || 'no email'}) exists but is ARCHIVED/deactivated — HubSpot will not accept it as an owner`,
      owner,
    };
  }
  return { ok: true, reason: null, owner };
}

/**
 * Translates a destination owner record into the value the field actually
 * stores: campaign hs_owner and all createdBy/updatedBy fields hold HubSpot
 * USER ids; CRM-style owner fields hold an ownerId.
 */
function resolveWriteValue(fieldSpec, destinationOwner) {
  if (fieldSpec.valueKind === 'userId') return destinationOwner.userId ? String(destinationOwner.userId) : null;
  return String(destinationOwner.ownerId);
}

function toIdString(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/**
 * Full resolution for one source user/owner value:
 *   ownerIdMapping -> EMAIL_MATCH (source Users API) -> DEFAULT owner.
 * Returns the resolved destination owner plus everything needed to explain it.
 */
function resolveDestinationOwnerFor(fieldSpec, sourceValue, ctx) {
  const resolution = {
    sourceValue,
    sourceOwnerId: null,
    sourceEmail: null,
    sourceUserName: null,
    mappingChannel: null,
    mappedDestinationOwnerId: null,
    destinationOwner: null,
    usedDefaultOwner: false,
    defaultOwnerReason: null,
    status: null,
    statusDetail: null,
  };

  const useDefault = (reason) => {
    if (!USE_DEFAULT_OWNER_FALLBACK) return false;
    resolution.usedDefaultOwner = true;
    resolution.defaultOwnerReason = reason;
    resolution.mappingChannel = 'DEFAULT';
    resolution.mappedDestinationOwnerId = DEFAULT_DESTINATION_OWNER_ID;
    return true;
  };

  if (sourceValue === null) {
    // Nothing on the source — fall back to the default owner if allowed.
    if (!useDefault('SOURCE_OWNER_MISSING')) {
      resolution.status = STATUS.SOURCE_OWNER_MISSING;
      resolution.statusDetail = `Source record has no ${fieldSpec.label.toLowerCase()}; default-owner fallback is disabled.`;
      return resolution;
    }
  } else {
    // Identify the source user: owner record first, then the Users API.
    const sourceOwner = ctx.sourceOwners.byOwnerId.get(sourceValue) || ctx.sourceOwners.byUserId.get(sourceValue);
    const sourceUser = ctx.sourceUsers.byId.get(sourceValue);
    resolution.sourceOwnerId = sourceOwner ? sourceOwner.ownerId : null;
    resolution.sourceEmail = sourceOwner?.email || sourceUser?.email || null;
    resolution.sourceUserName = sourceOwner?.name || sourceUser?.name || null;

    const mapped = mapOwnerId(resolution.sourceOwnerId ?? sourceValue);
    if (mapped) {
      resolution.mappingChannel = 'OWNER_ID_MAPPING';
      resolution.mappedDestinationOwnerId = mapped;
    } else if (USER_EMAIL_FALLBACK && resolution.sourceEmail) {
      // The source user has no mapping entry (common for createdBy/updatedBy);
      // match them to the destination by email instead of defaulting blindly.
      const byEmail = ctx.destinationOwners.byEmail.get(resolution.sourceEmail.toLowerCase());
      if (byEmail) {
        resolution.mappingChannel = 'EMAIL_MATCH';
        resolution.mappedDestinationOwnerId = byEmail.ownerId;
      }
    }

    if (!resolution.mappedDestinationOwnerId) {
      const reason = `OWNER_MAPPING_NOT_FOUND (source ${sourceValue}${resolution.sourceEmail ? ` / ${resolution.sourceEmail}` : ''})`;
      if (!useDefault(reason)) {
        resolution.status = STATUS.OWNER_MAPPING_NOT_FOUND;
        resolution.statusDetail = `Source ${fieldSpec.label.toLowerCase()} ${sourceValue}${
          resolution.sourceEmail ? ` (${resolution.sourceEmail})` : ''
        } is not in ownerIdMapping and could not be matched by email; default-owner fallback is disabled.`;
        return resolution;
      }
    }
  }

  // Verify the resolved owner, falling back to the default if it is unusable.
  let verified = verifyDestinationOwner(ctx.destinationOwners, resolution.mappedDestinationOwnerId);
  if (!verified.ok && !resolution.usedDefaultOwner) {
    const originalReason = verified.reason;
    const fallback = verifyDestinationOwner(ctx.destinationOwners, DEFAULT_DESTINATION_OWNER_ID);
    if (fallback.ok && useDefault(`DESTINATION_OWNER_UNUSABLE (${originalReason})`)) {
      verified = fallback;
    }
  }

  resolution.destinationOwner = verified.owner;
  if (!verified.ok) {
    resolution.status = STATUS.DESTINATION_OWNER_NOT_FOUND;
    resolution.statusDetail = verified.reason;
  }
  return resolution;
}

// ===========================================================================
// Asset-specific retrieval
// ===========================================================================

async function listFormsAllStates(portal) {
  const live = await pageCursor(portal, '/marketing/v3/forms', { archived: false });
  const archived = await pageCursor(portal, '/marketing/v3/forms', { archived: true });
  return dedupeById([...live, ...archived], (record) => String(record.id));
}

/**
 * v4 flows carry the name; only the legacy v3 workflows list carries the
 * created/updated user. The two use different id spaces (0 of 84 overlap), so
 * they are joined on migrationStatus.flowId.
 */
async function listFlowsWithAudit(portal) {
  const flows = await pageCursor(portal, '/automation/v4/flows');
  const auditByFlowId = new Map();
  try {
    const { body } = await hubspotRequest(portal, 'GET', '/automation/v3/workflows');
    for (const workflow of body?.workflows || []) {
      const flowId = workflow.migrationStatus?.flowId;
      if (flowId === null || flowId === undefined) continue;
      auditByFlowId.set(String(flowId), {
        createdByUserId: toIdString(workflow.creationSource?.createdByUser?.userId ?? workflow.originalAuthorUserId),
        createdByEmail: workflow.creationSource?.createdByUser?.userEmail || null,
        updatedByUserId: toIdString(workflow.updateSource?.updatedByUser?.userId ?? workflow.lastUpdatedByUserId),
        updatedByEmail: workflow.updateSource?.updatedByUser?.userEmail || null,
      });
    }
    console.log(`  [info] Joined ${auditByFlowId.size} legacy workflow audit records via migrationStatus.flowId.`);
  } catch (error) {
    console.warn(`  [warn] Legacy /automation/v3/workflows unavailable (${describeApiError(error)}); workflow createdBy/updatedBy will be unknown.`);
  }
  return flows.map((flow) => ({ ...flow, __audit: auditByFlowId.get(String(flow.id)) || null }));
}

/**
 * The Marketing API rejects hs_updated_by_user_id in `properties=` (400
 * Forbidden properties), so campaigns are enriched with a CRM object read,
 * joined on hs_object_id. The Marketing record is kept as the primary because
 * only it carries the campaign GUID needed for writes.
 */
async function listCampaignsWithAudit(portal) {
  const campaigns = await pageCursor(portal, '/marketing/v3/campaigns', {
    properties: 'hs_name,hs_owner,hs_object_id,hs_created_by_user_id',
  });
  const crmByObjectId = new Map();
  try {
    const objects = await pageCursor(portal, '/crm/v3/objects/campaigns', {
      properties: 'hs_name,hs_owner,hs_object_id,hs_created_by_user_id,hs_updated_by_user_id',
    });
    for (const object of objects) {
      crmByObjectId.set(String(object.properties?.hs_object_id ?? object.id), object.properties || {});
    }
    console.log(`  [info] Enriched campaigns with ${crmByObjectId.size} CRM object reads (for hs_updated_by_user_id).`);
  } catch (error) {
    console.warn(`  [warn] CRM campaign read unavailable (${describeApiError(error)}); hs_updated_by_user_id will be unknown.`);
  }
  return campaigns.map((campaign) => ({
    ...campaign,
    __crm: crmByObjectId.get(String(campaign.properties?.hs_object_id)) || null,
  }));
}

async function listMarketingEmails(portal) {
  const live = await pageCursor(portal, '/marketing/v3/emails', { archived: false });
  const archived = await pageCursor(portal, '/marketing/v3/emails', { archived: true });
  return dedupeById([...live, ...archived], (record) => String(record.id));
}

function dedupeById(records, idOf) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    const id = idOf(record);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(record);
  }
  return out;
}

let emailIdMapCache;

/**
 * Set in main() from /account-info/v3/details. The email id map records the
 * portal it was produced for; ids from another portal must never be trusted.
 */
let actualDestinationPortalId = null;

function loadEmailIdMap() {
  if (emailIdMapCache !== undefined) return emailIdMapCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(EMAIL_ID_MAP_FILE, 'utf8'));

    // Guard against pointing at a different destination portal than the map
    // was built for — an id valid in one portal may exist in another and
    // belong to a completely unrelated email.
    const mapPortalId = parsed.destinationPortal == null ? null : String(parsed.destinationPortal);
    if (mapPortalId && actualDestinationPortalId && mapPortalId !== actualDestinationPortalId) {
      console.warn(
        `  [warn] ${path.basename(EMAIL_ID_MAP_FILE)} was built for destination portal ${mapPortalId}, but this run targets ` +
          `${actualDestinationPortalId}. IGNORING the id map; email lookup will use the name index only.`,
      );
      emailIdMapCache = [];
      return emailIdMapCache;
    }

    const entries = Object.values(parsed.emails || {});
    emailIdMapCache = entries
      .filter((entry) => entry && entry.destinationEmailId)
      .map((entry) => ({
        sourceName: entry.sourceEmailName,
        destinationId: String(entry.destinationEmailId),
        destinationName: entry.destinationEmailName,
      }));
    console.log(`  [info] Loaded ${emailIdMapCache.length} email id mappings from ${path.basename(EMAIL_ID_MAP_FILE)}`);
  } catch (error) {
    emailIdMapCache = [];
    console.warn(`  [warn] Email id map unavailable (${error.message}); relying on the name index only.`);
  }
  return emailIdMapCache;
}

/**
 * Resolves a destination marketing email through the existing migration id
 * map. The mapped record is accepted only if the name HubSpot returns is an
 * exact destination candidate name — the id map alone is never trusted.
 */
async function lookupEmailsViaIdMap(portal, sourceName) {
  const candidates = destinationNameCandidates(sourceName);
  const entries = loadEmailIdMap().filter(
    (entry) => entry.sourceName === sourceName || candidates.includes(entry.destinationName),
  );

  const found = [];
  for (const entry of entries) {
    const record = await getMarketingEmailById(portal, entry.destinationId);
    if (record && candidates.includes(record.name)) found.push(record);
  }
  return found;
}

/** Drafts need `archived=true` to be retrievable in some portals. */
async function getMarketingEmailById(portal, emailId) {
  for (const archived of [false, true]) {
    const { status, body } = await hubspotRequest(portal, 'GET', `/marketing/v3/emails/${encodeURIComponent(emailId)}`, {
      query: { archived },
      allowStatuses: [404],
    });
    if (status !== 404 && body && body.id) return body;
  }
  return null;
}

/**
 * Attempts the campaign owner write and VERIFIES it by read-back, because
 * PATCH /marketing/v3/campaigns/{guid} with a top-level hs_owner returns 200
 * while discarding the value. Only reached when ATTEMPT_UNSUPPORTED_UPDATES is
 * on; kept so this script starts working the day HubSpot makes the field
 * writable.
 */
function makeCampaignPropertyUpdater(propertyName) {
  return async function updateCampaignProperty(portal, record, writeValue) {
    const guid = String(record.id);
    await hubspotRequest(portal, 'PATCH', `/marketing/v3/campaigns/${encodeURIComponent(guid)}`, {
      body: { properties: { [propertyName]: String(writeValue) } },
    });

    const { body } = await hubspotRequest(portal, 'GET', `/marketing/v3/campaigns/${encodeURIComponent(guid)}`, {
      query: { properties: `hs_name,${propertyName}` },
    });
    const readBack = body?.properties?.[propertyName];
    if (String(readBack ?? '') !== String(writeValue)) {
      throw new HubSpotApiError(
        `${propertyName} write was accepted but not persisted (read-back ${readBack ?? 'null'}, expected ${writeValue}) — the field is read-only`,
        { urlPath: `/marketing/v3/campaigns/${guid}` },
      );
    }
    return { readBack: String(readBack) };
  };
}

// ===========================================================================
// Asset specifications
// ===========================================================================

const NO_FIELD = (label, reason) => ({
  apiField: null,
  valueKind: null,
  extract: () => null,
  writable: false,
  unsupportedReason: reason,
  update: null,
  label,
});

const WORKFLOW_UPDATE_REASON =
  'Workflow audit users are read-only: PATCH /automation/v4/flows -> 405, PUT and PATCH /automation/v3/workflows -> 405, and the only update method (PUT /automation/v4/flows, a full-body replace) has no owner/createdBy/updatedBy field in its schema.';
const CAMPAIGN_WRITE_REASON =
  'PATCH /marketing/v3/campaigns rejects it ("Forbidden properties"), the CRM object API does not support object type CAMPAIGN, and a top-level PATCH returns 200 while silently discarding the value (verified by read-back). The CRM schema reports it read-only.';
const LIST_UPDATE_REASON =
  'List audit users are read-only: PATCH and PUT /crm/v3/lists/{listId} both return 405 Method Not Allowed; the Lists API exposes only name and filter updates.';
const EMAIL_UPDATE_REASON =
  'Marketing email audit users are platform-written, and in this portal PATCH /marketing/v3/emails/{id} cannot even resolve the migrated emails (404 with and without archived=true).';

/**
 * Each spec declares how to list source/destination records and, per field,
 * how to read the value and whether it can be written. `writable: false`
 * means the field is reported as UNSUPPORTED_OWNER_UPDATE — never faked.
 */
const ASSET_SPECS = [
  {
    type: 'workflow',
    label: 'Workflows',
    names: WORKFLOW_NAME_ALLOWLIST,
    idOf: (record) => String(record.id),
    nameOf: (record) => record.name,
    async listSource(portal) {
      return listFlowsWithAudit(portal);
    },
    async listDestination(portal) {
      return listFlowsWithAudit(portal);
    },
    fields: {
      owner: NO_FIELD(
        'Owner',
        'GET /automation/v4/flows (and legacy /automation/v3/workflows) expose no owner field at all — HubSpot workflows have no owner concept.',
      ),
      createdBy: {
        label: 'Created by',
        apiField: 'creationSource.createdByUser.userId (legacy /automation/v3/workflows)',
        valueKind: 'userId',
        extract: (record) => toIdString(record.__audit?.createdByUserId),
        writable: false,
        unsupportedReason: WORKFLOW_UPDATE_REASON,
        update: null,
      },
      updatedBy: {
        label: 'Updated by',
        apiField: 'updateSource.updatedByUser.userId (legacy /automation/v3/workflows)',
        valueKind: 'userId',
        extract: (record) => toIdString(record.__audit?.updatedByUserId),
        writable: false,
        unsupportedReason: WORKFLOW_UPDATE_REASON,
        update: null,
      },
    },
  },
  {
    type: 'form',
    label: 'Forms',
    names: FORM_NAMES,
    idOf: (record) => String(record.id),
    nameOf: (record) => record.name,
    async listSource(portal) {
      return listFormsAllStates(portal);
    },
    async listDestination(portal) {
      return listFormsAllStates(portal);
    },
    fields: {
      owner: NO_FIELD(
        'Owner',
        'GET /marketing/v3/forms exposes no owner field. The only owner-shaped key, configuration.notifyContactOwner, is a boolean notification toggle.',
      ),
      createdBy: NO_FIELD(
        'Created by',
        'Neither GET /marketing/v3/forms nor the legacy GET /forms/v2/forms exposes a created-by user id.',
      ),
      updatedBy: NO_FIELD(
        'Updated by',
        'Neither GET /marketing/v3/forms nor the legacy GET /forms/v2/forms exposes an updated-by user id.',
      ),
    },
  },
  {
    type: 'campaign',
    label: 'Campaigns',
    names: CAMPAIGN_NAMES,
    idOf: (record) => String(record.id), // campaign GUID
    nameOf: (record) => record.properties?.hs_name,
    async listSource(portal) {
      return listCampaignsWithAudit(portal);
    },
    async listDestination(portal) {
      return listCampaignsWithAudit(portal);
    },
    fields: {
      owner: {
        label: 'Owner',
        apiField: 'hs_owner',
        // hs_owner holds a HubSpot *user* id, not a CRM ownerId.
        valueKind: 'userId',
        extract: (record) => toIdString(record.properties?.hs_owner ?? record.__crm?.hs_owner),
        writable: false,
        unsupportedReason: `hs_owner is read-only. ${CAMPAIGN_WRITE_REASON}`,
        update: makeCampaignPropertyUpdater('hs_owner'),
      },
      createdBy: {
        label: 'Created by',
        apiField: 'hs_created_by_user_id',
        valueKind: 'userId',
        extract: (record) => toIdString(record.properties?.hs_created_by_user_id ?? record.__crm?.hs_created_by_user_id),
        writable: false,
        unsupportedReason: `hs_created_by_user_id is read-only. ${CAMPAIGN_WRITE_REASON}`,
        update: makeCampaignPropertyUpdater('hs_created_by_user_id'),
      },
      updatedBy: {
        label: 'Updated by',
        apiField: 'hs_updated_by_user_id (readable only via GET /crm/v3/objects/campaigns)',
        valueKind: 'userId',
        extract: (record) => toIdString(record.__crm?.hs_updated_by_user_id),
        writable: false,
        unsupportedReason: `hs_updated_by_user_id is read-only. ${CAMPAIGN_WRITE_REASON}`,
        update: makeCampaignPropertyUpdater('hs_updated_by_user_id'),
      },
    },
  },
  {
    type: 'list',
    label: 'Segment Lists',
    names: REQUESTED_SEGMENT_LISTS,
    idOf: (record) => String(record.listId),
    nameOf: (record) => record.name,
    async listSource(portal) {
      return pageListSearch(portal, '');
    },
    async listDestination(portal) {
      return pageListSearch(portal, '');
    },
    // Lists are searchable by name, so a miss in the full index gets a second,
    // still-exact chance via a targeted search.
    async lookupExtraSource(portal, sourceName) {
      return pageListSearch(portal, sourceName.trim(), { maxPages: 5 });
    },
    async lookupExtraDestination(portal, sourceName) {
      const found = [];
      for (const candidate of destinationNameCandidates(sourceName)) {
        found.push(...(await pageListSearch(portal, candidate, { maxPages: 5 })));
      }
      return found;
    },
    fields: {
      owner: NO_FIELD(
        'Owner',
        'GET /crm/v3/lists exposes no owner field — only createdById/updatedById (and legacy authorId). HubSpot lists have no owner concept.',
      ),
      createdBy: {
        label: 'Created by',
        apiField: 'createdById',
        valueKind: 'userId',
        extract: (record) => toIdString(record.createdById),
        writable: false,
        unsupportedReason: LIST_UPDATE_REASON,
        update: null,
      },
      updatedBy: {
        label: 'Updated by',
        apiField: 'updatedById',
        valueKind: 'userId',
        extract: (record) => toIdString(record.updatedById),
        writable: false,
        unsupportedReason: LIST_UPDATE_REASON,
        update: null,
      },
    },
  },
  {
    type: 'marketing_email',
    label: 'Marketing Emails',
    names: REQUESTED_MARKETING_EMAIL_NAMES,
    idOf: (record) => String(record.id),
    nameOf: (record) => record.name,
    async listSource(portal) {
      return listMarketingEmails(portal);
    },
    async listDestination(portal) {
      return listMarketingEmails(portal);
    },
    // The destination email index is provably stale (see file header), so fall
    // back to the project's id map and verify the fetched name exactly.
    async lookupExtraDestination(portal, sourceName) {
      return lookupEmailsViaIdMap(portal, sourceName);
    },
    fields: {
      owner: NO_FIELD(
        'Owner',
        'GET /marketing/v3/emails exposes no owner field — only createdById/updatedById/publishedById audit values.',
      ),
      createdBy: {
        label: 'Created by',
        apiField: 'createdById',
        valueKind: 'userId',
        extract: (record) => toIdString(record.createdById),
        writable: false,
        unsupportedReason: EMAIL_UPDATE_REASON,
        update: null,
      },
      updatedBy: {
        label: 'Updated by',
        apiField: 'updatedById',
        valueKind: 'userId',
        extract: (record) => toIdString(record.updatedById),
        writable: false,
        unsupportedReason: EMAIL_UPDATE_REASON,
        update: null,
      },
    },
  },
];

const FIELD_KEYS = ['owner', 'createdBy', 'updatedBy'];

function selectedFieldsFor(spec) {
  return FIELD_KEYS.filter((key) => PROCESS_FIELDS.includes(key)).map((key) => ({ key, ...spec.fields[key] }));
}

// ===========================================================================
// Per-field processing
// ===========================================================================

async function processField(spec, fieldSpec, sourceRecord, destinationRecord, ctx) {
  const result = {
    field: fieldSpec.key,
    label: fieldSpec.label,
    apiField: fieldSpec.apiField,
    sourceValue: null,
    sourceOwnerId: null,
    sourceEmail: null,
    sourceUserName: null,
    mappingChannel: null,
    mappedDestinationOwnerId: null,
    mappedDestinationOwnerEmail: null,
    mappedDestinationOwnerArchived: null,
    usedDefaultOwner: false,
    defaultOwnerReason: null,
    writeValue: null,
    currentDestinationValue: null,
    updateSupported: Boolean(fieldSpec.writable),
    status: null,
    statusDetail: null,
    apiError: null,
  };

  // The asset type has no such field at all — nothing to read or write.
  if (!fieldSpec.apiField) {
    result.status = STATUS.UNSUPPORTED_OWNER_UPDATE;
    result.statusDetail = fieldSpec.unsupportedReason;
    return result;
  }

  result.sourceValue = fieldSpec.extract(sourceRecord);
  result.currentDestinationValue = fieldSpec.extract(destinationRecord);

  const resolution = resolveDestinationOwnerFor(fieldSpec, result.sourceValue, ctx);
  result.sourceOwnerId = resolution.sourceOwnerId;
  result.sourceEmail = resolution.sourceEmail;
  result.sourceUserName = resolution.sourceUserName;
  result.mappingChannel = resolution.mappingChannel;
  result.mappedDestinationOwnerId = resolution.mappedDestinationOwnerId;
  result.mappedDestinationOwnerEmail = resolution.destinationOwner?.email ?? null;
  result.mappedDestinationOwnerArchived = resolution.destinationOwner?.archived ?? null;
  result.usedDefaultOwner = resolution.usedDefaultOwner;
  result.defaultOwnerReason = resolution.defaultOwnerReason;

  if (resolution.status) {
    result.status = resolution.status;
    result.statusDetail = resolution.statusDetail;
    return result;
  }

  const writeValue = resolveWriteValue(fieldSpec, resolution.destinationOwner);
  if (writeValue === null) {
    result.status = STATUS.DESTINATION_OWNER_NOT_FOUND;
    result.statusDetail = `Destination owner ${resolution.mappedDestinationOwnerId} (${
      resolution.destinationOwner.email || 'no email'
    }) has no userId, and ${fieldSpec.apiField} stores a HubSpot user id.`;
    return result;
  }
  result.writeValue = writeValue;

  if (result.currentDestinationValue !== null && String(result.currentDestinationValue) === String(writeValue)) {
    result.status = STATUS.OWNER_ALREADY_CORRECT;
    result.statusDetail = 'Destination already carries the mapped user; left untouched.';
    return result;
  }

  if (!fieldSpec.writable && !ATTEMPT_UNSUPPORTED_UPDATES) {
    result.status = STATUS.UNSUPPORTED_OWNER_UPDATE;
    result.statusDetail = fieldSpec.unsupportedReason;
    return result;
  }
  if (!fieldSpec.update) {
    result.status = STATUS.UNSUPPORTED_OWNER_UPDATE;
    result.statusDetail = `${fieldSpec.unsupportedReason} There is no write endpoint at all, so ATTEMPT_UNSUPPORTED_UPDATES cannot change that.`;
    return result;
  }

  if (DRY_RUN) {
    result.status = STATUS.WOULD_UPDATE;
    result.statusDetail = `Would set ${fieldSpec.apiField}=${writeValue} on destination ${spec.idOf(destinationRecord)}.`;
    return result;
  }

  try {
    await fieldSpec.update(ctx.destination, destinationRecord, writeValue);
    result.status = STATUS.UPDATED;
    result.statusDetail = `Set ${fieldSpec.apiField}=${writeValue} (verified by read-back).`;
  } catch (error) {
    result.status = STATUS.API_ERROR;
    result.statusDetail = describeApiError(error);
    result.apiError = {
      status: error instanceof HubSpotApiError ? error.status : null,
      method: error instanceof HubSpotApiError ? error.method : null,
      urlPath: error instanceof HubSpotApiError ? error.urlPath : null,
      body: error instanceof HubSpotApiError ? error.body : null,
    };
  }
  return result;
}

function aggregateStatus(fields) {
  for (const status of STATUS_PRIORITY) {
    if (fields.some((field) => field.status === status)) return status;
  }
  return STATUS.UNSUPPORTED_OWNER_UPDATE;
}

// ===========================================================================
// Per-record processing
// ===========================================================================

function blankRow(spec, sourceName) {
  return {
    assetType: spec.type,
    sourceName,
    sourceId: null,
    sourceNameActual: null,
    sourceMatchMode: null,
    destinationName: `${DESTINATION_PREFIX}${sourceName}`,
    destinationNameMatched: null,
    destinationPrefixUsed: null,
    destinationMatchMode: null,
    destinationId: null,
    fields: [],
    // Mirrors of the owner field, kept at the top level for convenience.
    sourceOwnerId: null,
    currentDestinationOwnerId: null,
    mappedDestinationOwnerId: null,
    status: null,
    statusDetail: null,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Full source-first pipeline for one configured source name. Returns a single
 * report row; never throws.
 */
async function processAsset(spec, sourceName, ctx) {
  const row = blankRow(spec, sourceName);

  try {
    // --- 1. SOURCE FIRST ----------------------------------------------------
    let source = lookupSource(ctx.sourceIndex, sourceName);
    if (source.matches.length === 0 && spec.lookupExtraSource) {
      const extra = await spec.lookupExtraSource(ctx.source, sourceName);
      source = lookupSource(indexByName(extra, spec.nameOf), sourceName);
    }

    if (source.matches.length === 0) {
      row.status = STATUS.SOURCE_NOT_FOUND;
      row.statusDetail =
        'No source record whose name equals this configured name (exact, or after Unicode/whitespace normalisation).';
      return row;
    }
    if (source.matches.length > 1) {
      row.sourceMatchMode = source.matchMode;
      row.status = STATUS.AMBIGUOUS_SOURCE_MATCH;
      row.statusDetail = `${source.matches.length} source records share this name (${source.matchMode}) — ids: ${source.matches
        .map((record) => `${spec.idOf(record)} ${JSON.stringify(spec.nameOf(record))}`)
        .join(', ')}.`;
      return row;
    }

    const sourceRecord = source.matches[0];
    row.sourceId = spec.idOf(sourceRecord);
    row.sourceNameActual = spec.nameOf(sourceRecord);
    row.sourceMatchMode = source.matchMode;

    // --- 2. DESTINATION RECORD ---------------------------------------------
    const lookupNames = [sourceName, row.sourceNameActual];
    let destination = lookupDestination(ctx.destinationIndex, lookupNames);
    if (destination.matches.length === 0 && spec.lookupExtraDestination) {
      const extra = await spec.lookupExtraDestination(ctx.destination, sourceName);
      destination = lookupDestination(indexByName(extra, spec.nameOf), lookupNames);
    }

    if (destination.matches.length === 0) {
      row.status = STATUS.DESTINATION_NOT_FOUND;
      row.statusDetail = `No destination record named any of: ${destinationNameCandidates(sourceName)
        .map((candidate) => JSON.stringify(candidate))
        .join(' | ')}.`;
      return row;
    }
    if (destination.matches.length > 1) {
      row.destinationNameMatched = destination.name;
      row.destinationPrefixUsed = destination.prefixUsed;
      row.destinationMatchMode = destination.matchMode;
      row.status = STATUS.AMBIGUOUS_DESTINATION_MATCH;
      row.statusDetail = `${destination.matches.length} destination records match the name ${JSON.stringify(
        destination.name,
      )} (${destination.matchMode}) — ids: ${destination.matches
        .map((record) => `${spec.idOf(record)} ${JSON.stringify(spec.nameOf(record))}`)
        .join(', ')}.`;
      return row;
    }

    const destinationRecord = destination.matches[0];
    row.destinationId = spec.idOf(destinationRecord);
    row.destinationNameMatched = spec.nameOf(destinationRecord);
    row.destinationPrefixUsed = destination.prefixUsed;
    row.destinationMatchMode = destination.matchMode;

    // --- 3. OWNER / CREATED BY / UPDATED BY --------------------------------
    for (const fieldSpec of selectedFieldsFor(spec)) {
      row.fields.push(await processField(spec, fieldSpec, sourceRecord, destinationRecord, ctx));
    }

    const ownerField = row.fields.find((field) => field.field === 'owner');
    if (ownerField) {
      row.sourceOwnerId = ownerField.sourceValue;
      row.currentDestinationOwnerId = ownerField.currentDestinationValue;
      row.mappedDestinationOwnerId = ownerField.writeValue ?? ownerField.mappedDestinationOwnerId;
    }
    row.status = aggregateStatus(row.fields);
    row.statusDetail = row.fields
      .map((field) => `${field.label}: ${field.status}`)
      .join('; ');
    return row;
  } catch (error) {
    row.status = STATUS.API_ERROR;
    row.statusDetail = describeApiError(error);
    row.apiError = {
      status: error instanceof HubSpotApiError ? error.status : null,
      method: error instanceof HubSpotApiError ? error.method : null,
      urlPath: error instanceof HubSpotApiError ? error.urlPath : null,
      body: error instanceof HubSpotApiError ? error.body : null,
    };
    return row;
  }
}

// ===========================================================================
// Concurrency worker pool
// ===========================================================================

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ===========================================================================
// Logging
// ===========================================================================

function logRow(spec, row) {
  const tag = DRY_RUN ? '[DRY RUN]' : '[LIVE]';
  console.log(`\n${tag} ${spec.label.replace(/s$/, '')} — ${row.status}`);
  console.log(`  Source:                 ${JSON.stringify(row.sourceName)}`);
  console.log(`  Source ID:              ${row.sourceId ?? '-'}`);
  if (row.sourceNameActual && row.sourceNameActual !== row.sourceName) {
    console.log(`  Source name in portal:  ${JSON.stringify(row.sourceNameActual)}  <- matched ${row.sourceMatchMode}`);
  }
  console.log(`  Destination (expected): ${JSON.stringify(row.destinationName)}`);
  if (row.destinationNameMatched && row.destinationNameMatched !== row.destinationName) {
    console.log(
      `  Destination (matched):  ${JSON.stringify(row.destinationNameMatched)}` +
        `  <- ${row.destinationMatchMode}, prefix ${JSON.stringify(row.destinationPrefixUsed)}`,
    );
  }
  console.log(`  Destination ID:         ${row.destinationId ?? '-'}`);

  if (row.fields.length === 0) {
    console.log(`  Action:                 ${row.status}`);
    if (row.statusDetail) console.log(`  Detail:                 ${row.statusDetail}`);
    return;
  }

  for (const field of row.fields) {
    console.log(`  ${field.label}:`);
    console.log(
      `      source:      ${field.sourceValue ?? 'none'}` +
        `${field.sourceEmail ? ` (${field.sourceEmail})` : ''}` +
        `${field.apiField ? `  [${field.apiField}]` : '  [no such field on this asset type]'}`,
    );
    if (field.apiField) {
      console.log(`      destination: ${field.currentDestinationValue ?? 'none'} (current)`);
      console.log(
        `      mapped:      ${field.mappedDestinationOwnerId ?? '-'}` +
          `${field.mappedDestinationOwnerEmail ? ` (${field.mappedDestinationOwnerEmail})` : ''}` +
          `${field.mappingChannel ? ` via ${field.mappingChannel}` : ''}` +
          `${field.usedDefaultOwner ? `  [DEFAULT — ${field.defaultOwnerReason}]` : ''}`,
      );
      if (field.writeValue) console.log(`      write value: ${field.writeValue}`);
    }
    console.log(`      action:      ${field.status}`);
    if (field.statusDetail) console.log(`      detail:      ${field.statusDetail}`);
  }
}

// ===========================================================================
// Per-asset-type orchestration
// ===========================================================================

async function processAssetType(spec, portals) {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${spec.label} — ${spec.names.length} configured`);
  for (const fieldSpec of selectedFieldsFor(spec)) {
    console.log(
      `  ${fieldSpec.label.padEnd(10)} field: ${(fieldSpec.apiField || 'NONE (asset type has no such field)').padEnd(60)}` +
        ` writable: ${fieldSpec.writable ? 'yes' : 'NO'}`,
    );
  }
  console.log('='.repeat(78));

  const ctx = {
    source: portals.source,
    destination: portals.destination,
    sourceOwners: portals.sourceOwners,
    destinationOwners: portals.destinationOwners,
    sourceUsers: portals.sourceUsers,
    sourceIndex: EMPTY_NAME_INDEX,
    destinationIndex: EMPTY_NAME_INDEX,
  };

  try {
    console.log('  [info] Indexing source records...');
    const sourceRecords = await spec.listSource(portals.source);
    ctx.sourceIndex = indexByName(sourceRecords, spec.nameOf);
    console.log(`  [info] ${sourceRecords.length} source records indexed.`);

    console.log('  [info] Indexing destination records...');
    const destinationRecords = await spec.listDestination(portals.destination);
    ctx.destinationIndex = indexByName(destinationRecords, spec.nameOf);
    console.log(`  [info] ${destinationRecords.length} destination records indexed.`);
  } catch (error) {
    const detail = describeApiError(error);
    console.error(`  [error] Could not index ${spec.label}: ${detail}`);
    return spec.names.map((sourceName) => {
      const row = blankRow(spec, sourceName);
      row.status = STATUS.API_ERROR;
      row.statusDetail = `Indexing failed: ${detail}`;
      return row;
    });
  }

  return runPool(spec.names, CONCURRENCY, async (sourceName) => {
    const row = await processAsset(spec, sourceName, ctx);
    logRow(spec, row);
    return row;
  });
}

// ===========================================================================
// Reporting
// ===========================================================================

function emptyCounters() {
  return {
    updated: 0,
    wouldUpdate: 0,
    alreadyCorrect: 0,
    unsupported: 0,
    skipped: 0,
    errors: 0,
  };
}

function countStatus(counters, status) {
  if (status === STATUS.UPDATED) counters.updated += 1;
  if (status === STATUS.WOULD_UPDATE) counters.wouldUpdate += 1;
  if (status === STATUS.OWNER_ALREADY_CORRECT) counters.alreadyCorrect += 1;
  if (status === STATUS.UNSUPPORTED_OWNER_UPDATE) counters.unsupported += 1;
  if (SKIPPED_STATUSES.has(status)) counters.skipped += 1;
  if (status === STATUS.API_ERROR) counters.errors += 1;
}

function summarise(rows) {
  const summary = {
    totalConfigured: rows.length,
    sourceFound: 0,
    destinationFound: 0,
    ...emptyCounters(),
    byField: Object.fromEntries(FIELD_KEYS.map((key) => [key, emptyCounters()])),
  };
  for (const row of rows) {
    if (row.sourceId) summary.sourceFound += 1;
    if (row.destinationId) summary.destinationFound += 1;
    countStatus(summary, row.status);
    for (const field of row.fields) countStatus(summary.byField[field.field], field.status);
  }
  return summary;
}

function addCounters(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}

function printSummary(bySpec) {
  const line = '='.repeat(40);
  console.log(`\n${line}`);
  console.log('OWNER / CREATED-BY / UPDATED-BY MIGRATION SUMMARY');
  console.log(`${line}\n`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes performed)' : 'LIVE (updates performed)'}`);
  console.log(`Fields: ${PROCESS_FIELDS.join(', ')}\n`);

  const total = {
    totalConfigured: 0,
    sourceFound: 0,
    destinationFound: 0,
    ...emptyCounters(),
    byField: Object.fromEntries(FIELD_KEYS.map((key) => [key, emptyCounters()])),
  };

  const fieldLine = (label, counters) =>
    `    ${label.padEnd(12)} updated ${String(counters.updated).padStart(3)}` +
    (DRY_RUN ? ` | would update ${String(counters.wouldUpdate).padStart(3)}` : '') +
    ` | already correct ${String(counters.alreadyCorrect).padStart(3)}` +
    ` | unsupported ${String(counters.unsupported).padStart(3)}` +
    ` | skipped ${String(counters.skipped).padStart(3)}` +
    ` | errors ${String(counters.errors).padStart(3)}`;

  for (const { spec, summary } of bySpec) {
    console.log(`${spec.label}:`);
    console.log(`  Total configured:  ${summary.totalConfigured}`);
    console.log(`  Source found:      ${summary.sourceFound}`);
    console.log(`  Destination found: ${summary.destinationFound}`);
    console.log(`  Updated:           ${summary.updated}`);
    if (DRY_RUN) console.log(`  Would update:      ${summary.wouldUpdate}`);
    console.log(`  Already correct:   ${summary.alreadyCorrect}`);
    console.log(`  Unsupported:       ${summary.unsupported}`);
    console.log(`  Skipped:           ${summary.skipped}`);
    console.log(`  Errors:            ${summary.errors}`);
    console.log('  Per field:');
    for (const key of FIELD_KEYS) {
      if (!PROCESS_FIELDS.includes(key)) continue;
      console.log(fieldLine(key, summary.byField[key]));
    }
    console.log('');

    total.totalConfigured += summary.totalConfigured;
    total.sourceFound += summary.sourceFound;
    total.destinationFound += summary.destinationFound;
    countStatusRollup(total, summary);
  }

  console.log('TOTAL:');
  console.log(`  Source records found:      ${total.sourceFound}`);
  console.log(`  Destination records found: ${total.destinationFound}`);
  console.log(`  Updated:                   ${total.updated}`);
  if (DRY_RUN) console.log(`  Would update:              ${total.wouldUpdate}`);
  console.log(`  Already correct:           ${total.alreadyCorrect}`);
  console.log(`  Unsupported:               ${total.unsupported}`);
  console.log(`  Skipped:                   ${total.skipped}`);
  console.log(`  Errors:                    ${total.errors}`);
  console.log('  Per field:');
  for (const key of FIELD_KEYS) {
    if (!PROCESS_FIELDS.includes(key)) continue;
    console.log(fieldLine(key, total.byField[key]));
  }
  console.log(line);

  return total;
}

function countStatusRollup(total, summary) {
  total.updated += summary.updated;
  total.wouldUpdate += summary.wouldUpdate;
  total.alreadyCorrect += summary.alreadyCorrect;
  total.unsupported += summary.unsupported;
  total.skipped += summary.skipped;
  total.errors += summary.errors;
  for (const key of FIELD_KEYS) addCounters(total.byField[key], summary.byField[key]);
}

function reportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

function generateReport({ rows, bySpec, total, portalInfo }) {
  const filePath = path.join(OUTPUT_DIR, `owner-migration-report-${reportTimestamp()}.json`);
  const statusCounts = {};
  const fieldStatusCounts = {};
  for (const row of rows) {
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
    for (const field of row.fields) {
      const key = `${field.field}:${field.status}`;
      fieldStatusCounts[key] = (fieldStatusCounts[key] || 0) + 1;
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    configuration: {
      fields: PROCESS_FIELDS,
      destinationPrefix: DESTINATION_PREFIX,
      destinationPrefixFallbacks: DESTINATION_PREFIX_FALLBACKS,
      defaultDestinationOwnerId: DEFAULT_DESTINATION_OWNER_ID,
      useDefaultOwnerFallback: USE_DEFAULT_OWNER_FALLBACK,
      userEmailFallback: USER_EMAIL_FALLBACK,
      allowArchivedDestinationOwner: ALLOW_ARCHIVED_DESTINATION_OWNER,
      attemptUnsupportedUpdates: ATTEMPT_UNSUPPORTED_UPDATES,
      concurrency: CONCURRENCY,
    },
    portals: portalInfo,
    fieldCapabilities: ASSET_SPECS.flatMap((spec) =>
      FIELD_KEYS.map((key) => ({
        assetType: spec.type,
        field: key,
        apiField: spec.fields[key].apiField,
        readable: Boolean(spec.fields[key].apiField),
        writable: Boolean(spec.fields[key].writable),
        notes: spec.fields[key].unsupportedReason || null,
      })),
    ),
    summaryByAssetType: Object.fromEntries(bySpec.map(({ spec, summary }) => [spec.type, summary])),
    total,
    statusCounts,
    fieldStatusCounts,
    results: rows,
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

// ===========================================================================
// Main
// ===========================================================================

function requireToken(names, label) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  console.error(`Missing required env var for the ${label} portal. Set one of: ${names.join(', ')}`);
  process.exit(1);
  return null;
}

function assertExpectedPortal(label, actualPortalId, expectedPortalId) {
  if (!expectedPortalId) return;
  if (String(actualPortalId) !== String(expectedPortalId)) {
    console.error(
      `[fatal] ${label} token resolves to portal ${actualPortalId}, but EXPECTED_${label.toUpperCase()}_PORTAL_ID is ${expectedPortalId}. Refusing to continue.`,
    );
    process.exit(1);
  }
  console.log(`[info] ${label} portal id matches EXPECTED_${label.toUpperCase()}_PORTAL_ID.`);
}

async function describePortal(portal) {
  try {
    const { body } = await hubspotRequest(portal, 'GET', '/account-info/v3/details');
    return { label: portal.label, portalId: body?.portalId ?? null, accountType: body?.accountType ?? null };
  } catch (error) {
    // Almost always a bad token — surface it now, not 500 requests later.
    console.error(`[fatal] Could not authenticate against the ${portal.label} portal: ${describeApiError(error)}`);
    process.exit(1);
    return null;
  }
}

async function main() {
  const source = {
    label: 'source',
    token: requireToken(['SOURCE_HUBSPOT_TOKEN', 'SOURCE_HUBSPOT_ACCESS_TOKEN', 'SOURCE_ACCESS_TOKEN'], 'source'),
  };
  const destination = {
    label: 'destination',
    token: requireToken(
      ['DESTINATION_HUBSPOT_TOKEN', 'DESTINATION_HUBSPOT_ACCESS_TOKEN', 'DESTINATION_ACCESS_TOKEN', 'DEST_HUBSPOT_TOKEN'],
      'destination',
    ),
  };

  const invalidFields = PROCESS_FIELDS.filter((field) => !FIELD_KEYS.includes(field));
  if (invalidFields.length > 0) {
    console.error(`Unknown FIELDS value(s): ${invalidFields.join(', ')}. Valid: ${FIELD_KEYS.join(', ')}`);
    process.exit(1);
  }

  const requestedTypes = envList('ASSET_TYPES', null);
  const specs = requestedTypes ? ASSET_SPECS.filter((spec) => requestedTypes.includes(spec.type)) : ASSET_SPECS;
  if (specs.length === 0) {
    console.error(`No asset types selected. Valid values: ${ASSET_SPECS.map((spec) => spec.type).join(', ')}`);
    process.exit(1);
  }

  console.log('='.repeat(78));
  console.log('HUBSPOT OWNER / CREATED-BY / UPDATED-BY MIGRATION');
  console.log('='.repeat(78));
  console.log(`Mode:                  ${DRY_RUN ? 'DRY RUN — no writes' : 'LIVE — destination will be updated'}`);
  console.log(`Fields:                ${PROCESS_FIELDS.join(', ')}`);
  console.log(`Asset types:           ${specs.map((spec) => spec.type).join(', ')}`);
  console.log(
    `Destination prefix:    ${JSON.stringify(DESTINATION_PREFIX)}` +
      ` (fallbacks: ${DESTINATION_PREFIX_FALLBACKS.map((prefix) => JSON.stringify(prefix)).join(', ') || 'none'})`,
  );
  console.log(
    `Default owner:         ${DEFAULT_DESTINATION_OWNER_ID} (fallback ${USE_DEFAULT_OWNER_FALLBACK ? 'enabled' : 'disabled'})`,
  );
  console.log(`Email-match channel:   ${USER_EMAIL_FALLBACK ? 'enabled' : 'disabled'}`);
  console.log(`Concurrency:           ${CONCURRENCY}`);
  console.log(`Owner mapping entries: ${Object.keys(ownerIdMapping).length}`);

  const portalInfo = {
    source: await describePortal(source),
    destination: await describePortal(destination),
  };
  console.log(`Source portal:         ${portalInfo.source.portalId} (${portalInfo.source.accountType})`);
  console.log(`Destination portal:    ${portalInfo.destination.portalId} (${portalInfo.destination.accountType})`);
  actualDestinationPortalId = portalInfo.destination.portalId == null ? null : String(portalInfo.destination.portalId);

  assertExpectedPortal('source', portalInfo.source.portalId, EXPECTED_SOURCE_PORTAL_ID);
  assertExpectedPortal('destination', portalInfo.destination.portalId, EXPECTED_DESTINATION_PORTAL_ID);
  if (!DRY_RUN && portalInfo.destination.accountType !== 'SANDBOX') {
    console.log(
      `\n[notice] LIVE MODE against a non-sandbox destination portal (${portalInfo.destination.portalId}).` +
        ` Only owner/createdBy/updatedBy fields can ever be written; every other field is untouched.`,
    );
  }

  console.log('\n[info] Loading owners and users from both portals...');
  const [sourceOwners, destinationOwners, sourceUsers] = await Promise.all([
    loadOwnerIndex(source),
    loadOwnerIndex(destination),
    USER_EMAIL_FALLBACK ? loadUserIndex(source) : Promise.resolve({ byId: new Map(), available: false, count: 0 }),
  ]);
  console.log(
    `[info] ${sourceOwners.owners.length} source owners, ${destinationOwners.owners.length} destination owners (incl. archived), ` +
      `${sourceUsers.count} source users.`,
  );

  // Pre-flight: report any mapping target that does not exist / is unusable.
  console.log('\n[info] Verifying ownerIdMapping targets against the destination portal...');
  for (const [sourceOwnerId, destinationOwnerId] of Object.entries(ownerIdMapping)) {
    const verified = verifyDestinationOwner(destinationOwners, destinationOwnerId);
    if (!verified.ok) console.warn(`  [warn] ${sourceOwnerId} -> ${destinationOwnerId}: ${verified.reason}`);
  }
  const defaultOwnerCheck = verifyDestinationOwner(destinationOwners, DEFAULT_DESTINATION_OWNER_ID);
  console.log(
    `[info] Default owner ${DEFAULT_DESTINATION_OWNER_ID}: ` +
      (defaultOwnerCheck.ok
        ? `OK (${defaultOwnerCheck.owner.email || 'no email'}, userId ${defaultOwnerCheck.owner.userId || 'none'})`
        : `UNUSABLE — ${defaultOwnerCheck.reason}`),
  );

  const portals = { source, destination, sourceOwners, destinationOwners, sourceUsers };
  const bySpec = [];
  const rows = [];
  for (const spec of specs) {
    const specRows = await processAssetType(spec, portals);
    rows.push(...specRows);
    bySpec.push({ spec, summary: summarise(specRows) });
  }

  const total = printSummary(bySpec);
  const reportPath = generateReport({ rows, bySpec, total, portalInfo });
  console.log(`\nJSON report: ${reportPath}`);

  if (total.errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n[fatal] ${describeApiError(error)}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
