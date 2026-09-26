#!/usr/bin/env node

/**
 * HubSpot Campaign Social Post Migration
 * =============================================================================
 *
 * Migrates Social Posts (broadcasts) that are associated with a fixed list of
 * campaigns, from a SOURCE HubSpot portal to a DESTINATION HubSpot portal.
 *
 * Every destination Social Post is created as a DRAFT. This script never
 * publishes, schedules, retries publishing, or sends anything to a social
 * network — see "DRAFT SAFETY" below.
 *
 * -----------------------------------------------------------------------------
 * API REALITY — VERIFIED LIVE, NOT ASSUMED (source portal 46378923, 2026-09-25)
 * -----------------------------------------------------------------------------
 * There is NO modern Social Post API. Every candidate was probed live:
 *     GET /marketing/v3/social/posts        -> 404
 *     GET /marketing/v3/broadcasts          -> 404
 *     GET /social/v1/broadcasts             -> 404
 *     GET /crm/v3/objects/social_broadcast  -> 400 "Object type SOCIAL_BROADCAST
 *                                              is not supported by this endpoint"
 * The ONLY social API is the legacy, DEPRECATED Social Media v1 API under
 * /broadcast/v1/. HubSpot's deprecated-API page classifies it as deprecated but
 * NOT sunsetted ("functional and stable, but won't be updated beyond their
 * current version") with no replacement planned. Its request/response schema is
 * no longer published anywhere — the legacy doc pages now 301 to deprecation
 * stubs, and HubSpot's docs index (llms.txt) contains no social/broadcast
 * entries at all. Every field name used below was therefore derived from REAL
 * API RESPONSES in the source portal, not from documentation or memory.
 *
 * Endpoints confirmed working (require the `social-access` scope):
 *   GET /broadcast/v1/broadcasts?limit=N[&status=...]   list broadcasts
 *   GET /broadcast/v1/broadcasts/{broadcastGuid}        single broadcast
 *   GET /broadcast/v1/channels/setting/publish/current  connected social accounts
 *       (NOTE: the documented GET /broadcast/v1/channels returns 404; the
 *        /setting/publish/current path is the one that actually works.)
 *
 * Confirmed: a campaign's SOCIAL_BROADCAST asset id IS the broadcastGuid —
 * GET /broadcast/v1/broadcasts/372726674 resolves an asset id straight to a
 * broadcast. No id translation is needed.
 *
 * Confirmed status values: SUCCESS, DRAFT, CANCELED, WAITING. Passing
 * status=SCHEDULED or status=PUBLISHED returns 400 "Unsupported broadcast
 * status", so those names do not exist in this API.
 *
 * -----------------------------------------------------------------------------
 * DRAFT SAFETY — how a draft is identified, and why this is the hard gate
 * -----------------------------------------------------------------------------
 * A DRAFT broadcast in the source portal looks like this (real record 368541971):
 *     status: "DRAFT", triggerAt: 0, wasDraft: true,
 *     isPublished: false, isPending: false, finishedAt: null
 * whereas a published one carries a real epoch-ms triggerAt, status "SUCCESS",
 * isPublished true and a finishedAt. `triggerAt: 0` is therefore the draft
 * marker, and this script always sends triggerAt: 0.
 *
 * Because the create contract is undocumented, sending triggerAt:0 is NOT
 * trusted on its own. After every create/update the script RE-READS the record
 * and asserts status === 'DRAFT'. If it is anything else the post is treated as
 * a failure and the script attempts to cancel it immediately
 * (DELETE /broadcast/v1/broadcasts/{guid}). It NEVER "fixes" a non-draft by
 * publishing, and it never retries a create that produced a non-draft.
 *
 * If the very first create in a run does not come back as DRAFT, the script
 * aborts the entire run (see ABORT_ON_FIRST_NON_DRAFT). One stray published
 * post is a real-world incident; 150 of them is a catastrophe.
 *
 * -----------------------------------------------------------------------------
 * WHAT CAN AND CANNOT BE MIGRATED
 * -----------------------------------------------------------------------------
 * A broadcast is bound to a channelGuid/channelKey — a specific connected
 * social account (a Facebook page, LinkedIn company page, Instagram account).
 * Those ids are PORTAL-SPECIFIC. A post cannot be created in the destination
 * without a destination channel, and there is no API to connect one — social
 * accounts are connected through the HubSpot UI only. Source channels are
 * therefore mapped to destination channels through SOCIAL_CHANNEL_MAP_FILE,
 * and any unmapped source channel is reported as SOCIAL_ACCOUNT_NOT_MAPPED
 * rather than guessed at.
 *
 * VERIFIED in the source portal: the 154 campaign-linked broadcasts reference
 * FOUR distinct channels, but only TWO are still connected there —
 * FacebookPage:978993358639057 (32 posts) and Instagram:17841411057732256
 * (46 posts) are not connected even in the source. Those 78 posts reference
 * accounts that no longer exist anywhere and will need a mapping decision.
 *
 * Engagement fields (retweets, likes, replies, clicks, interactionsCount) and
 * platform state (messageUrl, foreignId, finishedAt, isPublished, status) are
 * READ_ONLY / NOT_MIGRATABLE by design — this script replicates configuration
 * and content, never fabricated historical activity.
 *
 * -----------------------------------------------------------------------------
 * IDEMPOTENCY
 * -----------------------------------------------------------------------------
 * The broadcast object exposes a writable `clientTag` field, and VERIFIED LIVE
 * that none of the 154 source broadcasts uses it (0 in use), so it is free to
 * carry migration identity:
 *     clientTag = "migrated:<sourcePortalId>:<sourceBroadcastGuid>"
 * Resolution order before anything is created:
 *   1. mapping file -> re-read that destination broadcast; still there -> UPDATE
 *   2. mapping stale (destination gone) -> RECREATE and rewrite the mapping
 *   3. no mapping -> scan destination broadcasts for a matching clientTag
 *   4. still nothing -> scan for the exact prefixed name on the same channel
 *   5. only then CREATE
 *
 * -----------------------------------------------------------------------------
 * REQUIRED SCOPES
 *   source:      social-access, marketing.campaigns.read (+ files read for media)
 *   destination: social-access, marketing.campaigns.read, marketing.campaigns.write,
 *                files (to import media)
 *
 * REQUIRED ENV
 *   SOURCE_HUBSPOT_ACCESS_TOKEN   (falls back to SOURCE_HUBSPOT_TOKEN)
 *   DEST_HUBSPOT_ACCESS_TOKEN     (falls back to DESTINATION_HUBSPOT_TOKEN)
 * OPTIONAL ENV
 *   LOG_DIR, DRY_RUN, MAX_RETRIES, SOCIAL_CHANNEL_MAP_FILE,
 *   CREATE_MISSING_CAMPAIGNS, ABORT_ON_FIRST_NON_DRAFT, REQUEST_DELAY_MS
 *
 * USAGE
 *   node --env-file=.env migrate-campaign-social-posts.js            # dry run
 *   DRY_RUN=false node --env-file=.env migrate-campaign-social-posts.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch { /* optional */ }

