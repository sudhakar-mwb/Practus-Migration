#!/usr/bin/env node

/**
 * Record-owner migration between two HubSpot portals, split into steps that
 * all live in this one file.
 *
 * STEP 1 - build owner/user mapping (READ ONLY)
 *   Fetches every owner (active + archived) from the SOURCE and DESTINATION
 *   portals via the CRM Owners API and matches them by email address
 *   (case-insensitive). For each match it records:
 *     - source ownerId -> destination ownerId   (what hubspot_owner_id holds)
 *     - source userId  -> destination userId    (the HubSpot user account ID)
 *   Nothing is created, updated, or deleted in either portal.
 *
 * STEP 2 - update CRM record owners in destination
 *   (to be added)
 *
 * REQUIRED ENV VARS: SOURCE_HUBSPOT_TOKEN, DESTINATION_HUBSPOT_TOKEN
 *   Both private apps need the `crm.objects.owners.read` scope.
 * OPTIONAL ENV VARS:
 *   OUTPUT_DIR          Directory to write output JSON files into. Defaults to cwd.
 *   REQUEST_DELAY_MS    Delay between outbound HubSpot API calls, in ms. Defaults to 200.
 *   MAX_RETRIES         Max retry attempts for 429/5xx responses. Defaults to 5.
 *   HUBSPOT_API_BASE    Override the API base URL (used for local testing against a mock server).
 *
 * USAGE:
 *   node --env-file=.env migrate-record-owners.js step1
 *
 * OUTPUT FILE (step1): owner_mapping.json
 *   {
 *     "generatedAt": "...",
 *     "summary": { "sourceOwners": 40, "destinationOwners": 35, "matched": 33, ... },
 *     "ownerIdMapping": { "<sourceOwnerId>": "<destinationOwnerId>", ... },
 *     "userIdMapping":  { "<sourceUserId>":  "<destinationUserId>",  ... },
 *     "matched": [ { email, source: {...}, destination: {...} }, ... ],
 *     "unmatchedSource": [ {...}, ... ],
 *     "unmatchedDestination": [ {...}, ... ],
 *     "sourceOwnersWithoutEmail": [ {...}, ... ]
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HUBSPOT_API_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
const REQUEST_DELAY_MS = Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 200;
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES, 10) || 5;
const OUTPUT_DIR = process.env.OUTPUT_DIR || process.cwd();
const OWNER_MAPPING_PATH = path.join(OUTPUT_DIR, 'owner_mapping.json');

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

async function hubspotRequest(token, method, urlPath, { query, body } = {}) {
  const url = new URL(urlPath, HUBSPOT_API_BASE);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }

  for (let attempt = 0; ; attempt++) {
    await sleep(REQUEST_DELAY_MS);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.ok) return safeReadBody(response);

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after'), 10);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt;
      console.warn(`  ${method} ${url.pathname} -> ${response.status}, retrying in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    const errorBody = await safeReadBody(response);
    throw new HubSpotApiError(`${method} ${url.pathname} failed with ${response.status}`, {
      status: response.status,
      body: errorBody,
    });
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// STEP 1 - owner/user mapping
// ---------------------------------------------------------------------------

async function fetchOwners(token, archived) {
  const owners = [];
  let after;
  do {
    const page = await hubspotRequest(token, 'GET', '/crm/v3/owners', {
      query: { limit: 500, after, archived },
    });
    owners.push(...(page.results || []));
    after = page.paging?.next?.after;
  } while (after);
  return owners;
}

async function fetchAllOwners(token) {
  const [active, archived] = [await fetchOwners(token, false), await fetchOwners(token, true)];
  return [...active, ...archived].map((owner) => ({
    ownerId: String(owner.id),
    userId: owner.userId != null ? String(owner.userId) : null,
    email: owner.email || null,
    firstName: owner.firstName || '',
    lastName: owner.lastName || '',
    archived: Boolean(owner.archived),
  }));
}

function normalizeEmail(email) {
  return email ? email.trim().toLowerCase() : null;
}

// If an email appears more than once (e.g. an archived and an active owner),
// prefer the active one.
function indexByEmail(owners) {
  const byEmail = new Map();
  for (const owner of owners) {
    const key = normalizeEmail(owner.email);
    if (!key) continue;
    const existing = byEmail.get(key);
    if (!existing || (existing.archived && !owner.archived)) byEmail.set(key, owner);
  }
  return byEmail;
}

async function step1() {
  const sourceToken = requireEnv('SOURCE_HUBSPOT_TOKEN');
  const destinationToken = requireEnv('DESTINATION_HUBSPOT_TOKEN');

  console.log('Fetching owners from SOURCE portal...');
  const sourceOwners = await fetchAllOwners(sourceToken);
  console.log(`  ${sourceOwners.length} owners`);

  console.log('Fetching owners from DESTINATION portal...');
  const destinationOwners = await fetchAllOwners(destinationToken);
  console.log(`  ${destinationOwners.length} owners`);

  const destinationByEmail = indexByEmail(destinationOwners);
  const matchedDestinationOwnerIds = new Set();

  const ownerIdMapping = {};
  const userIdMapping = {};
  const matched = [];
  const unmatchedSource = [];
  const sourceOwnersWithoutEmail = [];

  for (const source of sourceOwners) {
    const email = normalizeEmail(source.email);
    if (!email) {
      sourceOwnersWithoutEmail.push(source);
      continue;
    }

    const destination = destinationByEmail.get(email);
    if (!destination) {
      unmatchedSource.push(source);
      continue;
    }

    ownerIdMapping[source.ownerId] = destination.ownerId;
    if (source.userId && destination.userId) userIdMapping[source.userId] = destination.userId;
    matchedDestinationOwnerIds.add(destination.ownerId);
    matched.push({ email, source, destination });
  }

  const unmatchedDestination = destinationOwners.filter(
    (owner) => !matchedDestinationOwnerIds.has(owner.ownerId),
  );

  const summary = {
    sourceOwners: sourceOwners.length,
    destinationOwners: destinationOwners.length,
    matched: matched.length,
    unmatchedSource: unmatchedSource.length,
    unmatchedDestination: unmatchedDestination.length,
    sourceOwnersWithoutEmail: sourceOwnersWithoutEmail.length,
  };

  writeJson(OWNER_MAPPING_PATH, {
    generatedAt: new Date().toISOString(),
    summary,
    ownerIdMapping,
    userIdMapping,
    matched,
    unmatchedSource,
    unmatchedDestination,
    sourceOwnersWithoutEmail,
  });

  console.log('\nSummary:');
  console.table(summary);
  if (unmatchedSource.length) {
    console.log('Source owners with no destination match:');
    for (const owner of unmatchedSource) {
      console.log(`  ${owner.ownerId}  ${owner.email}${owner.archived ? '  (archived)' : ''}`);
    }
  }
  console.log(`\nWrote ${OWNER_MAPPING_PATH}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const STEPS = { step1 };

async function main() {
  const stepName = process.argv[2];
  const step = STEPS[stepName];
  if (!step) {
    console.error(`Usage: node --env-file=.env migrate-record-owners.js <${Object.keys(STEPS).join('|')}>`);
    process.exit(1);
  }
  await step();
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  if (error.body) console.error(JSON.stringify(error.body, null, 2));
  process.exit(1);
});
