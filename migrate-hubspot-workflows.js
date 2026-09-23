#!/usr/bin/env node

/**
 * HubSpot Workflow Migration Script
 * ===================================
 *
 * Migrates workflows ("flows") from a source HubSpot portal to a destination
 * HubSpot portal using HubSpot's Automation "Workflows v4" API
 * (`/automation/v4/flows`). This is the current API HubSpot documents for
 * reading/creating/updating full workflow definitions (triggers, actions,
 * branches, delays, enrollment/re-enrollment settings). It is officially
 * labelled BETA by HubSpot and is subject to change - see:
 *   https://developers.hubspot.com/docs/api-reference/legacy/automation/workflows/guide
 *   https://developers.hubspot.com/docs/api-reference/legacy/automation/workflows/action-enrollment-reference
 *
 * IMPORTANT - READ BEFORE RUNNING
 * --------------------------------
 * 1. HubSpot does NOT provide a cross-portal "import workflow" endpoint.
 *    Migrating means: read the full workflow JSON from the source portal,
 *    strip server-assigned/read-only fields, remap any embedded HubSpot
 *    object IDs (lists, marketing emails, owners/users, custom object type
 *    IDs, other workflows referenced via "Go to workflow", etc.) to their
 *    destination-portal equivalents, then POST it as a new workflow.
 * 2. HubSpot's API does NOT expose every property of every action type
 *    (e.g. some BETA/AI actions, certain integration-specific fields, or
 *    UI-only cosmetic settings may not round-trip perfectly). This script
 *    copies everything the API returns and flags anything it cannot verify
 *    post-creation as "requires manual review" rather than silently
 *    pretending the migration was perfect.
 * 3. Because there is no reliable automatic way to know how a source
 *    portal's list/email/user/custom-object IDs map to the destination
 *    portal's IDs, this script accepts an optional external mapping file
 *    (ASSET_ID_MAP_FILE, see buildEmptyAssetMap() below for shape). Any
 *    reference it finds that isn't in that map is left as-is and reported
 *    for manual follow-up - it is never silently dropped or guessed at.
 *
 * REQUIRED ENVIRONMENT VARIABLES
 * -------------------------------
 *   SOURCE_HUBSPOT_TOKEN       Private app access token for the source portal.
 *   DESTINATION_HUBSPOT_TOKEN  Private app access token for the destination portal.
 *
 * Both tokens need the `automation` scope (and any `*.sensitive.read` /
 * `*.sensitive.write` scopes required if a workflow touches sensitive data).
 *
 * UNPUBLISHED BY DESIGN
 * ---------------------
 * Every migrated workflow is created in the destination portal turned OFF
 * (isEnabled=false), whatever its state in the source portal, and every
 * later update this script makes keeps it OFF. Workflows are reviewed and
 * turned on manually in the destination portal.
 *
 * OPTIONAL ENVIRONMENT VARIABLES
 * -------------------------------
 *   ASSET_ID_MAP_FILE      Path to a JSON file mapping source asset IDs to
 *                          destination asset IDs (lists, emails, owners,
 *                          object types, workflows). Defaults to
 *                          "./asset_id_mapping.json" if that file exists.
 *   REQUEST_DELAY_MS       Delay between outbound HubSpot API calls, in ms.
 *                          Defaults to 350.
 *   MAX_RETRIES            Max retry attempts for 429/5xx responses.
 *                          Defaults to 5.
 *   OUTPUT_DIR             Directory to write the 3 JSON log files into.
 *                          Defaults to the current working directory.
 *   REPAIR_EXISTING        Set to "true" to re-remap workflows that were
 *                          already migrated (listed in workflow_id_mapping.json)
 *                          and update them IN PLACE in the destination when
 *                          they differ from the source. Workflows someone has
 *                          already turned ON are never touched. Defaults to
 *                          "false" (already-migrated workflows are skipped),
 *                          so manual review edits are not overwritten.
 *   CREATE_MISSING_PROPERTIES  Defaults to "true": when a workflow filters on
 *                          or sets a property that exists in the source but
 *                          not the destination, copy its definition across
 *                          before migrating. Set to "false" to hold such
 *                          workflows instead.
 *   DRY_RUN                Set to "true" to fetch, remap, and report what
 *                          WOULD be migrated without creating anything in
 *                          the destination portal. Recommended for the
 *                          first run against real production portals.
 *
 * OUTPUT FILES (written to OUTPUT_DIR)
 * -------------------------------------
 *   workflow_migration_success.json  Successfully migrated workflows.
 *   workflow_migration_errors.json   Errors and validation failures.
 *   workflow_id_mapping.json         source workflow ID -> destination workflow ID.
 *
 * ASSET REFERENCES
 * ----------------
 *   Forms, lists and marketing emails referenced by a workflow are mapped to
 *   the destination automatically by name (exact name, or the destination
 *   name with a "Touchmath | " prefix; unique matches only).
 *   Entries in ASSET_ID_MAP_FILE take priority over name matching. A
 *   workflow with any reference that still can't be mapped is HELD (not
 *   created/updated) and listed in the error log, so it never ends up
 *   pointing at a wrong or non-existent destination asset.
 *
 * These files are read back in on every run so the script is safe to
 * re-run: workflows already present in workflow_id_mapping.json (and still
 * found in the destination portal) are skipped rather than duplicated.
 *
 * USAGE
 * -----
 *   SOURCE_HUBSPOT_TOKEN=xxx DESTINATION_HUBSPOT_TOKEN=yyy node migrate-hubspot-workflows.js
 *
 * Or, put the tokens in a .env file next to this script (see .env in this
 * directory for a ready-made template) and run with Node's built-in env
 * file support (Node 20.6+):
 *   node --env-file=.env migrate-hubspot-workflows.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HUBSPOT_API_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
const FLOWS_PATH = '/automation/v4/flows';

const OUTPUT_DIR = process.env.OUTPUT_DIR || process.cwd();
const SUCCESS_LOG_PATH = path.join(OUTPUT_DIR, 'workflow_migration_success.json');
const ERROR_LOG_PATH = path.join(OUTPUT_DIR, 'workflow_migration_errors.json');
const ID_MAPPING_PATH = path.join(OUTPUT_DIR, 'workflow_id_mapping.json');

const DEFAULT_ASSET_MAP_PATH = path.join(process.cwd(), 'asset_id_mapping.json');
const ASSET_ID_MAP_FILE = process.env.ASSET_ID_MAP_FILE || DEFAULT_ASSET_MAP_PATH;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const REPAIR_EXISTING = String(process.env.REPAIR_EXISTING || 'false').toLowerCase() === 'true';
const CREATE_MISSING_PROPERTIES = String(process.env.CREATE_MISSING_PROPERTIES || 'true').toLowerCase() !== 'false';
const REQUEST_DELAY_MS = Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 350;
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES, 10) || 5;
const DRY_RUN = String(process.env.DRY_RUN || 'false').toLowerCase() === 'true';

// Every migrated workflow is created in the destination portal with this
// prefix on its name (e.g. "Touchmath | <original name>").
const WORKFLOW_NAME_PREFIX = 'Touchmath | ';

/** The name a source workflow gets in the destination portal. */
function migratedWorkflowName(name) {
  const value = String(name || '');
  return value.startsWith(WORKFLOW_NAME_PREFIX) ? value : `${WORKFLOW_NAME_PREFIX}${value}`;
}

