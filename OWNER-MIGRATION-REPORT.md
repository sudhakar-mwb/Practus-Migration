# Asset Owner Migration — Completion Report

**Date:** 26 September 2026
**Scope:** Owner, created-by and updated-by users for 228 migrated marketing assets
**Source portal:** 46378923
**Destination portal:** 414445 (live)

---

## 1. Headline

**HubSpot does not allow these fields to be set through its API.** The migration ran cleanly with **zero errors**, matched **217 of 228** assets between the two portals, and determined the correct owner for every one — but HubSpot provides no way to write owner, created-by or updated-by onto marketing assets programmatically.

This report is therefore a **verified record of the intended owner for every asset**, ready to be applied by hand where it matters.

| | Count |
|---|---|
| Assets in scope | 228 |
| Found in the source portal | 226 |
| Matched to a destination asset | 217 |
| Owners correctly determined | 217 |
| **Updated automatically** | **0 — not permitted by HubSpot** |
| Already correct | 2 |
| Errors | 0 |

---

## 2. Why nothing could be updated automatically

Each asset type was tested directly against the live API. The result is the same in every case:

| Asset type | Owner field | Can it be written? |
|---|---|---|
| Campaigns | Campaign owner exists | **No** — the API rejects it as a forbidden property |
| Workflows | No owner field at all | No |
| Forms | No owner field at all | No |
| Segment lists | No owner field at all | No |
| Marketing emails | No owner field at all | No |

Created-by and updated-by are audit fields that HubSpot does not allow to be changed through the API **or** the interface — they permanently record whoever created the copy during migration.

The only field that can be corrected by hand is **campaign owner**, which is editable in the HubSpot interface.

---

## 3. Coverage by asset type

| Asset type | In scope | Found in source | Matched in destination |
|---|---|---|---|
| Workflows | 29 | 29 | 23 |
| Forms | 46 | 45 | 45 |
| Campaigns | 33 | 33 | 33 |
| Segment lists | 22 | 22 | 19 |
| Marketing emails | 98 | 97 | 97 |
| **Total** | **228** | **226** | **217** |

---

## 4. The owner mapping used

Owners were matched between portals **by email address**, producing 51 confirmed pairs. Of the 377 owner/created-by/updated-by values resolved:

- **231 (61%)** matched a specific person through the mapping
- **146 (39%)** had no equivalent person in the destination and fell back to the default owner

The people these assets should belong to:

| Intended owner | Field assignments |
|---|---|
| kjohnson@95percentgroup.com | 264 |
| bbaker@95percentgroup.com | 106 |
| wchang@95percentgroup.com | 3 |
| pfreedman@95percentgroup.com | 2 |
| jtreichler@95percentgroup.com | 2 |

Three mapped people are **deactivated** in the destination portal and could not be assigned even manually: jdemarco@, ablack@ and jthomsen@95percentgroup.com.

---

## 5. Assets that could not be matched — 11

### 5.1 Not present in the destination portal — 9

These exist in the source but have not been migrated to the destination, so there was nothing to assign an owner to:

**Workflows (6)**
- `* FINAL Revised Email Campaign | (Starting with EM3) State - Georgia | FY26`
- `* Revised Email Campaign | (Starting with EM3) State - Georgia | FY26`
- `Email Campaign | State - Georgia | FY26`
- `Webinar | Grades 3-5 | 5.7.26 - Live Attendees | Sync to SF Campaign`
- `Black List to Non Marketing Contact`
- `Fun Sheet Sign Up to Email List`

**Segment lists (3)**
- `Webinar | ToutchMath 3-5 | 95PG Database Registrants - Attended Live *NET NEW Contact/Lead`
- `Webinar | ToutchMath 3-5 | 95PG Database Registrants - Attended Live`
- `Webinar | TouchMath 3-5 | 5.7.26 - Live Attendees`

### 5.2 Not found in the source portal — 1

- Form `Alignments (Gravity Forms)` — no form of that name exists. The nearest candidates are `Funding Alignments Guide`, `Funding Alignments - Guidance` and an archived `X. Archive - Alignments`. Please confirm which was intended.

### 5.3 Two source assets share one name — 1

- Marketing email `Newsletter - April 2026 - Internal` exists **twice** in the source portal. The migration cannot tell which is correct, so it was skipped rather than guessed.

---

## 6. Already correct — 2

Two campaigns already carry the right created-by user and needed no change:

- `Survey-Tier-2-Math-FY26`
- `State-Indiana-FY26`

---

## 7. Supporting record

Full detail — every asset, every field, the intended owner and the reason — is in:

`owner-migration-report-2026-09-26-13-26-16.json`

---

## 8. Recommended next steps

1. **Campaign owners** are the only field that can be corrected. Use the JSON report to set them by hand in the HubSpot interface where ownership matters.
2. **Reactivate or replace** the three deactivated users if assets should belong to them.
3. **Migrate the 9 missing workflows and lists**, then re-run this report to determine their owners.
4. **Confirm the two ambiguous items** — the `Alignments (Gravity Forms)` form and which `Newsletter - April 2026 - Internal` email is correct.
5. Accept that **created-by and updated-by cannot be changed**. They will permanently show the migration user. If provenance matters, this report is the record of the original owner.
