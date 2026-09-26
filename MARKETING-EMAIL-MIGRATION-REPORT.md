# Marketing Email Migration — Completion Report

**Date:** 24 September 2026
**Scope:** Migration of 98 selected TouchMath marketing emails between HubSpot portals
**Source portal:** 46378923
**Destination portal:** 414445 (live)

---

## 1. Summary

| Result | Count |
|---|---|
| Emails requested for migration | 98 |
| Located in the source portal | 98 |
| **Successfully created in the destination portal** | **97** |
| Failed with an error | 0 |
| Requires a decision before migrating | 1 |

**97 of the 98 requested emails were migrated successfully, with no failures.**

The single outstanding item is not an error — it needs a content decision from your team (see section 4.1).

### Supporting assets migrated alongside the emails

| Asset | Count |
|---|---|
| Contact lists created in the destination | 6 |
| Existing destination lists reused | 7 |
| Images and files imported | 32 |

---

## 2. How the emails appear in the destination portal

Every migrated email is named with a `Touchmath | ` prefix followed by its original name, so the migrated set is easy to identify and filter:

> Source: `EM4: Indiana Tier-2 FY26`
> Destination: `Touchmath | EM4: Indiana Tier-2 FY26`

**All 97 emails were created as drafts. Nothing was published, scheduled, or sent.** No email was delivered to any contact as part of this migration.

The source portal was read only. Nothing in the source portal was changed, archived, or deleted at any point.

---

## 3. Verification performed

The results below were confirmed by querying the destination portal directly after the migration, not only from the migration log:

- **97** emails named `Touchmath | …` are present in the destination portal.
- **0** duplicates — every migrated email appears exactly once.
- **97 of 97** are in `DRAFT` state.
- **0** are published or sent.
- Destination email count rose from 2,745 to 2,842, consistent with 97 additions and no unintended changes.

---

## 4. Items requiring your attention before these emails are used

The emails are in place, but the following should be reviewed before any of them is sent.

### 4.1 One email not migrated — duplicate name in the source portal

Two different emails in the source portal share the exact same name:

> **`Newsletter - April 2026 - Internal`**
> Source IDs: `209921507438` and `211060039810`

Because the migration identifies emails by name, it cannot tell which of the two you intended, so it deliberately migrated neither rather than guessing and copying the wrong one.

**Action needed:** confirm which of the two is the correct version. Once confirmed, it can be migrated in a short follow-up run.

### 4.2 Recipient lists must be confirmed before sending — 87 emails

Contact list references are numbered differently in each HubSpot portal, so a list number copied across would silently point at an unrelated audience. Rather than risk that, **87 emails had their legacy recipient list references removed**.

**Action needed:** set the recipient list on each email in the HubSpot interface before sending. This is the most important item in this report — an email sent without checking this could go to the wrong audience or to no one.

### 4.3 Active (dynamic) lists not recreated — 16 emails

16 emails referenced "active" lists, which update their membership automatically based on filter rules. Those rules depend on data specific to the source portal, so they cannot be reliably rebuilt automatically.

**Action needed:** recreate the equivalent active lists in the destination portal, or select suitable existing lists, for these 16 emails.

### 4.4 Design modules and CTAs — 97 emails

The migrated emails reference custom design modules, calls to action, and similar design assets (around 12 references per email). These are part of the portal's template library rather than the email itself, and there is no reliable automated way to copy them between portals.

**Action needed:** open a sample of the migrated emails in the destination portal and confirm they render correctly. Where a module is missing, it will need to be recreated or remapped in the destination template library.

### 4.5 Email folder organisation

All migrated emails were placed in the default location rather than mirroring the source portal's folder structure, because HubSpot provides no way to create email folders automatically.

**Action needed:** if the original folder structure matters, create the folders in HubSpot and move the emails, or tell us the intended structure.

### 4.6 Transactional flag — no action expected

The migration report flags the "transactional" setting as unconfirmed on all 97 emails. This is a limitation of HubSpot's API, which does not return that field when reading an email back. All source emails were standard (non-transactional) marketing emails, which is also the destination default, so no difference is expected. Verify in the interface only if transactional sending is relevant to you.

---

## 5. Re-running is safe

The migration keeps a record linking each source email to the email it created. Re-running it updates those same 97 emails rather than creating second copies. This means the outstanding items above can be corrected and the migration re-run without risk of duplication.

---

## 6. Supporting records

Full technical records of this run are retained:

| Record | Location |
|---|---|
| Run log, per-email outcome | `logs/run-2026-09-24T11-02-56-831Z/` |
| Machine-readable summary | `logs/run-2026-09-24T11-02-56-831Z/marketing-email-migration-summary.json` |
| Items needing manual attention | `logs/run-2026-09-24T11-02-56-831Z/marketing-email-manual-review.log` |
| Field-by-field comparison | `logs/run-2026-09-24T11-02-56-831Z/marketing-email-field-comparison.json` |
| Source → destination email ID map | `marketing-email-migration-map.json` |

---

## 7. Recommended next steps

1. Confirm which `Newsletter - April 2026 - Internal` is correct, so the 98th email can be migrated.
2. Set recipient lists on the 87 affected emails before any send (section 4.2).
3. Recreate or reassign the 16 active lists (section 4.3).
4. Spot-check rendering on a sample of emails and address any missing design modules (section 4.4).
5. Confirm the intended folder structure, if required.
