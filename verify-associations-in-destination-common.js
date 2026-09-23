/**
 * Shared library for the verify-*-associations-in-destination.js scripts.
 * Reads a check-all-*-records-associations.js report (an array of primary
 * records, each with an `associations` array) and, for every entry whose
 * `associations` array is not empty, LIVE-searches the DESTINATION portal
 * for each associated record - rather than trusting the
 * destination_record_ids.json snapshot check-all-*.js uses - so a record
 * migrated after that snapshot was taken still gets found.
 *
 * For each association:
 *   - associatedSourceObjectType "companies" -> search destination companies
 *     where tm_company_record_id = associatedSourceRecordId
 *   - associatedSourceObjectType "contacts"  -> search destination contacts
 *     where tm_contact_record_id = associatedSourceRecordId
 *   - associatedSourceObjectType "deals"     -> search destination deals
 *     where tm_deal_record_id = associatedSourceRecordId
 *
 * If a matching destination record is found, its HubSpot record ID is
 * reported as destinationRecordId.
 *
 * This is read-only - it never creates, updates, or deletes anything.
 *
 * NOTES ON ACCURACY
 * ------------------
 * - HubSpot's CRM Search API is rate-limited to 5 requests/second per
 *   account (stricter than, and separate from, the general API limit), and
 *   these scripts are nothing but search calls - REQUEST_DELAY_MS defaults
 *   to 250ms to leave headroom under that ceiling.
 * - HubSpot's own docs note newly created/updated records can take "a few
 *   moments" to appear in search results. If a destination record was
 *   migrated only seconds before this script ran, it may still be reported
 *   as not found - re-run if in doubt.
 * - Each association's `searchError` field is set (and it's excluded from
 *   the found/not-found counts) when the search itself failed after
 *   retries - that's different from a confirmed "no such destination
 *   record": the true answer is unknown, not "not migrated yet".
 * - Re-running is safe and resumes: any primary record already present in
 *   the output file from a previous run is skipped rather than re-verified.
 * - If more than one destination record shares the same migration-tracking
 *   property value, that's logged as a warning rather than silently picking
 *   one - it usually signals a data-integrity issue worth investigating.
 *
 * REQUIRED ENV VAR: DESTINATION_HUBSPOT_TOKEN
 * OPTIONAL ENV VARS:
 *   REQUEST_DELAY_MS   Delay between outbound HubSpot API calls, in ms. Defaults to 250.
 *   MAX_RETRIES        Max retry attempts for 429/5xx responses. Defaults to 5.
 *   HUBSPOT_API_BASE   Override the API base URL (used for local testing against a mock server).
 *   OUTPUT_DIR         Directory to write the report JSON file into. Defaults to cwd.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HUBSPOT_API_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
// HubSpot's CRM Search API is rate-limited to 5 requests/second per account -
// stricter than, and separate from, the general API limit - and these
// scripts are nothing but search calls. 250ms (4/sec) leaves a safety margin
// instead of running right at the documented ceiling.
const REQUEST_DELAY_MS = Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 250;
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES, 10) || 5;
const OUTPUT_DIR = process.env.OUTPUT_DIR || process.cwd();

const MIGRATION_PROPERTY_BY_TYPE = {
  contacts: 'tm_contact_record_id',
  companies: 'tm_company_record_id',
  deals: 'tm_deal_record_id',
};

// Naive slice(0, -1) singularization breaks on "companies" -> "companie", so
// spell out the correct singular form for each supported object type instead.
const SINGULAR_BY_TYPE = {
  contacts: 'contact',
  companies: 'company',
  deals: 'deal',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Live search: does a destination record of objectType exist with migration
 * property = sourceId? Requests 2 results (not 1) purely to detect - and
 * warn about - more than one destination record sharing the same source ID,
 * which would otherwise be silently and arbitrarily resolved to "whichever
 * one the API returned first".
 */
async function findDestinationRecordBySourceId(destClient, objectType, sourceId) {
  const migrationProperty = MIGRATION_PROPERTY_BY_TYPE[objectType];
  const body = {
    filterGroups: [{ filters: [{ propertyName: migrationProperty, operator: 'EQ', value: String(sourceId) }] }],
    properties: [migrationProperty],
    limit: 2,
  };
  const response = await destClient.request('POST', `/crm/v3/objects/${objectType}/search`, body);
  const results = (response && response.results) || [];
  if (results.length > 1) {
    console.warn(`[warn] Multiple destination ${objectType} records have ${migrationProperty} = ${sourceId} (using ${results[0].id}, ignoring ${results.slice(1).map((r) => r.id).join(', ')}).`);
  }
  return results.length > 0 ? results[0].id : null;
}

/**
 * Runs the full verification for one primary object type: reads
 * `<inputFileName>` (a check-all-*-records-associations.js report), and
 * writes `<OUTPUT_DIR>/<outputFileName>`.
 */