/** Whitespace-insensitive key for comparing workflow names. */
function workflowNameKey(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Only source workflows whose name exactly matches an entry here are
// migrated; everything else in the source portal is left untouched. Edit
// this list to change which workflows this script processes.
const WORKFLOW_NAME_ALLOWLIST = [
  'State | Indiana | FY26 - Sync to SF Campaign',
  'State | Indiana | FY26 - Send a follow-up email after form submission',
  '* FINAL Revised Email Campaign | (Starting with EM3) State - Georgia | FY26',
  '* Revised Email Campaign | (Starting with EM3) State - Georgia | FY26',
  'Conferences - CON_KS_2026.07_KASA_CY26 - Sync to SF',
  'Email Campaign | State - Georgia | FY26',
  'Database Assigning 08.04.2026',
  'State | Georgia | FY26 - Sync to SF',
  'State | TM Georgia Tier 2 | FY26 - Send a follow-up email after form submission',
  'Funding Alignment Guide - Sync to SF',
  'OD Webinar | Grades 3-5 | 5.7.26 | Sync to SF Campaign',
  'Website Forms | NYC District 75 Info Request | Sync to SF Campaign',
  'Webinar | Grades 3-5 | 5.7.26 - Handraisers | Sync to SF Campaign',
  'Webinar | Grades 3-5 | 5.7.26 - Live Attendees | Sync to SF Campaign',
  'Send a follow-up email after form submission',
  'TouchMath K - 5 Sampler | Sync to SF Campaign',
  'Grades 3-5 Sample',
  'Paid Search Book a Meeting | Sync to SF Campaign',
  'Webinar | Grades 3-5 | 5.7.26 | Registrants Sync to SF Campaign',
  'TouchMath Grades 3-5 Sampler | Sync to SF Campaign',
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

// Fields HubSpot sets/returns itself. Sending these back on create/update
// either does nothing, is rejected, or (per HubSpot's own docs) can cause
// validation errors, so they must be stripped before POSTing a new workflow.
const READ_ONLY_WORKFLOW_FIELDS = [
  'id',
  'createdAt',
  'updatedAt',
  'revisionId',
  'dataSources',
  'insertedAt',
  'migrationStatus',
  'portalId',
  'flowId',
  'archived',
  'flowStatus',
];

// actionTypeId values that reference other HubSpot assets by ID, and the
// field(s) within their `fields` object that carry that ID. Used to know
// which action fields to run through the asset-ID remapper.
const ACTION_TYPE_ID_REFERENCE_FIELDS = {
  '0-4': ['content_id'], // Send marketing email
  '0-15': ['flow_id', 'workflow_id'], // Go to workflow
  '0-63809083': ['listId', 'list_id'], // Add to static list
  '0-63863438': ['listId', 'list_id'], // Remove from static list
  '0-30': ['ads_audience_id', 'audience_id'], // Add/remove ads audience
  '0-9': ['user_ids'], // In-app notification
  '0-8': ['user_ids'], // Internal email notification
  '0-11': ['user_ids', 'team_ids'], // Rotate to owner
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

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// HubSpot HTTP layer - retries on 429/5xx, respects Retry-After, never
// swallows an error silently.
// ---------------------------------------------------------------------------

class HubSpotApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HubSpotApiError';
    this.status = status ?? null;
    this.body = body ?? null;
  }
}

async function hubspotRequest(token, method, urlPath, jsonBody) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available. Run this script with Node.js 18 or newer.');
  }

  const url = `${HUBSPOT_API_BASE}${urlPath}`;
  let attempt = 0;

  // Loop rather than recursion, so long retry chains don't grow the stack.
  for (;;) {
    attempt += 1;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
      });
    } catch (networkErr) {
      // Network-level failure (DNS, connection reset, etc.) - retry like a 5xx.
      if (attempt > MAX_RETRIES) {
        throw new HubSpotApiError(`Network error calling ${method} ${urlPath}: ${networkErr.message}`, {});
      }
      const backoffMs = Math.min(2000 * 2 ** (attempt - 1), 30000);
      console.warn(`[warn] Network error on ${method} ${urlPath} (attempt ${attempt}), retrying in ${backoffMs}ms: ${networkErr.message}`);
      await sleep(backoffMs);
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt > MAX_RETRIES) {
        const body = await safeReadBody(response);
        throw new HubSpotApiError(`HubSpot API ${method} ${urlPath} failed after ${MAX_RETRIES} retries with status ${response.status}`, {
          status: response.status,
          body,
        });
      }
      const retryAfterHeader = response.headers.get('retry-after');
      let backoffMs;
      if (retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))) {
        // HubSpot's documented rate-limit behavior returns Retry-After in seconds.
        backoffMs = Number(retryAfterHeader) * 1000;
      } else {
        backoffMs = Math.min(1000 * 2 ** (attempt - 1), 30000);
      }
      console.warn(`[warn] ${response.status} from ${method} ${urlPath} (attempt ${attempt}/${MAX_RETRIES}), waiting ${backoffMs}ms before retry`);
      await sleep(backoffMs);
      continue;
    }

    if (!response.ok) {
      const body = await safeReadBody(response);
      throw new HubSpotApiError(`HubSpot API ${method} ${urlPath} responded with ${response.status}`, {
        status: response.status,
        body,
      });
    }

    if (response.status === 204) return null;
    const body = await safeReadBody(response);
    return body;
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

// A tiny fixed delay between calls so we don't hammer HubSpot's rate limits
// even before we hit a 429 (defensive pacing, not a substitute for the
// retry/backoff logic above).
async function throttle() {
  if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Workflow read/write helpers
// ---------------------------------------------------------------------------

/** Paginates through /automation/v4/flows to list every workflow (metadata only). */
async function fetchAllWorkflowSummaries(token) {
  const summaries = [];
  let after;

  do {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    await throttle();
    const page = await hubspotRequest(token, 'GET', `${FLOWS_PATH}?${query.toString()}`);

    const results = page && Array.isArray(page.results) ? page.results : [];
    summaries.push(...results);

    after = page && page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : undefined;
  } while (after);

  return summaries;
}

/** Fetches the full definition (actions, triggers, branches, etc.) of one workflow. */
async function fetchFullWorkflow(token, flowId) {
  await throttle();
  return hubspotRequest(token, 'GET', `${FLOWS_PATH}/${flowId}`);
}

async function createWorkflow(token, workflowBody) {
  await throttle();
  return hubspotRequest(token, 'POST', FLOWS_PATH, workflowBody);
}

async function getWorkflowByIdSafe(token, flowId) {
  try {
    await throttle();
    return await hubspotRequest(token, 'GET', `${FLOWS_PATH}/${flowId}`);
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 404) return null;
    throw err;
  }
}

async function updateWorkflow(token, flowId, workflowBody) {
  await throttle();
  return hubspotRequest(token, 'PUT', `${FLOWS_PATH}/${flowId}`, workflowBody);
}

/**
 * Best-effort identity check so a misconfigured token pair (e.g. the same
 * token pasted into both env vars) is caught before creating anything.
 * Never fatal: some private apps won't have the `oauth` scope this endpoint
 * requires, in which case we just skip the check.
 */
