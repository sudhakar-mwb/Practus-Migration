# Workflow Migration — Completion Report

**Date:** 24 September 2026
**Scope:** Migration of 29 selected TouchMath workflows between HubSpot portals
**Source portal:** 46378923
**Destination portal:** 414445 (live)

---

## 1. Summary

| Result | Count |
|---|---|a
| Workflows in scope | 29 |
| **Successfully migrated** | **23** |
| Failed with an error | 0 |
| Held — waiting on a prerequisite | 6 |
| Migrated but needing a review | 1 (included in the 23) |

**23 of 29 workflows were migrated with no failures.** The remaining 6 were deliberately not migrated because each depends on something that does not yet exist in the destination portal — see section 4.

---

## 2. All migrated workflows are switched OFF

Every migrated workflow was created **turned off** in the destination portal, regardless of whether it was on in the source. This was verified directly in the portal after the run: **0 of the 23 are enabled.**

Nothing will enrol contacts, send email, or take any action until someone reviews it and switches it on deliberately.

Workflows are named with a `Touchmath | ` prefix followed by the original name, so the migrated set is easy to identify:

> Source: `State | Indiana | FY26 - Sync to SF Campaign`
> Destination: `Touchmath | State | Indiana | FY26 - Sync to SF Campaign`

The source portal was read only — nothing there was changed.

---

## 3. Verification performed

Confirmed by querying the destination portal after the run, not only from the migration log:

- **23** workflows named `Touchmath | …` are present.
- **0** duplicates — each appears exactly once.
- **0** are enabled.
- Workflow count moved from 505 to 528, consistent with 23 additions and nothing else affected.

### Property created

One contact property the workflows filter on did not exist in the destination portal and was created automatically, copied from the source definition:

| Property | Label | Object | Group |
|---|---|---|---|
| `database` | TM Database? | Contact | Contact information |

No existing property was modified or deleted.

---

## 4. The 6 held workflows — and why

These were **not** created. Each one filters on a contact list or email that does not yet exist in the destination portal. Rather than copy across a reference number that would point at an unrelated record in the destination portal, the migration stopped and flagged it.

This is a safety measure: HubSpot accepts a foreign list number without complaint and would build a workflow that quietly enrols the wrong people, or nobody at all.

| Workflow | Waiting on |
|---|---|
| `Fun Sheet Sign Up to Email List` | List **"Fun Sheets Sign Up"** (static) |
| `Black List to Non Marketing Contact` | List **"Black List Communications"** (active) |
| `Webinar \| Grades 3-5 \| 5.7.26 - Live Attendees \| Sync to SF Campaign` | List **"Webinar \| TouchMath 3-5 \| 5.7.26 - Live Attendees"** (active) |
| `Email Campaign \| State - Georgia \| FY26` | 3 email-engagement references |
| `* Revised Email Campaign \| (Starting with EM3) State - Georgia \| FY26` | List **"Email \| Georgia (Updated List)"** + email references |
| `* FINAL Revised Email Campaign \| (Starting with EM3) State - Georgia \| FY26` | List **"Email \| Georgia (Updated List) FINAL"** + email references |

**These are recoverable.** Once the missing lists exist in the destination portal, re-running the migration picks them up automatically and creates the workflows — it will not duplicate the 23 already migrated.

### A connected issue worth knowing

One of these, **"Webinar | TouchMath 3-5 | 5.7.26 - Live Attendees"**, is the same list that could not be migrated during the earlier contact-list migration. It filters on a webinar event that is not available in the destination portal in the same form. That single gap is now blocking three things: the list itself, two other lists that reference it, and this workflow. Resolving it unblocks all four.

---

## 5. One migrated workflow needs a review

| Workflow | Destination ID | What to check |
|---|---|---|
| `Touchmath \| Funding Alignment Guide - Sync to SF` | 1889970971 | Its enrolment criteria did not match the source exactly after migration. |

The workflow exists and is switched off. Someone familiar with its intent should compare its enrolment trigger against the source before enabling it.

---

## 6. Re-running is safe

The migration records which destination workflow came from which source workflow. If that record is lost, it also recognises an existing workflow by name and adopts it rather than creating a second copy. Re-running after fixing the items above will therefore create only what is genuinely missing.

Workflows that have already been switched on are never modified by a re-run.

---

## 7. Supporting records

| Record | Location |
|---|---|
| Successfully migrated workflows | `workflow_migration_success.json` |
| Held and review items, with reasons | `workflow_migration_errors.json` |
| Source → destination workflow ID map | `workflow_id_mapping.json` |
| Cross-portal asset ID map used for this run | `asset_id_mapping.json` |

---

## 8. Recommended next steps

1. Resolve the **"Webinar | TouchMath 3-5 | 5.7.26 - Live Attendees"** list gap — it unblocks three lists and one workflow.
2. Create or migrate the remaining lists named in section 4, then re-run to pick up the 6 held workflows.
3. Review the enrolment criteria on `Touchmath | Funding Alignment Guide - Sync to SF`.
4. Review each of the 23 migrated workflows and switch on only those that are intended to run.