// ===========================================================================
// Configuration
// ===========================================================================

const SOURCE_HUBSPOT_ACCESS_TOKEN =
  process.env.SOURCE_HUBSPOT_ACCESS_TOKEN || process.env.SOURCE_HUBSPOT_TOKEN;
const DEST_HUBSPOT_ACCESS_TOKEN =
  process.env.DEST_HUBSPOT_ACCESS_TOKEN || process.env.DESTINATION_HUBSPOT_TOKEN;

const DESTINATION_PREFIX = 'Touchmath | ';
const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES, 10) || 5;
const LOG_DIR = process.env.LOG_DIR || './logs';
const REQUEST_DELAY_MS = Number.parseInt(process.env.REQUEST_DELAY_MS, 10) || 200;
const API_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';

/** Creating campaigns is out of scope for this script by design. */
const CREATE_MISSING_CAMPAIGNS = false;

/** Stop everything if the first created post is not a DRAFT. */
const ABORT_ON_FIRST_NON_DRAFT =
  String(process.env.ABORT_ON_FIRST_NON_DRAFT ?? 'true').toLowerCase() !== 'false';

const SOCIAL_CHANNEL_MAP_FILE =
  process.env.SOCIAL_CHANNEL_MAP_FILE || path.join(process.cwd(), 'social-channel-map.json');
