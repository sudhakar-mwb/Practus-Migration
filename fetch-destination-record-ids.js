#!/usr/bin/env node

/**
 * Fetches every Contact, Company, and Deal record from the DESTINATION
 * HubSpot portal and reads back the migration-tracking property each one
 * carries:
 *   Contact  -> tm_contact_record_id
 *   Company  -> tm_company_record_id
 *   Deal     -> tm_deal_record_id
 *
 * That property holds the record's original SOURCE portal ID, so this
 * script produces a source-ID -> destination-ID map for each object type -
 * useful on its own (e.g. to audit how much of the record migration has
 * actually completed) and as the same data the association migration
 * scripts (migrate-contact-associations.js etc.) build internally.
 *
 * This script only READS records - it never creates, updates, or deletes
 * anything in either portal.
 *
 * REQUIRED ENV VAR: DESTINATION_HUBSPOT_TOKEN
 * OPTIONAL ENV VARS:
 *   OUTPUT_DIR          Directory to write the output JSON file into. Defaults to cwd.
 *   REQUEST_DELAY_MS     Delay between outbound HubSpot API calls, in ms. Defaults to 200.
 *   MAX_RETRIES          Max retry attempts for 429/5xx responses. Defaults to 5.
 *   HUBSPOT_API_BASE     Override the API base URL (used for local testing against a mock server).
 *
 * USAGE:
 *   node --env-file=.env fetch-destination-record-ids.js
 *
 * OUTPUT FILE: destination_record_ids.json
 *   {
 *     "contacts": {
 *       "totalRecords": 950,
 *       "withSourceId": 499,
 *       "withoutSourceId": 451,
 *       "mapping": { "<sourceContactId>": "<destinationContactId>", ... },
 *       "destinationIdsMissingSourceId": ["<destinationContactId>", ...]
 *     },
 *     "companies": { ... },
 *     "deals": { ... }
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HUBSPOT_API_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
const REQUEST_DELAY_MS = Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 200;
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES, 10) || 5;
const OUTPUT_DIR = process.env.OUTPUT_DIR || process.cwd();
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'destination_record_ids.json');

const MIGRATION_PROPERTY_BY_TYPE = {
  contacts: 'tm_contact_record_id',
  companies: 'tm_company_record_id',
  deals: 'tm_deal_record_id',
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

/** Minimal HubSpot GET client with 429/5xx retry + backoff (no writes needed for this script). */
async function hubspotGet(token, urlPath) {
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
      response = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    } catch (networkErr) {
      if (attempt > MAX_RETRIES) throw new HubSpotApiError(`Network error calling GET ${urlPath}: ${networkErr.message}`, {});
      const backoffMs = Math.min(2000 * 2 ** (attempt - 1), 30000);
      console.warn(`[warn] Network error on GET ${urlPath} (attempt ${attempt}), retrying in ${backoffMs}ms: ${networkErr.message}`);
      await sleep(backoffMs);
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt > MAX_RETRIES) {
        const body = await safeReadBody(response);
        throw new HubSpotApiError(`GET ${urlPath} failed after ${MAX_RETRIES} retries with status ${response.status}`, { status: response.status, body });
      }
      const retryAfterHeader = response.headers.get('retry-after');
      const backoffMs = retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))
        ? Number(retryAfterHeader) * 1000
        : Math.min(1000 * 2 ** (attempt - 1), 30000);
      console.warn(`[warn] ${response.status} from GET ${urlPath} (attempt ${attempt}/${MAX_RETRIES}), waiting ${backoffMs}ms`);
      await sleep(backoffMs);
      continue;
    }

    if (!response.ok) {
      const body = await safeReadBody(response);
      throw new HubSpotApiError(`GET ${urlPath} responded with ${response.status}`, { status: response.status, body });
    }

    return safeReadBody(response);
  }
}

/**
 * Pages through every record of objectType in the destination portal,
 * requesting the migration-tracking property, and splits them into
 * "mapping" (records that have a source ID recorded) and
 * "destinationIdsMissingSourceId" (records that don't).
 */
async function fetchDestinationMapping(token, objectType) {
  const migrationProperty = MIGRATION_PROPERTY_BY_TYPE[objectType];
  const mapping = {};
  const destinationIdsMissingSourceId = [];
  let totalRecords = 0;
  let after;

  do {
    const query = new URLSearchParams({ limit: '100', properties: migrationProperty });
    if (after) query.set('after', after);
    const page = await hubspotGet(token, `/crm/v3/objects/${objectType}?${query.toString()}`);
    const results = page && Array.isArray(page.results) ? page.results : [];

    for (const record of results) {
      totalRecords += 1;
      const sourceId = record.properties && record.properties[migrationProperty];
      if (sourceId) {
        mapping[String(sourceId)] = String(record.id);
      } else {
        destinationIdsMissingSourceId.push(String(record.id));
      }
    }

    after = page && page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : undefined;
  } while (after);

  return {
    totalRecords,
    withSourceId: Object.keys(mapping).length,
    withoutSourceId: destinationIdsMissingSourceId.length,
    mapping,
    destinationIdsMissingSourceId,
  };
}

async function main() {
  const destToken = process.env.DESTINATION_HUBSPOT_TOKEN;
  if (!destToken) {
    console.error('[fatal] DESTINATION_HUBSPOT_TOKEN environment variable is required.');
    process.exitCode = 1;
    return;
  }

  const output = {};

  for (const objectType of Object.keys(MIGRATION_PROPERTY_BY_TYPE)) {
    console.log(`[info] Fetching destination ${objectType} (reading ${MIGRATION_PROPERTY_BY_TYPE[objectType]})...`);
    try {
      output[objectType] = await fetchDestinationMapping(destToken, objectType);
      console.log(
        `[info] ${objectType}: ${output[objectType].totalRecords} total, ` +
        `${output[objectType].withSourceId} with ${MIGRATION_PROPERTY_BY_TYPE[objectType]} set, ` +
        `${output[objectType].withoutSourceId} without it.`
      );
    } catch (err) {
      console.error(`[error] Failed to fetch destination ${objectType}: ${err.message}`);
      if (err instanceof HubSpotApiError) {
        console.error(`         status=${err.status} body=${JSON.stringify(err.body)}`);
      }
      output[objectType] = { error: err.message, totalRecords: 0, withSourceId: 0, withoutSourceId: 0, mapping: {}, destinationIdsMissingSourceId: [] };
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');

  console.log('\nDestination record ID fetch completed\n');
  for (const objectType of Object.keys(MIGRATION_PROPERTY_BY_TYPE)) {
    const o = output[objectType];
    console.log(`${objectType}: ${o.totalRecords} total | ${o.withSourceId} mapped | ${o.withoutSourceId} missing source ID`);
  }
  console.log(`\nOutput file:\n${OUTPUT_PATH}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[fatal] Unexpected error:', err);
    process.exitCode = 1;
  });
}

module.exports = { fetchDestinationMapping };
