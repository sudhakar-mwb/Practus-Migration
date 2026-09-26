# Campaign Migration — Completion Report

**Date:** 25 September 2026
**Scope:** 33 selected TouchMath campaigns
**Source portal:** 46378923
**Destination portal:** 414445 (live)

---

## 1. Summary

| Result | Count |
|---|---|
| Campaigns in scope | 33 |
| Found in the source portal | 33 |
| **Successfully migrated** | **33** |
| Failed | 0 |
| Fully replicated, nothing outstanding | 7 |
| Migrated with items needing attention | 26 |

**All 33 campaigns are now live in the destination portal, with no failures.**

The campaign count moved from 697 to 728 — 31 new campaigns created, and 2 existing campaigns recognised and updated rather than duplicated. **No duplicate campaign names exist.**

---

## 2. The campaign records are an exact match

Every field HubSpot permits writing was verified field-by-field against the source after migration:

| Field | Result |
|---|---|
| Start date | 33 of 33 match |
| End date | 33 of 33 match |
| Notes | 33 of 33 match |
| Audience | 33 of 33 match |
| Currency | 33 of 33 match |
| Status | 33 of 33 match |
| UTM tracking | 33 of 33 match |

Campaigns are named with a `Touchmath | ` prefix:

> Source: `TAW2026` → Destination: `Touchmath | TAW2026`

The source portal was read only — nothing there was changed.

---

## 3. Property created in the destination

One property was added to the campaigns object, as authorised:

| Property | Purpose |
|---|---|
| `source_campaign_id` | Records which source campaign each destination campaign came from |

This is what makes the migration safely repeatable — see section 6. No existing property was modified or deleted.

---

## 4. Asset links

Campaigns link to the marketing assets that belong to them:

| | Count |
|---|---|
| Asset links in place | 96 |

---

## 5. Items needing attention — 330 in total

None is a failure of the campaign migration. They fall into four groups.

### 5.1 Linked assets that do not exist in the destination — 167

A campaign can only link to an asset that exists in the destination portal. These were skipped rather than linked to the wrong record:

| Asset type | Count |
|---|---|
| Marketing emails | 148 |
| Forms | 16 |
| Landing page / file / list / workflow | 3 |

**Action:** if these assets belong to the campaigns, migrate them first. Re-running the campaign migration afterwards links them automatically, without duplicating anything.

### 5.2 Social posts — 154

HubSpot provides **no public API** for recreating social posts. Verified directly: the modern social endpoints do not exist, and only a deprecated legacy API remains, which cannot recreate a post in another portal.

**Action:** recreate by hand in the destination if required. This is a HubSpot platform limitation.

### 5.3 Assets with more than one possible match — 6

Six marketing emails could not be linked because **two** destination emails share the same name, for example `EM1: Indiana Tier-2 FY26`. Rather than guess, the migration skipped the link.

**Action:** confirm which copy is correct, remove or rename the other, then re-run.

### 5.4 Fields HubSpot will not accept, and one owner — 3

- **2 campaigns** need their campaign colour set by hand (`#00bda5` and `#ea90b1`). HubSpot's API rejects this field on write even though it can be read.
- **1 campaign owner** could not be assigned: `ablack@95percentgroup.com` has no matching user in the destination portal.

---

## 6. Re-running is safe

Each destination campaign carries `source_campaign_id`, identifying the source campaign it came from. The migration matches on that, so a re-run updates the existing campaign instead of creating a second one.

This was proven immediately after the initial run: a second pass reported **33 updates and 0 creations**, and the portal still holds exactly 33 migrated campaigns with no duplicates.

---

## 7. Supporting records

| Record | Location |
|---|---|
| Per-campaign outcome | `logs/success-2026-09-25T11-29-19-755Z.json` |
| All 330 items needing attention | `logs/errors-2026-09-25T11-29-19-755Z.json` |

---

## 8. Recommended next steps

1. Decide whether the 148 unmigrated marketing emails and 16 forms belong in the destination. If so, migrate them and re-run to link them automatically.
2. Resolve the 6 duplicate-named marketing emails so those links can be made.
3. Decide how to handle the 154 social posts, which can only be recreated manually.
4. Set the campaign colour on the 2 campaigns listed in the log.
5. Add the missing user to the destination portal if that campaign owner must be preserved.