const MAP_FILE = path.join(LOG_DIR, 'social-post-migration-map.json');

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

const BROADCAST_PATH = '/broadcast/v1/broadcasts';
const CHANNELS_PATH = '/broadcast/v1/channels/setting/publish/current';

/**
 * Content subfields observed on real broadcasts. Only these are copied; the
 * rest of the payload is platform state.
 * `charCount`, `cloneFailed`, `createdBy`, `foreignPostId`, `thumbUrl`,
 * `uncompressedLinks`, `generationMode` are derived/platform-owned.
 */
const CONTENT_FIELDS_MIGRATED = [
  'body', 'photoUrl', 'imageUrl', 'link', 'originalLink', 'originalBody',
  'title', 'description', 'firstComment', 'fileId',
];
const CONTENT_FIELDS_READ_ONLY = [
  'charCount', 'cloneFailed', 'createdBy', 'foreignPostId', 'thumbUrl',
  'uncompressedLinks', 'generationMode',
];
/** Top-level fields that are platform state and are never written. */
const TOP_LEVEL_READ_ONLY = [
  'broadcastGuid', 'portalId', 'status', 'finishedAt', 'messageUrl', 'foreignId',
  'isPublished', 'isPending', 'isFailed', 'isRetry', 'createdAt', 'userUpdatedAt',
  'createdBy', 'updatedBy', 'retweets', 'likes', 'replies', 'clicks',
  'interactionsCount', 'taskQueueId', 'linkTaskQueueId', 'intermediatePublishId',
  'groupGuid', 'suggestionGuid', 'linkGuid',
];

// ===========================================================================
// Logging
// ===========================================================================

fs.mkdirSync(LOG_DIR, { recursive: true });

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

const RUN_STAMP = stamp();
const LOG_PATH = path.join(LOG_DIR, `social-post-migration-${RUN_STAMP}.log`);
const SUMMARY_PATH = path.join(LOG_DIR, `social-post-migration-summary-${RUN_STAMP}.json`);
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

/** Never let a token reach a log file. */
function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return String(text).replace(/(pat-[a-z0-9-]+|Bearer\s+[^\s"']+)/gi, '<redacted>');
}

function log(level, message, fields) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}` +
    (fields ? `\n${Object.entries(fields).map(([k, v]) => `    ${k}: ${redact(v)}`).join('\n')}` : '');
  logStream.write(`${line}\n`);
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

// ===========================================================================
// HTTP with retry / backoff / pagination
// ===========================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HubSpotApiError extends Error {
  constructor(message, { status, body, method, url } = {}) {
    super(message);
    this.name = 'HubSpotApiError';
    this.status = status ?? null;
    this.body = body ?? null;
    this.method = method ?? null;
    this.url = url ?? null;
  }
}

async function hubspotFetch(token, method, urlPath, { body, allow404 = false } = {}) {
  const url = urlPath.startsWith('http') ? urlPath : API_BASE + urlPath;

  for (let attempt = 0; ; attempt += 1) {
    if (REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const wait = 2000 * 2 ** attempt;
        log('WARN', `Network error on ${method} ${urlPath}; retrying in ${wait}ms`, { error: err.message });
        await sleep(wait);
        continue;
      }
      throw new HubSpotApiError(`Network failure: ${err.message}`, { method, url: urlPath });
    }

    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

    if (res.ok) return parsed;
    if (res.status === 404 && allow404) return null;

    // 429 and 5xx are transient; 4xx validation errors are not retried.
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const retryAfter = Number.parseInt(res.headers.get('retry-after'), 10);
      const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * 2 ** attempt;
      log('WARN', `${method} ${urlPath} -> ${res.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new HubSpotApiError(`${method} ${urlPath} failed with ${res.status}`, {
      status: res.status, body: parsed, method, url: urlPath,
    });
  }
}

