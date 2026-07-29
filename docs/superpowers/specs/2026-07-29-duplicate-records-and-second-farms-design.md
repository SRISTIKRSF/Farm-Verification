# One farmer, one number, many farms and many forms

**Status:** design, awaiting approval
**Date:** 2026-07-29

> This repository is public. Farmer names, phone numbers and villages are
> deliberately kept out of this document. The worked examples behind it are in
> the private audit notes under `_backups/`, which is gitignored.

## The goal

1. Each farmer should have only one enrollment id.
2. A farmer may have two farms at different locations — but that should fall
   under the single farmer only.
3. If we get two entries, show them under the same farmer as different forms
   (a click for Form 1 and Form 2).

Clarified since:

- **"One enrollment id" means one record per person.** The existing internal
  id format is kept and nothing is renumbered. A readable district-coded
  number may come later; it is not part of this work.
- **A second form on a known phone attaches automatically when the name
  matches**, and waits in Needs attention when it does not.

## What is true today

Measured against production on 2026-07-28.

**There is no enrollment-number field.** Active haat farmers carry an internal
random `id` and nothing else. The `enrollmentId` in the code sits inside the
certification block and holds a PGS certificate number — unrelated. The
`counters.haatEnroll` / `counters.farmerApp` nodes are never read by this app.

**FC and admin duplicate submissions are discarded.** When a form is submitted
for a phone already on file, the app increments `duplicateAttempts` on the
existing farmer, logs "Ignored", and throws the form away. Five farmers carry
that counter — five completed forms that no longer exist. The public form has
not done this since v124; it saves to Needs attention. Goal 3 closes this hole.

**17 phone collisions across 34 records.** 16 are the same person entered
twice; one is a single farmer with farms in two different districts; one pair
may be two people sharing a handset and needs a phone call to settle.

## What changed from the first version of this design

The first version proposed **linking** two records under a shared `personId`.
That gives one person but two ids, which contradicts goal 1. **Dropped.**

It also merged all 88 form answers field by field — 22 decisions for a single
pair. Goal 3 removes the need: **forms are never merged.** Each submission is
kept whole and shown as Form 1, Form 2. Only the small summary the lists and
map read needs one agreed value, and that comes from a nominated master form.
Roughly six decisions instead of twenty-two, and nothing is destroyed.

## Target shape

```
Farmer                        one record, one id, one human
  identity    name, phone, aadhaar
  masterForm  id of the submission the summary fields come from
  farms[]     { id, village, taluka, district, surveyNos, acres,
                fcId, visits[], status }
  forms[]     every submission ever received, kept whole
```

Verification moves from the farmer to the farm. That is what goal 2 requires:
a farmer with land in two districts needs two FCs (FC reads are
district-scoped), two visits and two independent results.

**Known limit — do not overstate this in the UI.** "A failed farm excludes
only its own produce" cannot be enforced by the app: there is no produce
tracking, so nothing links a sack of grain to a plot. Treat it as guidance for
the FC, not a system guarantee.

## Delivery in three stages

### Stage 1 — stop losing forms

A submission for a known phone is attached to that farmer instead of discarded.

- Names match → attached as Form 2, admin notified.
- Names differ → held in Needs attention.

No structural change. Fixes the live data-loss path above. Small.

**Name matching — every token must match, allowing a spelling variance on at
most one.** A percentage-overlap rule is WRONG here and would silently merge
different people. Gujarati names are patronymic — given name, father's name,
surname — so a father and son share two of three tokens by construction. A
"most tokens match" rule merges them. Requiring all tokens to match, with one
allowed to differ only by spelling, separates the two cases: a genuine
re-submission differs by spelling, whereas a father and son differ by a whole
name.

**Cross-script names cannot be matched at all.** The same person written in
Gujarati and in English shares no characters. Those fall to Needs attention,
which is the correct and safe outcome — never a silent merge.

### Stage 2 — the merge tool

Collapse the existing duplicate pairs into one farmer each.

- Admin picks the master form; summary fields fill from it; each can be
  overridden individually.
- Both forms are kept and become Form 1 and Form 2 on the surviving farmer.
  Note that forms are keyed by the *record* id, so the survivor's `forms[]`
  references the archived record's id. Form storage keys therefore no longer
  correspond one-to-one with live farmer ids.
- The other record is archived, never deleted.

**Which record survives matters** the moment a readable enrollment number is
introduced: if a number has been given to a farmer, the record holding that
number must be the survivor, regardless of which is fuller.

Delivers goals 1 and 3 for the existing backlog. Medium.

### Stage 3 — farms as a list under the farmer

`visits`, `fcId` and `status` move from the farmer onto a farm. The
verification queue, FC district-scoping, visit planning, the dashboard and the
FC's phone screens read a derived list of farms rather than farmers.

This is the invasive stage. What makes it survivable: **99.5% of farmers have
exactly one farm**, so `farms[0]` inherits precisely what the farmer record
holds today and nothing changes on screen for them.

**Knock-on:** the Haat catchment map currently counts farmers per district. A
farmer with farms in two districts makes that ambiguous, so the map must count
farms after this stage.

## Safety

- Nothing is hard-deleted at any stage. Merged-away records are archived and
  remain restorable.
- No form is ever overwritten or combined. Every submission stays whole at its
  own address — which is what made the 2026-07-28 recovery possible.
- Every merge writes an activity entry naming both record ids and the admin.

## Testing

- Red-green on counting: one farmer with two farms counts as one farmer and
  two farms.
- A merge must preserve both forms and leave both retrievable afterwards.
- Name matching: a re-submission with a spelling variance attaches; a
  father/son pair sharing surname and patronymic must NOT; cross-script pairs
  must go to review.
- Script guard: the same village typed in Gujarati and in English must not be
  read as two farms.
- Stage 3 regression: a farmer with one farm must look and behave exactly as
  today on every screen, including the FC phone screens at 375 px.
- Verify against real production data in a sandbox copy, not fixtures.

## Open questions

1. One number carries two records with similar but distinct surnames in the
   same village. One person or two? If two people genuinely share a handset,
   phone-as-identity needs revisiting, which is larger than this design.
2. A farm has no id today. Stage 3 needs one, and it must be stable so visit
   history survives a farmer edit.