async function runVerification(primaryObjectType, inputFileName, outputFileName) {

  const destToken =  process.env.DESTINATION_HUBSPOT_TOKEN;
  if (!destToken) {
    console.error('[fatal] DESTINATION_HUBSPOT_TOKEN environment variable is required.');
    process.exitCode = 1;
    return;
  }

  const inputPath = process.env.INPUT_FILE || path.join(process.cwd(), inputFileName);
  if (!fs.existsSync(inputPath)) {
    console.error(`[fatal] Input file not found: ${inputPath}. Run check-all-${SINGULAR_BY_TYPE[primaryObjectType]}-records-associations.js first.`);
    process.exitCode = 1;
    return;
  }
  const primaryReports = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!Array.isArray(primaryReports)) {
    console.error(`[fatal] ${inputPath} did not contain an array of records.`);
    process.exitCode = 1;
    return;
  }

  const outputPath = path.join(OUTPUT_DIR, outputFileName);
  const destClient = createClient(destToken, 'destination');

  // Resume support: a large record list can take a long time at the search
  // API's 5-req/sec ceiling, so an interrupted run should not have to
  // re-verify everything from scratch. Anything already in a prior output
  // file (keyed by sourceRecordId) is skipped.
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const alreadyProcessed = new Map();
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      if (Array.isArray(existing)) {
        for (const entry of existing) alreadyProcessed.set(entry.sourceRecordId, entry);
        console.log(`[info] Resuming: ${alreadyProcessed.size} record(s) already verified in a prior run of ${outputPath}.`);
      }
    } catch {
      console.warn(`[warn] Could not parse existing ${outputPath}; starting fresh.`);
    }
  }

  const counters = { recordsWithAssociations: 0, associationsChecked: 0, found: 0, notFound: 0, searchErrors: 0 };
  const output = [...alreadyProcessed.values()];
  const saveProgress = () => fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');

  for (const primaryEntry of primaryReports) {
    if (alreadyProcessed.has(primaryEntry.sourceRecordId)) continue;

    const associations = Array.isArray(primaryEntry.associations) ? primaryEntry.associations : [];
    if (associations.length === 0) continue; // nothing to verify for this record

    counters.recordsWithAssociations += 1;
    const verifiedAssociations = [];

    for (const association of associations) {
      const targetObjectType = association.associatedSourceObjectType;
      const migrationProperty = MIGRATION_PROPERTY_BY_TYPE[targetObjectType];
      if (!migrationProperty) {
        console.warn(`[warn] Unknown associatedSourceObjectType "${targetObjectType}" for ${SINGULAR_BY_TYPE[primaryObjectType]} ${primaryEntry.sourceRecordId}; skipping.`);
        continue;
      }

      counters.associationsChecked += 1;
      let destinationRecordId = null;
      let searchError = null;
      try {
        destinationRecordId = await findDestinationRecordBySourceId(destClient, targetObjectType, association.associatedSourceRecordId);
      } catch (err) {
        // Distinct from a genuine "not found": the search itself failed
        // (e.g. retries exhausted on repeated 429/5xx), so whether a
        // matching destination record exists is UNKNOWN, not confirmed
        // absent. Conflating the two would misreport a real data gap where
        // there might not be one.
        searchError = err.message;
        counters.searchErrors += 1;
        console.error(`[error] Failed to search destination ${targetObjectType} for source ID ${association.associatedSourceRecordId}: ${err.message}`);
      }

      if (destinationRecordId) {
        counters.found += 1;
        console.log(
          `[found] ${SINGULAR_BY_TYPE[primaryObjectType]} ${primaryEntry.sourceRecordId} -> ${targetObjectType} ${association.associatedSourceRecordId} ` +
          `(${migrationProperty}) -> destination ${targetObjectType} record ID = ${destinationRecordId}`
        );
      } else if (!searchError) {
        counters.notFound += 1;
        console.log(
          `[not found] ${SINGULAR_BY_TYPE[primaryObjectType]} ${primaryEntry.sourceRecordId} -> ${targetObjectType} ${association.associatedSourceRecordId} ` +
          `(no destination ${targetObjectType} record with ${migrationProperty} = ${association.associatedSourceRecordId})`
        );
      }

      verifiedAssociations.push({
        associatedSourceObjectType: targetObjectType,
        associatedSourceRecordId: association.associatedSourceRecordId,
        associationTypes: association.associationTypes,
        foundInDestination: Boolean(destinationRecordId),
        destinationRecordId,
        searchError,
      });
    }

    output.push({
      sourceRecordId: primaryEntry.sourceRecordId,
      destinationRecordId: primaryEntry.destinationRecordId,
      associations: verifiedAssociations,
    });
    saveProgress();
  }

  saveProgress();

  console.log(`\n${capitalize(primaryObjectType)} association destination verification completed\n`);
  console.log(`${capitalize(primaryObjectType)} with at least one association: ${counters.recordsWithAssociations}`);
  console.log(`Associations checked: ${counters.associationsChecked}`);
  console.log(`Found in destination: ${counters.found}`);
  console.log(`NOT found in destination: ${counters.notFound}`);
  console.log(`Search errors (unknown - not the same as "not found"): ${counters.searchErrors}`);
  console.log(`\nDetailed report written to:\n${outputPath}`);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = {
  MIGRATION_PROPERTY_BY_TYPE,
  createClient,
  findDestinationRecordBySourceId,
  runVerification,
  HubSpotApiError,
};