async function fetchPortalId(token) {
  try {
    const details = await hubspotRequest(token, 'GET', '/account-info/v3/details');
    return details ? details.portalId : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Asset ID remapping
// ---------------------------------------------------------------------------

/**
 * Shape of the optional external asset-mapping file. Every section is a flat
 * { "<sourceId>": "<destinationId>" } object. Populate whichever sections are
 * relevant before running the migration (e.g. if workflows reference static
 * lists, marketing emails, owners/users, custom object type definitions, or
 * other workflows via "Go to workflow").
 */
function buildEmptyAssetMap() {
  return {
    lists: {},
    emails: {},
    forms: {},
    emailEvents: {},
    owners: {},
    objectTypes: {},
    workflows: {},
    adsAudiences: {},
  };
}

function loadAssetIdMap() {
  const loaded = readJsonFile(ASSET_ID_MAP_FILE, null);
  const empty = buildEmptyAssetMap();
  if (!loaded) {
    console.log(`[info] No asset ID mapping file found at ${ASSET_ID_MAP_FILE} - proceeding without one. ` +
      'Any list/email/owner/custom-object/workflow references embedded in migrated workflows will be left ' +
      'unchanged and flagged for manual review.');
    return empty;
  }
  console.log(`[info] Loaded asset ID mapping from ${ASSET_ID_MAP_FILE}`);
  return { ...empty, ...loaded };
}

/**
 * Cross-workflow references (e.g. a "Go to workflow" action) can't be
 * resolved from a static asset-map file, because the destination workflow
 * ID doesn't exist until THIS script creates it. Every time we're about to
 * remap a workflow, we merge in whatever source->destination workflow IDs
 * have been recorded so far (workflow_id_mapping.json, including entries
 * from earlier runs and earlier in this same run) so references to
 * already-migrated workflows resolve automatically.
 */
function withResolvedWorkflowIds(assetMap, idMapping) {
  const workflows = { ...assetMap.workflows };
  for (const entry of idMapping) {
    workflows[String(entry.sourceWorkflowId)] = String(entry.destinationWorkflowId);
  }
  return { ...assetMap, workflows };
}

/** Looks up `id` in the given asset map section; returns { mapped, value }. */
function mapAssetId(section, id) {
  if (id === undefined || id === null || id === '') return { mapped: false, value: id };
  const key = String(id);
  if (Object.prototype.hasOwnProperty.call(section, key)) {
    return { mapped: true, value: section[key] };
  }
  return { mapped: false, value: id };
}

/**
 * Walks a workflow's actions and enrollment criteria, remapping known
 * HubSpot object-ID references using assetMap. Any reference it recognizes
 * but cannot find a mapping for is pushed into `unresolvedRefs` so it can be
 * surfaced for manual review rather than silently left as a source-portal ID.
 */
function remapWorkflowReferences(workflow, assetMap, unresolvedRefs) {
  const clone = deepClone(workflow);

  const noteUnresolved = (kind, sourceId, where, actionId) => {
    const entry = { kind, sourceId: String(sourceId), where };
    if (actionId !== undefined) entry.actionId = String(actionId);
    unresolvedRefs.push(entry);
  };

  // Top-level custom object type (contact/company/deal use fixed IDs like
  // 0-1 which are identical across portals; custom objects use portal-scoped
  // IDs like 2-xxxxxxx which do need remapping).
  if (clone.objectTypeId && /^2-/.test(String(clone.objectTypeId))) {
    const { mapped, value } = mapAssetId(assetMap.objectTypes, clone.objectTypeId);
    if (mapped) clone.objectTypeId = value;
    else noteUnresolved('objectType', clone.objectTypeId, 'objectTypeId');
  }

  const remapActionFields = (action, actionPath) => {
    if (!action || typeof action !== 'object') return;
    const referenceFields = ACTION_TYPE_ID_REFERENCE_FIELDS[action.actionTypeId];
    if (referenceFields && action.fields && typeof action.fields === 'object') {
      for (const fieldName of referenceFields) {
        if (!(fieldName in action.fields)) continue;
        const rawValue = action.fields[fieldName];

        const section =
          fieldName === 'content_id' ? assetMap.emails :
          fieldName === 'flow_id' || fieldName === 'workflow_id' ? assetMap.workflows :
          fieldName === 'listId' || fieldName === 'list_id' ? assetMap.lists :
          fieldName === 'user_ids' || fieldName === 'team_ids' ? assetMap.owners :
          fieldName === 'ads_audience_id' || fieldName === 'audience_id' ? assetMap.adsAudiences :
          null;
        if (!section) continue;

        if (Array.isArray(rawValue)) {
          action.fields[fieldName] = rawValue.map((id) => {
            const { mapped, value } = mapAssetId(section, id);
            if (!mapped) noteUnresolved(fieldName, id, `${actionPath}.fields.${fieldName}`, action.actionId);
            return value;
          });
        } else {
          const { mapped, value } = mapAssetId(section, rawValue);
          if (mapped) action.fields[fieldName] = value;
          else noteUnresolved(fieldName, rawValue, `${actionPath}.fields.${fieldName}`, action.actionId);
        }
      }
    }

    // "object_type_id" shows up on create-record / edit-record style actions.
    if (action.fields && typeof action.fields.object_type_id === 'string' && /^2-/.test(action.fields.object_type_id)) {
      const { mapped, value } = mapAssetId(assetMap.objectTypes, action.fields.object_type_id);
      if (mapped) action.fields.object_type_id = value;
      else noteUnresolved('objectType', action.fields.object_type_id, `${actionPath}.fields.object_type_id`);
    }
  };

  if (Array.isArray(clone.actions)) {
    clone.actions.forEach((action, index) => remapActionFields(action, `actions[${index}]`));
  }

  // List-membership based enrollment/re-enrollment/unenrollment criteria and
  // "IN_LIST"/"NOT_IN_LIST" filters embed static list IDs as filter values.
  const remapListFilterValues = (filters, wherePrefix) => {
    if (!Array.isArray(filters)) return;
    filters.forEach((filter, index) => {
      const operator = filter && filter.operation && filter.operation.operator;
      if (operator === 'IN_LIST' || operator === 'NOT_IN_LIST') {
        const values = filter.operation.values || [];
        filter.operation.values = values.map((id) => {
          const { mapped, value } = mapAssetId(assetMap.lists, id);
          if (!mapped) noteUnresolved('list', id, `${wherePrefix}[${index}].operation.values`);
          return value;
        });
      }
    });
  };

  const enrollment = clone.enrollmentCriteria;
  if (enrollment) {
    if (Array.isArray(enrollment.eventFilterBranches)) {
      enrollment.eventFilterBranches.forEach((branch, i) =>
        remapListFilterValues(branch.filters, `enrollmentCriteria.eventFilterBranches[${i}].filters`));
    }
    if (Array.isArray(enrollment.listMembershipFilterBranches)) {
      enrollment.listMembershipFilterBranches.forEach((branch, i) =>
        remapListFilterValues(branch.filters, `enrollmentCriteria.listMembershipFilterBranches[${i}].filters`));
    }
    if (enrollment.listFilterBranch && Array.isArray(enrollment.listFilterBranch.filterBranches)) {
      enrollment.listFilterBranch.filterBranches.forEach((branch, i) =>
        remapListFilterValues(branch.filters, `enrollmentCriteria.listFilterBranch.filterBranches[${i}].filters`));
    }
    if (Array.isArray(enrollment.reEnrollmentTriggersFilterBranches)) {
      enrollment.reEnrollmentTriggersFilterBranches.forEach((branch, i) =>
        remapListFilterValues(branch.filters, `enrollmentCriteria.reEnrollmentTriggersFilterBranches[${i}].filters`));
    }
  }

  // Filters store their asset IDs directly on the filter object, and can be
  // nested at any depth (enrollment, re-enrollment triggers, and branch
  // actions' listBranches), so walk the whole tree. Action `fields` are
  // handled by remapActionFields above and are skipped here.
  const remapFilterNode = (node, where) => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => remapFilterNode(child, `${where}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const remapKey = (key, section, kind) => {
      if (node[key] === undefined || node[key] === null || node[key] === '') return;
      const { mapped, value } = mapAssetId(section, node[key]);
      if (mapped) node[key] = value;
      else noteUnresolved(kind, node[key], `${where}.${key}`);
    };
    if (node.filterType === 'FORM_SUBMISSION') remapKey('formId', assetMap.forms, 'form');
    if (node.filterType === 'IN_LIST') remapKey('listId', assetMap.lists, 'list');
    if (node.filterType === 'EMAIL_EVENT') remapKey('emailId', assetMap.emailEvents, 'emailEvent');
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'fields' && value && typeof value === 'object') remapFilterNode(value, `${where}.${key}`);
    }
  };
  remapFilterNode(clone.enrollmentCriteria, 'enrollmentCriteria');
  remapFilterNode(clone.actions, 'actions');

  if (Array.isArray(clone.suppressionListIds) && clone.suppressionListIds.length) {
    clone.suppressionListIds = clone.suppressionListIds.map((id) => {
      const { mapped, value } = mapAssetId(assetMap.lists, id);
      if (!mapped) noteUnresolved('list', id, 'suppressionListIds');
      return value;
    });
  }

  return clone;
}

// ---------------------------------------------------------------------------
// Preparing a workflow body for creation
// ---------------------------------------------------------------------------

function sanitizeForCreate(workflow) {
  const body = deepClone(workflow);
  for (const field of READ_ONLY_WORKFLOW_FIELDS) {
    delete body[field];
  }
  // Never bring source-portal Salesforce enrollment linkage across; it is
  // portal-specific integration state, not workflow configuration.
  body.canEnrollFromSalesforce = false;
  // Always create unpublished (OFF); workflows are reviewed and turned on
  // manually in the destination portal.
  body.isEnabled = false;
  if (typeof body.name === 'string') body.name = migratedWorkflowName(body.name);
  return body;
}

/**
 * Per HubSpot's update-workflow guidance: a PUT must include `revisionId`
 * and `type`, and `createdAt`/`updatedAt`/`dataSources` should be stripped
 * from data that came from an earlier GET to avoid validation errors. Unlike
 * create, `id` and `revisionId` are kept since PUT is a full-document update
 * of an existing workflow.
 */
function sanitizeForUpdate(workflow) {
  const body = deepClone(workflow);
  delete body.createdAt;
  delete body.updatedAt;
  delete body.dataSources;
  // Never let an update from this script turn a workflow on.
  body.isEnabled = false;
  return body;
}

// ---------------------------------------------------------------------------
// Post-creation validation
// ---------------------------------------------------------------------------

const FIELDS_TO_VALIDATE = [
  'name',
  'description',
  'flowType',
  'type',
  'objectTypeId',
  'startActionId',
  'nextAvailableActionId',
  'actions',
  'enrollmentCriteria',
  'timeWindows',
  'blockedDates',
  'customProperties',
  'suppressionListIds',
  'isEnabled',
];

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(a[key], b[key]));
}

/**
 * Compares the workflow as it was actually created in the destination portal
 * against the "expected" shape (the source workflow after read-only-field
 * stripping and asset-ID remapping). Returns a list of field-level mismatches;
 * an empty list means validation passed.
 */
function validateMigratedWorkflow(expectedBody, actualDestWorkflow) {
  const mismatches = [];
  for (const field of FIELDS_TO_VALIDATE) {
    const expectedHasField = Object.prototype.hasOwnProperty.call(expectedBody, field);
    const actualHasField = Object.prototype.hasOwnProperty.call(actualDestWorkflow, field);
    if (!expectedHasField && !actualHasField) continue;
    // HubSpot upgrades each action's actionTypeVersion on create; that is
    // not a content difference, so leave it out of the comparison.
    const comparable = (w) => (field === 'actions' && Array.isArray(w[field])
      ? w[field].map(({ actionTypeVersion, ...rest }) => rest)
      : w[field]);
    if (!deepEqual(comparable(expectedBody), comparable(actualDestWorkflow))) {
      mismatches.push(field);
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// Log stores (success / errors / id mapping) - loaded at start so re-runs
// append rather than overwrite, saved after every workflow so a crash
// mid-run doesn't lose progress already made.
// ---------------------------------------------------------------------------

function loadLogState() {
  return {
    successLog: readJsonFile(SUCCESS_LOG_PATH, []),
    errorLog: readJsonFile(ERROR_LOG_PATH, []),
    idMapping: readJsonFile(ID_MAPPING_PATH, []),
  };
}

function saveLogState(state) {
  writeJsonFile(SUCCESS_LOG_PATH, state.successLog);
  writeJsonFile(ERROR_LOG_PATH, state.errorLog);
  writeJsonFile(ID_MAPPING_PATH, state.idMapping);
}

function findMappingBySourceId(idMapping, sourceId) {
  return idMapping.find((entry) => String(entry.sourceWorkflowId) === String(sourceId));
}

// ---------------------------------------------------------------------------
// Automatic asset mapping by name (forms, lists, marketing emails)
// ---------------------------------------------------------------------------

async function fetchAllPaged(token, basePath) {
  const results = [];
  let after;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    await throttle();
    const page = await hubspotRequest(token, 'GET', `${basePath}?${query.toString()}`);
    results.push(...((page && page.results) || []));
    after = page && page.paging && page.paging.next ? page.paging.next.after : undefined;
  } while (after);
  return results;
}

async function fetchAllLists(token) {
  const lists = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    await throttle();
    const page = await hubspotRequest(token, 'POST', '/crm/v3/lists/search', { offset, count: 500 });
    lists.push(...((page && page.lists) || []));
    hasMore = Boolean(page && page.hasMore);
    offset = page ? page.offset : 0;
  }
  return lists;
}

const normalizeAssetName = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
// Assets migrated by the other scripts in this project carry a brand prefix.
const stripBrandPrefix = (normalized) => normalized.replace(/^touchmath\s*[-|]\s*/, '');

/**
 * Fills assetMap.forms / .lists / .emails with source ID -> destination ID
 * pairs by matching names. Entries already present (from ASSET_ID_MAP_FILE)
 * win. Only a single, unambiguous destination match is accepted; lists must
 * also be for the same object type.
 */
async function autoMapAssetsByName(sourceToken, destToken, assetMap) {
  const sections = [
    { key: 'forms', label: 'forms', fetch: (t) => fetchAllPaged(t, '/marketing/v3/forms'), id: (x) => x.id, group: () => '' },
    { key: 'lists', label: 'lists', fetch: fetchAllLists, id: (x) => x.listId, group: (x) => x.objectTypeId || '' },
    { key: 'emails', label: 'marketing emails', fetch: (t) => fetchAllPaged(t, '/marketing/v3/emails'), id: (x) => x.id, group: () => '' },
  ];

  for (const section of sections) {
    let sourceItems;
    let destItems;
    try {
      [sourceItems, destItems] = [await section.fetch(sourceToken), await section.fetch(destToken)];
    } catch (err) {
      const status = err instanceof HubSpotApiError ? ` (HTTP ${err.status})` : '';
      console.warn(`[warn] Could not auto-map ${section.label} by name${status}: ${err.message}. ` +
        `Grant the read scope for ${section.label} to both private apps, or add them to ${path.basename(ASSET_ID_MAP_FILE)}.`);
      continue;
    }

    const exact = new Map();
    const stripped = new Map();
    const add = (index, key, id) => index.set(key, [...(index.get(key) || []), String(id)]);
    for (const item of destItems) {
      const name = normalizeAssetName(item.name);
      if (!name) continue;
      add(exact, `${section.group(item)}|${name}`, section.id(item));
      add(stripped, `${section.group(item)}|${stripBrandPrefix(name)}`, section.id(item));
    }

    let mapped = 0;
    let ambiguous = 0;
    for (const item of sourceItems) {
      const sourceId = String(section.id(item));
      if (Object.prototype.hasOwnProperty.call(assetMap[section.key], sourceId)) continue;
      const key = `${section.group(item)}|${normalizeAssetName(item.name)}`;
      const candidates = exact.get(key) || stripped.get(key) || [];
      if (candidates.length === 1) {
        assetMap[section.key][sourceId] = candidates[0];
        mapped += 1;
      } else if (candidates.length > 1) {
        ambiguous += 1;
      }
    }
    console.log(`[info] Auto-mapped ${mapped} of ${sourceItems.length} source ${section.label} to the destination by name` +
      (ambiguous ? ` (${ambiguous} skipped: more than one destination match)` : '') + '.');
  }
}

// ---------------------------------------------------------------------------
// Properties a workflow depends on
// ---------------------------------------------------------------------------

const DEFAULT_PROPERTY_GROUPS = { '0-1': 'contactinformation', '0-2': 'companyinformation', '0-3': 'dealinformation' };

/** Property names used by PROPERTY filters and "set property" actions. */
function collectWorkflowPropertyNames(workflow) {
  const names = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.filterType === 'PROPERTY' && typeof node.property === 'string') names.add(node.property);
    Object.values(node).forEach(walk);
  };
  walk(workflow.enrollmentCriteria);
  walk(workflow.actions);
  for (const action of workflow.actions || []) {
    if (action.actionTypeId === '0-5' && action.fields && typeof action.fields.property_name === 'string') {
      names.add(action.fields.property_name);
    }
  }
  return [...names];
}

async function getPropertySafe(token, objectTypeId, name) {
  try {
    await throttle();
    return await hubspotRequest(token, 'GET', `/crm/v3/properties/${objectTypeId}/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Makes sure every property the workflow uses exists in the destination,
 * copying missing ones from the source when CREATE_MISSING_PROPERTIES is on.
 * Returns the names that are still missing (the workflow must be held).
 * `cache` remembers names already confirmed/created during this run.
 */
async function ensureWorkflowProperties(workflow, sourceToken, destToken, dryRun, cache) {
  const objectTypeId = workflow.objectTypeId;
  const missing = [];
  if (!objectTypeId) return missing;

  for (const name of collectWorkflowPropertyNames(workflow)) {
    const cacheKey = `${objectTypeId}|${name}`;
    if (cache.has(cacheKey)) continue;
    if (await getPropertySafe(destToken, objectTypeId, name)) {
      cache.add(cacheKey);
      continue;
    }
    const sourceProp = await getPropertySafe(sourceToken, objectTypeId, name);
    // Not a property of this object in the source either (e.g. a filter on
    // an associated object) - nothing we can copy, leave it to validation.
    if (!sourceProp) continue;

    if (dryRun) {
      console.log(`[dry-run] Would create missing ${objectTypeId} property "${name}" (${sourceProp.label}) in the destination.`);
      continue;
    }
    if (!CREATE_MISSING_PROPERTIES) {
      missing.push(name);
      continue;
    }

    const body = {
      name: sourceProp.name,
      label: sourceProp.label,
      type: sourceProp.type,
      fieldType: sourceProp.fieldType,
      groupName: sourceProp.groupName,
      description: sourceProp.description || '',
      displayOrder: sourceProp.displayOrder,
      hasUniqueValue: Boolean(sourceProp.hasUniqueValue),
      hidden: Boolean(sourceProp.hidden),
      formField: Boolean(sourceProp.formField),
      options: (sourceProp.options || []).map(({ label, value, description, displayOrder, hidden }) =>
        ({ label, value, description, displayOrder, hidden })),
    };
    try {
      await throttle();
      await hubspotRequest(destToken, 'POST', `/crm/v3/properties/${objectTypeId}`, body);
    } catch (err) {
      // The source property group may not exist in the destination; retry
      // once in the object's default group.
      const fallbackGroup = DEFAULT_PROPERTY_GROUPS[objectTypeId];
      if (!(err instanceof HubSpotApiError && err.status === 400 && fallbackGroup && body.groupName !== fallbackGroup)) throw err;
      await throttle();
      await hubspotRequest(destToken, 'POST', `/crm/v3/properties/${objectTypeId}`, { ...body, groupName: fallbackGroup });
      body.groupName = fallbackGroup;
    }
    cache.add(cacheKey);
    console.log(`[property] Created ${objectTypeId} property "${name}" (${body.label}) in the destination (group "${body.groupName}").`);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Holding workflows with unmapped references
// ---------------------------------------------------------------------------

// Cross-workflow references are resolved in a second pass after all
// workflows exist, so they never block a workflow on their own.
const DEFERRED_REFERENCE_KINDS = new Set(['flow_id', 'workflow_id']);

function blockingReferences(unresolvedRefs) {
  return unresolvedRefs.filter((r) => !DEFERRED_REFERENCE_KINDS.has(r.kind));
}

function logHeldWorkflow(state, sourceId, workflowName, blocking, allRefs, note) {
  const summary = [...new Set(blocking.map((r) => `${r.kind} ${r.sourceId}`))].join(', ');
  console.warn(`[hold] "${workflowName}" (source ${sourceId}) has unmapped reference(s): ${summary}; ${note}`);
  state.errorLog.push({
    sourceWorkflowId: sourceId,
    sourceWorkflowName: workflowName,
    errorStatus: 'held_unmapped_references',
    httpStatusCode: null,
    errorMessage: `Held: ${note} Migrate the referenced form/list/email/property to the destination (or add its ID to ` +
      `${path.basename(ASSET_ID_MAP_FILE)}), then re-run.`,
    apiResponse: { unresolvedAssetReferences: allRefs },
    timestamp: nowIso(),
  });
}

// ---------------------------------------------------------------------------
// Repairing an already-migrated workflow in place (REPAIR_EXISTING=true)
// ---------------------------------------------------------------------------

const REPAIRABLE_FIELDS = [
  'name', 'description', 'startActionId', 'nextAvailableActionId', 'actions', 'enrollmentCriteria',
  'timeWindows', 'blockedDates', 'customProperties', 'suppressionListIds',
];

async function repairExistingWorkflow(summary, destFull, ctx) {
  const { sourceToken, destToken, assetMap, state, dryRun, propertyCache } = ctx;
  const sourceId = String(summary.id);
  const destinationId = String(destFull.id);
  const name = summary.name || `(unnamed workflow ${sourceId})`;

  // Once someone has reviewed and turned a workflow on, it's theirs.
  if (destFull.isEnabled) {
    console.log(`[skip] "${name}" (destination ${destinationId}) is turned ON in the destination; not modifying it.`);
    return { status: 'skipped' };
  }

  try {
    const fullSource = await fetchFullWorkflow(sourceToken, sourceId);
    const unresolvedRefs = [];
    const remapped = remapWorkflowReferences(fullSource, withResolvedWorkflowIds(assetMap, state.idMapping), unresolvedRefs);
    const desired = sanitizeForCreate(remapped);

    const blocking = blockingReferences(unresolvedRefs);
    if (blocking.length) {
      logHeldWorkflow(state, sourceId, fullSource.name || name, blocking, unresolvedRefs,
        `existing destination workflow ${destinationId} left unchanged (still OFF).`);
      return { status: 'held' };
    }
    const missingProps = await ensureWorkflowProperties(desired, sourceToken, destToken, dryRun, propertyCache);
    if (missingProps.length) {
      const refs = missingProps.map((p) => ({ kind: 'property', sourceId: p, where: 'property' }));
      logHeldWorkflow(state, sourceId, fullSource.name || name, refs, refs,
        `existing destination workflow ${destinationId} left unchanged (still OFF).`);
      return { status: 'held' };
    }

    const drift = validateMigratedWorkflow(desired, destFull).filter((f) => f !== 'isEnabled');
    if (drift.length === 0) {
      console.log(`[skip] "${name}" (destination ${destinationId}) already matches the source.`);
      return { status: 'skipped' };
    }
    if (dryRun) {
      console.log(`[dry-run] Would repair "${name}" (destination ${destinationId}): ${drift.join(', ')}`);
      return { status: 'dry_run' };
    }

    const body = { ...destFull };
    for (const field of REPAIRABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(desired, field)) body[field] = desired[field];
    }
    await updateWorkflow(destToken, destinationId, sanitizeForUpdate(body));

    const after = await getWorkflowByIdSafe(destToken, destinationId);
    const mismatches = after ? validateMigratedWorkflow(desired, after) : ['(could not re-fetch destination workflow to validate)'];
    const ok = mismatches.length === 0 && unresolvedRefs.length === 0;

    state.successLog.push({
      sourceWorkflowId: sourceId,
      sourceWorkflowName: fullSource.name || name,
      destinationWorkflowId: destinationId,
      destinationWorkflowName: desired.name,
      migrationStatus: ok ? 'repaired' : 'repaired_with_validation_warnings',
      repairedFields: drift,
      timestamp: nowIso(),
    });
    if (!ok) {
      state.errorLog.push({
        sourceWorkflowId: sourceId,
        sourceWorkflowName: fullSource.name || name,
        errorStatus: 'validation_failed',
        httpStatusCode: null,
        errorMessage: `Workflow was repaired in place (destination ID ${destinationId}) but validation found differences requiring manual review.`,
        apiResponse: { fieldMismatches: mismatches, unresolvedAssetReferences: unresolvedRefs },
        timestamp: nowIso(),
      });
    }
    console.log(`[repair] Updated "${name}" (destination ${destinationId}): ${drift.join(', ')}${ok ? '' : ' [needs manual review]'}`);
    return { status: ok ? 'repaired' : 'repaired_with_warnings' };
  } catch (err) {
    const isHubSpotErr = err instanceof HubSpotApiError;
    state.errorLog.push({
      sourceWorkflowId: sourceId,
      sourceWorkflowName: name,
      errorStatus: 'repair_failed',
      httpStatusCode: isHubSpotErr ? err.status : null,
      errorMessage: err.message,
      apiResponse: isHubSpotErr ? err.body : null,
      timestamp: nowIso(),
    });
    console.error(`[error] Failed to repair "${name}" (destination ${destinationId}): ${err.message}`);
    return { status: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Per-workflow migration
// ---------------------------------------------------------------------------

async function migrateOneWorkflow(summary, ctx) {
  const { sourceToken, destToken, assetMap, state, dryRun, propertyCache } = ctx;
  const sourceId = String(summary.id);
  const sourceNameHint = summary.name || `(unnamed workflow ${sourceId})`;

  // --- Idempotency check: already migrated in a previous run? ---
  const existingMapping = findMappingBySourceId(state.idMapping, sourceId);
  if (existingMapping) {
    const stillExists = await getWorkflowByIdSafe(destToken, existingMapping.destinationWorkflowId);
    if (stillExists) {
      if (REPAIR_EXISTING) return repairExistingWorkflow(summary, stillExists, ctx);
      console.log(`[skip] "${sourceNameHint}" (source ${sourceId}) already migrated -> destination ${existingMapping.destinationWorkflowId}`);
      return { status: 'skipped' };
    }
    console.warn(`[warn] Mapping for source ${sourceId} points to destination workflow ${existingMapping.destinationWorkflowId}, which no longer exists there.`);
  }

  // --- Second idempotency check: a destination workflow with the migrated
  //     name already exists (e.g. the mapping file was lost or reset). Adopt
  //     it into the mapping instead of creating a duplicate. ---
  const sameNameIds = ctx.destWorkflowIdsByName.get(workflowNameKey(migratedWorkflowName(sourceNameHint))) || [];
  if (sameNameIds.length) {
    const adoptedId = sameNameIds[0];
    if (sameNameIds.length > 1) {
      console.warn(`[warn] ${sameNameIds.length} destination workflows are named "${migratedWorkflowName(sourceNameHint).trim()}" (${sameNameIds.join(', ')}); using ${adoptedId}. Review and delete the duplicates.`);
    }
    const existing = await getWorkflowByIdSafe(destToken, adoptedId);
    if (existing) {
      if (!dryRun) {
        const mappingEntry = { sourceWorkflowId: sourceId, destinationWorkflowId: String(adoptedId), workflowName: sourceNameHint, migratedAt: nowIso() };
        const index = state.idMapping.findIndex((e) => String(e.sourceWorkflowId) === sourceId);
        if (index >= 0) state.idMapping[index] = mappingEntry;
        else state.idMapping.push(mappingEntry);
      }
      console.log(`[adopt] "${sourceNameHint}" (source ${sourceId}) already exists in the destination as ${adoptedId}; not creating it again.`);
      if (REPAIR_EXISTING) return repairExistingWorkflow(summary, existing, ctx);
      return { status: 'skipped' };
    }
  }

  try {
    // --- Fetch full source workflow definition ---
    const fullSource = await fetchFullWorkflow(sourceToken, sourceId);
    if (!fullSource) {
      throw new HubSpotApiError(`Source workflow ${sourceId} returned an empty response`, {});
    }

    // --- Remap embedded asset references, sanitize read-only fields ---
    const unresolvedRefs = [];
    const effectiveAssetMap = withResolvedWorkflowIds(assetMap, state.idMapping);
    const remapped = remapWorkflowReferences(fullSource, effectiveAssetMap, unresolvedRefs);
    const createBody = sanitizeForCreate(remapped);

    // --- Hold back workflows with references we couldn't map ---
    // Creating them now would leave triggers/steps pointing at source-portal
    // form/list/email IDs, which in the destination either don't exist or,
    // worse, belong to unrelated assets. They are retried on the next run.
    const blocking = blockingReferences(unresolvedRefs);
    if (blocking.length) {
      logHeldWorkflow(state, sourceId, fullSource.name || sourceNameHint, blocking, unresolvedRefs, 'not migrated this run.');
      return { status: 'held' };
    }

    // --- Properties the workflow filters on or sets must exist ---
    const missingProps = await ensureWorkflowProperties(createBody, sourceToken, destToken, dryRun, propertyCache);
    if (missingProps.length) {
      const refs = missingProps.map((p) => ({ kind: 'property', sourceId: p, where: 'property' }));
      logHeldWorkflow(state, sourceId, fullSource.name || sourceNameHint, refs, refs, 'not migrated this run.');
      return { status: 'held' };
    }

    if (dryRun) {
      console.log(`[dry-run] Would migrate "${fullSource.name || sourceNameHint}" (source ${sourceId})` +
        (unresolvedRefs.length ? ` - ${unresolvedRefs.length} unresolved asset reference(s), see below` : ''));
      if (unresolvedRefs.length) console.log(JSON.stringify(unresolvedRefs, null, 2));
      state.successLog.push({
        sourceWorkflowId: sourceId,
        sourceWorkflowName: fullSource.name || sourceNameHint,
        destinationWorkflowId: null,
        destinationWorkflowName: createBody.name,
        migrationStatus: 'dry_run',
        timestamp: nowIso(),
      });
      return { status: 'dry_run' };
    }

    // --- Create in destination portal ---
    const created = await createWorkflow(destToken, createBody);
    const destinationId = String(created.id);
    ctx.destWorkflowIdsByName.set(workflowNameKey(createBody.name), [destinationId]);

    // --- Validate what actually landed in the destination portal ---
    let destFull = await getWorkflowByIdSafe(destToken, destinationId);

    // Safety net: if the destination somehow came back ON, turn it OFF now
    // so it cannot enroll anything before manual review.
    if (destFull && destFull.isEnabled) {
      console.warn(`[warn] Destination workflow ${destinationId} came back enabled; turning it off.`);
      await updateWorkflow(destToken, destinationId, sanitizeForUpdate(destFull));
      destFull = await getWorkflowByIdSafe(destToken, destinationId);
    }
    const mismatches = destFull ? validateMigratedWorkflow(createBody, destFull) : ['(could not re-fetch destination workflow to validate)'];
    const validationPassed = mismatches.length === 0 && unresolvedRefs.length === 0;

    // --- Record mapping (upsert) ---
    const mappingEntry = {
      sourceWorkflowId: sourceId,
      destinationWorkflowId: destinationId,
      workflowName: fullSource.name || sourceNameHint,
      migratedAt: nowIso(),
    };
    const existingIndex = state.idMapping.findIndex((e) => String(e.sourceWorkflowId) === sourceId);
    if (existingIndex >= 0) state.idMapping[existingIndex] = mappingEntry;
    else state.idMapping.push(mappingEntry);

    // --- Success log entry ---
    state.successLog.push({
      sourceWorkflowId: sourceId,
      sourceWorkflowName: fullSource.name || sourceNameHint,
      destinationWorkflowId: destinationId,
      destinationWorkflowName: created.name || fullSource.name || sourceNameHint,
      migrationStatus: validationPassed ? 'success' : 'success_with_validation_warnings',
      timestamp: nowIso(),
    });

    // --- Any validation issues or unmapped references go to the error log
    //     too, so they surface clearly without being treated as a hard
    //     migration failure (the workflow WAS created). ---
    if (!validationPassed) {
      state.errorLog.push({
        sourceWorkflowId: sourceId,
        sourceWorkflowName: fullSource.name || sourceNameHint,
        errorStatus: 'validation_failed',
        httpStatusCode: null,
        errorMessage: `Workflow was created (destination ID ${destinationId}) but validation found differences requiring manual review.`,
        apiResponse: {
          fieldMismatches: mismatches,
          unresolvedAssetReferences: unresolvedRefs,
        },
        timestamp: nowIso(),
      });
    }

    console.log(`[ok] Migrated "${fullSource.name || sourceNameHint}" (source ${sourceId} -> destination ${destinationId})${validationPassed ? '' : ' [needs manual review]'}`);
    return { status: validationPassed ? 'success' : 'success_with_warnings' };
  } catch (err) {
    const isHubSpotErr = err instanceof HubSpotApiError;
    state.errorLog.push({
      sourceWorkflowId: sourceId,
      sourceWorkflowName: sourceNameHint,
      errorStatus: 'migration_failed',
      httpStatusCode: isHubSpotErr ? err.status : null,
      errorMessage: err.message,
      apiResponse: isHubSpotErr ? err.body : null,
      timestamp: nowIso(),
    });
    console.error(`[error] Failed to migrate "${sourceNameHint}" (source ${sourceId}): ${err.message}`);
    return { status: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Forward cross-workflow reference resolution
// ---------------------------------------------------------------------------

/**
 * "Go to workflow" (and similar) actions reference another workflow by ID.
 * If that other workflow hadn't been migrated yet when its referrer was
 * created, the reference was left unresolved and flagged in the error log.
 * Now that every workflow in this run has been created, re-check those
 * specific unresolved references against the final id mapping and, for any
 * that are now resolvable, PATCH (via PUT, which HubSpot requires to be a
 * full-document replace) just that field into the already-created
 * destination workflow.
 */
async function resolveForwardWorkflowReferences(destToken, state) {
  const finalWorkflowMap = Object.fromEntries(state.idMapping.map((e) => [String(e.sourceWorkflowId), String(e.destinationWorkflowId)]));
  let resolvedCount = 0;

  for (const errorEntry of state.errorLog) {
    if (errorEntry.errorStatus !== 'validation_failed' || !errorEntry.apiResponse) continue;
    const unresolved = errorEntry.apiResponse.unresolvedAssetReferences || [];
    const flowRefs = unresolved.filter((r) => (r.kind === 'flow_id' || r.kind === 'workflow_id') && r.actionId && finalWorkflowMap[r.sourceId]);
    if (flowRefs.length === 0) continue;

    const mappingEntry = findMappingBySourceId(state.idMapping, errorEntry.sourceWorkflowId);
    if (!mappingEntry) continue; // the referring workflow itself was never created; nothing to patch.

    try {
      const destFull = await getWorkflowByIdSafe(destToken, mappingEntry.destinationWorkflowId);
      if (!destFull) continue;

      let changed = false;
      for (const ref of flowRefs) {
        const action = (destFull.actions || []).find((a) => String(a.actionId) === ref.actionId);
        if (!action || !action.fields) continue;
        const fieldName = ref.kind; // 'flow_id' or 'workflow_id'
        if (fieldName in action.fields) {
          action.fields[fieldName] = finalWorkflowMap[ref.sourceId];
          changed = true;
        }
      }
      if (!changed) continue;

      await updateWorkflow(destToken, mappingEntry.destinationWorkflowId, sanitizeForUpdate(destFull));
      console.log(`[fixup] Resolved ${flowRefs.length} cross-workflow reference(s) in "${errorEntry.sourceWorkflowName}" (destination ${mappingEntry.destinationWorkflowId})`);

      // Remove the now-resolved references; drop the error entry entirely if
      // nothing else is outstanding, and upgrade the matching success entry.
      errorEntry.apiResponse.unresolvedAssetReferences = unresolved.filter((r) => !flowRefs.includes(r));
      resolvedCount += 1;

      if (errorEntry.apiResponse.unresolvedAssetReferences.length === 0 && (errorEntry.apiResponse.fieldMismatches || []).length === 0) {
        const successEntry = state.successLog.find((s) => s.sourceWorkflowId === errorEntry.sourceWorkflowId && s.destinationWorkflowId === mappingEntry.destinationWorkflowId);
        if (successEntry) successEntry.migrationStatus = 'success';
      }
    } catch (err) {
      console.warn(`[warn] Could not patch cross-workflow reference(s) for source ${errorEntry.sourceWorkflowId}: ${err.message}`);
    }
  }

  // Drop fully-resolved error entries so the error log only reflects what's
  // actually still outstanding.
  state.errorLog = state.errorLog.filter((e) => {
    if (e.errorStatus !== 'validation_failed' || !e.apiResponse) return true;
    const stillHasIssues = (e.apiResponse.unresolvedAssetReferences || []).length > 0 || (e.apiResponse.fieldMismatches || []).length > 0;
    return stillHasIssues;
  });

  return resolvedCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sourceToken = process.env.SOURCE_HUBSPOT_TOKEN;
  const destToken = process.env.DESTINATION_HUBSPOT_TOKEN;

  if (!sourceToken || !destToken) {
    console.error('[fatal] SOURCE_HUBSPOT_TOKEN and DESTINATION_HUBSPOT_TOKEN environment variables are both required.');
    process.exitCode = 1;
    return;
  }

  if (sourceToken === destToken) {
    console.error('[fatal] SOURCE_HUBSPOT_TOKEN and DESTINATION_HUBSPOT_TOKEN are identical. Refusing to run: this ' +
      'would create duplicate workflows inside the same portal instead of migrating to a different one.');
    process.exitCode = 1;
    return;
  }

  // Best-effort sanity check: confirm the two tokens really do belong to two
  // different HubSpot accounts before touching anything. Never fatal on its
  // own (the `oauth` scope this needs may not be granted), but if both
  // portal IDs resolve and are equal, that's a configuration mistake worth
  // stopping for.
  const [sourcePortalId, destPortalId] = await Promise.all([fetchPortalId(sourceToken), fetchPortalId(destToken)]);
  if (sourcePortalId && destPortalId) {
    console.log(`[info] Source portal ID: ${sourcePortalId} | Destination portal ID: ${destPortalId}`);
    if (sourcePortalId === destPortalId) {
      console.error('[fatal] Source and destination tokens both resolve to the same HubSpot portal ID. Aborting.');
      process.exitCode = 1;
      return;
    }
  } else {
    console.log('[info] Could not verify source/destination portal IDs (missing `oauth` scope or endpoint unavailable) - proceeding anyway.');
  }

  if (DRY_RUN) {
    console.log('[info] DRY_RUN=true - no workflows will be created in the destination portal. This run only reports what would happen.');
  }

  // Pre-flight: both tokens need the `automation` scope. Checking up front
  // stops the run with one clear message instead of a 403 per workflow.
  for (const [label, token] of [['source', sourceToken], ['destination', destToken]]) {
    try {
      await throttle();
      await hubspotRequest(token, 'GET', `${FLOWS_PATH}?limit=1`);
    } catch (err) {
      if (err instanceof HubSpotApiError && (err.status === 401 || err.status === 403)) {
        console.error(`[fatal] The ${label} portal token cannot access workflows (HTTP ${err.status}). Add the \`automation\` scope to the ${label} private app (Settings > Integrations > Private Apps > Scopes) and re-run. No workflows were migrated.`);
        if (err.body) console.error(`         ${JSON.stringify(err.body)}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  }

  const assetMap = loadAssetIdMap();
  await autoMapAssetsByName(sourceToken, destToken, assetMap);
  const state = loadLogState();
  if (REPAIR_EXISTING) {
    console.log('[info] REPAIR_EXISTING=true - already-migrated workflows that differ from the source will be updated in place (kept OFF).');
  }

  console.log('[info] Fetching workflow list from source portal...');
  let summaries;
  try {
    summaries = await fetchAllWorkflowSummaries(sourceToken);
  } catch (err) {
    console.error(`[fatal] Could not list source workflows: ${err.message}`);
    if (err instanceof HubSpotApiError) {
      console.error(`         status=${err.status} body=${JSON.stringify(err.body)}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[info] Found ${summaries.length} workflow(s) in the source portal.`);

  // Compare names with runs of whitespace collapsed, so stray double/trailing
  // spaces in source-portal names don't cause a miss.
  const normalizeName = (n) => String(n || '').replace(/\s+/g, ' ').trim();
  const allowlist = WORKFLOW_NAME_ALLOWLIST.map(normalizeName);
  const allowlistSet = new Set(allowlist);
  const targetSummaries = summaries.filter((s) => allowlistSet.has(normalizeName(s.name)));

  const foundNames = new Set(targetSummaries.map((s) => normalizeName(s.name)));
  const namesNotFoundInSource = allowlist.filter((n) => !foundNames.has(n));
  if (namesNotFoundInSource.length) {
    console.warn(`[warn] ${namesNotFoundInSource.length} name(s) in WORKFLOW_NAME_ALLOWLIST were not found in the source portal (check for typos/renames):`);
    namesNotFoundInSource.forEach((n) => console.warn(`  - "${n}"`));
  }
  console.log(`[info] ${targetSummaries.length} of ${allowlist.length} allowlisted workflow(s) matched; only these will be migrated.`);

  const counters = { total: targetSummaries.length, success: 0, skipped: 0, failed: 0, validationFailures: 0, dryRun: 0, held: 0, repaired: 0 };
  // Index existing destination workflows by name, so a workflow that was
  // already created is never created a second time.
  const destWorkflowIdsByName = new Map();
  try {
    for (const w of await fetchAllWorkflowSummaries(destToken)) {
      const key = workflowNameKey(w.name);
      destWorkflowIdsByName.set(key, [...(destWorkflowIdsByName.get(key) || []), String(w.id)]);
    }
  } catch (err) {
    console.error(`[fatal] Could not list destination workflows (needed to avoid creating duplicates): ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[info] Found ${destWorkflowIdsByName.size} distinct workflow name(s) in the destination portal.`);

  const ctx = { sourceToken, destToken, assetMap, state, dryRun: DRY_RUN, propertyCache: new Set(), destWorkflowIdsByName };

  for (const summary of targetSummaries) {
    // Earlier runs' error entries for this workflow are replaced by whatever
    // this run finds, so the error log reflects the current state. They're
    // kept if the workflow is skipped (nothing was re-checked).
    const sourceId = String(summary.id);
    const priorErrors = state.errorLog.filter((e) => String(e.sourceWorkflowId) === sourceId);
    state.errorLog = state.errorLog.filter((e) => String(e.sourceWorkflowId) !== sourceId);

    const result = await migrateOneWorkflow(summary, ctx);
    if (result.status === 'skipped') state.errorLog.push(...priorErrors);
    // Persist after every workflow so progress survives a crash/interrupt.
    saveLogState(state);

    if (result.status === 'success') counters.success += 1;
    else if (result.status === 'success_with_warnings') {
      counters.success += 1;
      counters.validationFailures += 1;
    } else if (result.status === 'skipped') counters.skipped += 1;
    else if (result.status === 'dry_run') counters.dryRun += 1;
    else if (result.status === 'held') counters.held += 1;
    else if (result.status === 'repaired') counters.repaired += 1;
    else if (result.status === 'repaired_with_warnings') {
      counters.repaired += 1;
      counters.validationFailures += 1;
    }
    else counters.failed += 1;
  }

  // --- Second pass: resolve cross-workflow references (e.g. "Go to
  //     workflow" actions) that pointed at a workflow which hadn't been
  //     migrated yet at the time its referrer was created, but now has been. ---
  if (!DRY_RUN) {
    const resolvedCount = await resolveForwardWorkflowReferences(destToken, state);
    if (resolvedCount > 0) {
      counters.validationFailures = Math.max(0, counters.validationFailures - resolvedCount);
    }
  }

  saveLogState(state);

  console.log('\nHubSpot Workflow Migration Completed\n');
  console.log(`Total workflows found: ${counters.total}`);
  console.log(`Successfully migrated: ${counters.success}`);
  console.log(`Already migrated/skipped: ${counters.skipped}`);
  if (REPAIR_EXISTING) console.log(`Repaired in place: ${counters.repaired}`);
  console.log(`Held (unmapped references, not created/updated): ${counters.held}`);
  console.log(`Failed: ${counters.failed}`);
  console.log(`Validation failures: ${counters.validationFailures}`);
  if (DRY_RUN) console.log(`Dry run (no changes made): ${counters.dryRun}`);
  console.log('\nSuccess log:');
  console.log(SUCCESS_LOG_PATH);
  console.log('\nError log:');
  console.log(ERROR_LOG_PATH);
  console.log('\nWorkflow mapping:');
  console.log(ID_MAPPING_PATH);

  if (counters.validationFailures > 0 || counters.failed > 0) {
    console.log(
      '\nNote: Some workflows were flagged for manual review (validation warnings) or failed outright. ' +
      `See ${path.basename(ERROR_LOG_PATH)} for details on unmapped asset references, field mismatches, and ` +
      'any HubSpot workflow properties this API does not expose or permit migrating.'
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[fatal] Unexpected error:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  remapWorkflowReferences,
  withResolvedWorkflowIds,
  sanitizeForCreate,
  sanitizeForUpdate,
  validateMigratedWorkflow,
  resolveForwardWorkflowReferences,
  deepEqual,
};