/** Pages any {results, paging.next.after} endpoint. */
async function hubspotGetAllPages(token, urlPath, params = {}) {
  const out = [];
  let after;
  do {
    const qs = new URLSearchParams({ ...params, limit: '100' });
    if (after) qs.set('after', after);
    const page = await hubspotFetch(token, 'GET', `${urlPath}?${qs}`);
    out.push(...(page?.results || []));
    after = page?.paging?.next?.after;
  } while (after);
  return out;
}

// ===========================================================================
// Mapping files
// ===========================================================================

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const migrationMap = readJson(MAP_FILE, {});
const channelMap = readJson(SOCIAL_CHANNEL_MAP_FILE, {});

function saveMap() { writeJsonAtomic(MAP_FILE, migrationMap); }

// ===========================================================================
// Naming
// ===========================================================================

/** Prefix once and only once. */
function destinationName(sourceName) {
  const name = String(sourceName ?? '');
  return name.startsWith(DESTINATION_PREFIX) || name.startsWith(DESTINATION_PREFIX.trim())
    ? name
    : DESTINATION_PREFIX + name;
}

function clientTagFor(sourcePortalId, sourceGuid) {
  return `migrated:${sourcePortalId}:${sourceGuid}`;
}

// ===========================================================================
// Campaigns
// ===========================================================================

async function findCampaignsByExactName(token, name) {
  const all = await hubspotGetAllPages(token, '/marketing/v3/campaigns', { properties: 'hs_name' });
  return all.filter((c) => c.properties?.hs_name === name);
}

/**
 * Campaign assets come back embedded but capped at 50 per type, so page the
 * dedicated assets endpoint whenever a `paging` cursor is present.
 */
async function getCampaignSocialAssets(token, campaignId) {
  const campaign = await hubspotFetch(token, 'GET', `/marketing/v3/campaigns/${campaignId}`);
  const embedded = campaign?.assets?.SOCIAL_BROADCAST;
  if (!embedded) return [];
  if (!embedded.paging) return embedded.results || [];
  return hubspotGetAllPages(token, `/marketing/v3/campaigns/${campaignId}/assets/SOCIAL_BROADCAST`);
}

// ===========================================================================
// Broadcasts
// ===========================================================================

async function getBroadcast(token, guid) {
  return hubspotFetch(token, 'GET', `${BROADCAST_PATH}/${guid}`, { allow404: true });
}

async function listBroadcasts(token, { limit = 100, status } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (status) qs.set('status', status);
  const res = await hubspotFetch(token, 'GET', `${BROADCAST_PATH}?${qs}`);
  return Array.isArray(res) ? res : [];
}

async function getChannels(token) {
  const res = await hubspotFetch(token, 'GET', CHANNELS_PATH);
  return Array.isArray(res) ? res : [];
}

/**
 * Builds the create/update body from a source broadcast.
 * triggerAt is ALWAYS 0 — the observed draft marker. Nothing here schedules.
 */
function buildBroadcastBody(source, destChannelGuid, destCampaignGuid, tag) {
  const content = {};
  for (const field of CONTENT_FIELDS_MIGRATED) {
    if (source.content && source.content[field] !== undefined && source.content[field] !== null) {
      content[field] = source.content[field];
    }
  }
  if (content.body) content.body = destinationName(content.body) === content.body ? content.body : content.body;
  const body = {
    channelGuid: destChannelGuid,
    triggerAt: 0,            // DRAFT — never a real timestamp
    clientTag: tag,
    content,
  };
  if (destCampaignGuid) body.campaignGuid = destCampaignGuid;
  return body;
}

/** Hard gate: a destination post must be DRAFT or it is cancelled. */
async function enforceDraft(token, guid, result) {
  const check = await getBroadcast(token, guid);
  if (!check) {
    result.draftStatus = 'DRAFT_STATUS_VERIFICATION_FAILED';
    result.notes.push('Destination broadcast could not be re-read after write.');
    return false;
  }
  if (check.status === 'DRAFT') {
    result.draftStatus = 'DRAFT_STATUS_VERIFIED';
    return true;
  }
  result.draftStatus = 'DRAFT_STATUS_VERIFICATION_FAILED';
  result.notes.push(`Destination status is "${check.status}", not DRAFT. Attempting immediate cancel; never publishing as a fallback.`);
  log('ERROR', 'Created broadcast is NOT a draft — cancelling', { guid, status: check.status });
  try {
    await hubspotFetch(token, 'DELETE', `${BROADCAST_PATH}/${guid}`, { allow404: true });
    result.notes.push('Cancel request issued.');
  } catch (err) {
    result.notes.push(`Cancel failed: ${err.message}`);
  }
  return false;
}

/** MIGRATED / READ_ONLY / NOT_SUPPORTED audit for one post. */
function buildFieldAudit(source, dest) {
  const audit = {};
  for (const f of CONTENT_FIELDS_MIGRATED) {
    const s = source.content?.[f];
    if (s === undefined || s === null || s === '') { audit[`content.${f}`] = 'NOT_APPLICABLE'; continue; }
    audit[`content.${f}`] = dest ? (dest.content?.[f] === s ? 'MIGRATED' : 'MISMATCHED') : 'PENDING';
  }
  for (const f of CONTENT_FIELDS_READ_ONLY) audit[`content.${f}`] = 'READ_ONLY';
  for (const f of TOP_LEVEL_READ_ONLY) audit[f] = 'READ_ONLY';
  audit.status = 'INTENTIONAL_DIFFERENCE (source published, destination DRAFT)';
  audit.channelGuid = 'REMAPPED (portal-specific)';
  audit.campaignGuid = 'REMAPPED (portal-specific)';
  audit.targeting = Object.keys(source.targeting || {}).length ? 'NOT_SUPPORTED' : 'NOT_APPLICABLE';
  audit.extraData = source.extraData && Object.keys(source.extraData).length ? 'NOT_SUPPORTED' : 'NOT_APPLICABLE';
  return audit;
}

function compareSocialPosts(sourcePost, destinationPost) {
  const diffs = [];
  for (const f of CONTENT_FIELDS_MIGRATED) {
    const s = sourcePost.content?.[f];
    const d = destinationPost?.content?.[f];
    if (s === undefined || s === null || s === '') continue;
    if (s !== d) diffs.push({ field: `content.${f}`, source: s, destination: d ?? null, result: 'MISMATCHED' });
  }
  return {
    matched: diffs.length === 0,
    statusNote: `INTENTIONAL DIFFERENCE (source=${sourcePost.status}, destination=DRAFT)`,
    mismatches: diffs,
  };
}

// ===========================================================================
// Per-post migration
// ===========================================================================

async function migrateSocialPost({ sourceGuid, sourcePortalId, campaign, destCampaignId, destChannels, counters }) {
  const result = {
    sourceSocialPostId: String(sourceGuid),
    sourceCampaignName: campaign.name,
    destinationSocialPostId: null,
    action: null,
    draftStatus: null,
    outcome: null,
    notes: [],
    fieldAudit: null,
  };

  const source = await getBroadcast(SOURCE_HUBSPOT_ACCESS_TOKEN, sourceGuid);
  if (!source) {
    result.action = 'SKIP';
    result.outcome = 'FAILED';
    result.notes.push('Source broadcast not readable (404) — it may have been deleted.');
    counters.socialPostsSkipped += 1;
    log('WARN', 'Source broadcast not found', { sourceGuid, campaign: campaign.name });
    return result;
  }

  const srcName = source.content?.body || source.messageText || '';
  const destName = destinationName(srcName);
  const tag = clientTagFor(sourcePortalId, sourceGuid);

  // --- channel mapping: portal-specific, never guessed ---------------------
  const destChannelGuid = channelMap[source.channelKey] || channelMap[source.channelGuid];
  if (!destChannelGuid) {
    result.action = 'SKIP';
    result.outcome = 'FAILED';
    result.notes.push(`SOCIAL_ACCOUNT_NOT_MAPPED: source channel "${source.channelKey}" (${source.channelGuid}) has no entry in ${path.basename(SOCIAL_CHANNEL_MAP_FILE)}.`);
    counters.socialAccountNotMapped += 1;
    counters.socialPostsSkipped += 1;
    log('WARN', 'SOCIAL_ACCOUNT_NOT_MAPPED', { sourceGuid, channelKey: source.channelKey });
    return result;
  }
  if (!destChannels.some((c) => c.accountGuid === destChannelGuid || `${c.channelType}:${c.channelId}` === destChannelGuid)) {
    result.notes.push(`Mapped destination channel ${destChannelGuid} is not in the destination portal's connected channels.`);
  }

  result.fieldAudit = buildFieldAudit(source, null);

  // --- idempotency ---------------------------------------------------------
  let existing = null;
  const mapped = migrationMap[String(sourceGuid)];
  if (mapped?.destinationSocialPostId) {
    existing = await getBroadcast(DEST_HUBSPOT_ACCESS_TOKEN, mapped.destinationSocialPostId);
    if (!existing) {
      result.notes.push('Mapping existed but the destination broadcast is gone — recreating.');
      result.action = 'RECREATE';
    }
  }
  if (!existing) {
    const candidates = await listBroadcasts(DEST_HUBSPOT_ACCESS_TOKEN, { limit: 100 });
    existing = candidates.find((b) => b.clientTag === tag)
      || candidates.find((b) => b.content?.body === destName && b.channelGuid === destChannelGuid)
      || null;
    if (existing) result.notes.push('Matched an existing destination broadcast without using the mapping file.');
  }

  const body = buildBroadcastBody(source, destChannelGuid, destCampaignId, tag);
  if (body.content.body) body.content.body = destName;

  if (!result.action) result.action = existing ? 'UPDATE' : 'CREATE';

  if (DRY_RUN) {
    log('INFO', `[DRY RUN] Would ${result.action} Social Post`, {
      sourceGuid, destinationName: destName, channel: source.channelKey, action: result.action,
    });
    result.outcome = 'DRY_RUN';
    counters.socialPostsSkipped += 1;
    return result;
  }

  // --- write ---------------------------------------------------------------
  try {
    let written;
    if (existing) {
      written = await hubspotFetch(DEST_HUBSPOT_ACCESS_TOKEN, 'PUT',
        `${BROADCAST_PATH}/${existing.broadcastGuid}`, { body });
      result.destinationSocialPostId = String(existing.broadcastGuid);
      counters.socialPostsUpdated += 1;
    } else {
      written = await hubspotFetch(DEST_HUBSPOT_ACCESS_TOKEN, 'POST', BROADCAST_PATH, { body });
      result.destinationSocialPostId = String(written?.broadcastGuid ?? '');
      if (result.action === 'RECREATE') counters.socialPostsRecreated += 1;
      else counters.socialPostsCreated += 1;
    }

    const isDraft = await enforceDraft(DEST_HUBSPOT_ACCESS_TOKEN, result.destinationSocialPostId, result);
    if (!isDraft) {
      result.outcome = 'FAILED';
      counters.draftVerificationFailed += 1;
      if (ABORT_ON_FIRST_NON_DRAFT) {
        throw new Error('ABORT: a destination Social Post was not created as DRAFT. Stopping the run so no further posts are written.');
      }
      return result;
    }
    counters.draftVerified += 1;

    const destPost = await getBroadcast(DEST_HUBSPOT_ACCESS_TOKEN, result.destinationSocialPostId);
    result.fieldAudit = buildFieldAudit(source, destPost);
    const comparison = compareSocialPosts(source, destPost);
    result.comparison = comparison;
    result.outcome = comparison.matched ? 'FULLY_REPLICATED' : 'REPLICATED_WITH_API_LIMITATIONS';
    if (!comparison.matched) counters.verificationFailed += 1; else counters.verificationPassed += 1;

    migrationMap[String(sourceGuid)] = {
      sourceSocialPostId: String(sourceGuid),
      destinationSocialPostId: result.destinationSocialPostId,
      sourceCampaignId: campaign.id,
      destinationCampaignId: destCampaignId,
      sourceName: srcName.slice(0, 120),
      destinationName: destName.slice(0, 120),
      clientTag: tag,
      migratedAt: new Date().toISOString(),
    };
    saveMap();
    return result;
  } catch (err) {
    result.outcome = 'FAILED';
    result.notes.push(err.message);
    counters.errors.push({
      campaign: campaign.name,
      sourceCampaignId: campaign.id,
      sourceSocialPostId: String(sourceGuid),
      destinationSocialPostId: result.destinationSocialPostId,
      endpoint: err.url || BROADCAST_PATH,
      httpStatus: err.status ?? null,
      hubspotResponse: err.body ?? null,
      errorMessage: err.message,
      stack: err.stack,
    });
    log('ERROR', 'Social Post migration failed', {
      campaign: campaign.name, sourceSocialPostId: sourceGuid,
      httpStatus: err.status, hubspotResponse: err.body, errorMessage: err.message,
    });
    if (/^ABORT:/.test(err.message)) throw err;
    return result;
  }
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  if (!SOURCE_HUBSPOT_ACCESS_TOKEN) { console.error('Missing SOURCE_HUBSPOT_ACCESS_TOKEN'); process.exit(1); }
  if (!DEST_HUBSPOT_ACCESS_TOKEN) { console.error('Missing DEST_HUBSPOT_ACCESS_TOKEN'); process.exit(1); }

  const counters = {
    startedAt: new Date().toISOString(), completedAt: null,
    campaignsProcessed: 0, campaignsNotFound: 0, campaignsWithErrors: 0,
    socialPostsFound: 0, socialPostsCreated: 0, socialPostsUpdated: 0,
    socialPostsSkipped: 0, socialPostsRecreated: 0,
    associationsCreated: 0, associationsAlreadyExisting: 0,
    draftVerified: 0, draftVerificationFailed: 0,
    verificationPassed: 0, verificationFailed: 0,
    socialAccountNotMapped: 0, errors: [],
  };

  log('INFO', `Starting Social Post migration (DRY_RUN=${DRY_RUN})`);

  const srcAccount = await hubspotFetch(SOURCE_HUBSPOT_ACCESS_TOKEN, 'GET', '/account-info/v3/details');
  const dstAccount = await hubspotFetch(DEST_HUBSPOT_ACCESS_TOKEN, 'GET', '/account-info/v3/details');
  log('INFO', 'Portals', { source: srcAccount?.portalId, destination: dstAccount?.portalId });

  // Pre-flight: the write side needs social-access in the destination.
  let destChannels = [];
  try {
    destChannels = await getChannels(DEST_HUBSPOT_ACCESS_TOKEN);
    log('INFO', `Destination connected social channels: ${destChannels.length}`);
    for (const c of destChannels) log('INFO', `  ${c.channelType}:${c.channelId} "${c.name}" accountGuid=${c.accountGuid}`);
  } catch (err) {
    log('ERROR', 'Cannot read destination social channels — the destination token is missing the `social-access` scope. No Social Post can be created or verified until that is granted.', { httpStatus: err.status, errorMessage: err.message });
    if (!DRY_RUN) { log('ERROR', 'Refusing to continue a live run without destination social access.'); process.exit(1); }
  }

  if (!Object.keys(channelMap).length) {
    log('WARN', `No channel map at ${SOCIAL_CHANNEL_MAP_FILE}. Every post will report SOCIAL_ACCOUNT_NOT_MAPPED. Map source channelKey -> destination accountGuid, e.g. {"FacebookPage:155919314866":"<destination accountGuid>"}.`);
  }

  const results = [];
  for (const name of CAMPAIGN_NAMES) {
    const matches = await findCampaignsByExactName(SOURCE_HUBSPOT_ACCESS_TOKEN, name);
    if (!matches.length) {
      counters.campaignsNotFound += 1;
      log('WARN', 'CAMPAIGN_NOT_FOUND', { campaign: name });
      continue;
    }
    if (matches.length > 1) {
      // Documented behaviour: process every exact-name match, never pick one silently.
      log('WARN', `${matches.length} source campaigns share this name; processing all`, {
        campaign: name, ids: matches.map((m) => m.id).join(', '),
      });
    }

    const destMatches = await findCampaignsByExactName(DEST_HUBSPOT_ACCESS_TOKEN, destinationName(name));
    const destCampaignId = destMatches[0]?.id || null;
    if (!destCampaignId && !CREATE_MISSING_CAMPAIGNS) {
      log('WARN', 'Destination campaign not found; posts will be migrated without a campaign association', { campaign: destinationName(name) });
    }

    for (const campaign of matches) {
      const assets = await getCampaignSocialAssets(SOURCE_HUBSPOT_ACCESS_TOKEN, campaign.id);
      counters.socialPostsFound += assets.length;
      counters.campaignsProcessed += 1;
      const per = { created: 0, updated: 0, skipped: 0, failed: 0 };

      log('INFO', `Campaign: ${name}`, {
        sourceCampaignId: campaign.id, destinationCampaignId: destCampaignId,
        socialBroadcastAssets: assets.length,
      });

      for (const asset of assets) {
        const r = await migrateSocialPost({
          sourceGuid: asset.id, sourcePortalId: srcAccount?.portalId,
          campaign: { id: campaign.id, name }, destCampaignId, destChannels, counters,
        });
        results.push(r);
        if (r.action === 'CREATE' && r.outcome !== 'FAILED') per.created += 1;
        else if (r.action === 'UPDATE' && r.outcome !== 'FAILED') per.updated += 1;
        else if (r.outcome === 'FAILED') per.failed += 1;
        else per.skipped += 1;
      }

      console.log('========================================================');
      console.log(`CAMPAIGN: ${name}`);
      console.log('========================================================');
      console.log(`Source Campaign ID       : ${campaign.id}`);
      console.log(`Destination Campaign ID  : ${destCampaignId || 'NOT FOUND'}`);
      console.log(`Social Posts Found       : ${assets.length}`);
      console.log(`Created                  : ${per.created}`);
      console.log(`Updated                  : ${per.updated}`);
      console.log(`Skipped                  : ${per.skipped}`);
      console.log(`Failed                   : ${per.failed}`);
      console.log('========================================================');
    }
  }

  counters.completedAt = new Date().toISOString();
  writeJsonAtomic(SUMMARY_PATH, { ...counters, results });

  const review = results.filter((r) => r.outcome !== 'FULLY_REPLICATED');
  console.log('\n============================================================');
  console.log('SOCIAL POSTS REQUIRING REVIEW');
  console.log('============================================================');
  for (const r of review.slice(0, 50)) {
    console.log(`${(r.outcome || 'PENDING').padEnd(32)} src=${r.sourceSocialPostId} ${r.notes[0] || ''}`);
  }
  if (review.length > 50) console.log(`... and ${review.length - 50} more (see ${SUMMARY_PATH})`);
  console.log(`\nLog:     ${LOG_PATH}`);
  console.log(`Summary: ${SUMMARY_PATH}`);
  console.log(`Mapping: ${MAP_FILE}`);
}

main().catch((err) => {
  log('ERROR', `Fatal: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
