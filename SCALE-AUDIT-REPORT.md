# Farm Verification — Scale & Reliability Audit

**Date:** 2026-07-14
**Scope:** End-to-end process verification (Haat onboarding + Conversion program, online + offline) for both farmer-facing and FC/admin flows, bug hunt and fixes, and a Firebase-usage architecture redesign for 10 FCs × 5,000 farmers.
**Status:** All changes below are complete, verified against an isolated test namespace (`prakrutik_kheti_LOADTEST_wf1` — production `prakrutik_kheti` was never written to), and committed locally. **Not yet pushed live** — see "Shipping" at the end.

---

## 1. Headline finding: a silent, permanent data-loss bug (fixed)

This is the most serious thing found in the whole audit, so it leads the report.

**The bug:** If a device went offline, an FC enrolled a farmer or submitted a verification, and the app was closed *before* the write ever reached Firebase, that record could get **permanently stuck** on the device — never syncing to the cloud, ever, with no error message and no visible sign anything was wrong.

**Why:** The app's sync engine (`saveDB()`) decides what to upload by diffing the current data against `_lastSnap`, a snapshot taken fresh at every app boot. That snapshot was built from whatever was in the device's local cache — with no way to tell "this record is here because Firebase confirmed it" apart from "this record is here only because it was saved locally and never actually made it to the cloud." A record created entirely offline would sit in local storage looking completely normal; the next time the app opened, `_lastSnap` would treat it as already-synced baseline, and the diff would never flag it as needing to go out again — unless something else happened to edit that same record later.

For a field team enrolling farmers with unreliable signal — exactly the 10-FC/5,000-farmer scenario this audit is for — this is a very plausible real sequence: an FC enrolls a farmer with no signal, closes the app to save battery or move to the next farm, and only reconnects hours or days later. Under the old code, that farmer's entire enrollment could simply vanish from the system's future, with the FC believing it was submitted successfully.

**The fix:** a durable "pending sync" tracker, stored in `localStorage` (survives app close, unlike the in-memory bookkeeping used elsewhere):
- Every record is marked pending **before** the write is attempted, not after.
- It's only cleared once the write is confirmed successful **while online** — matching how Firebase's SDK actually behaves (its write promise can resolve "optimistically" even while offline, so success alone isn't proof the server has it).
- On every app boot, anything still marked pending is excluded from the baseline snapshot, so it's correctly recognized as "still needs to go out" and retried automatically — both proactively at boot and again the moment the device reconnects.

**Verified:** created a farmer entirely offline, confirmed it was marked pending, did a full page reload (killing the old JS session — a faithful simulation of the app being closed), and confirmed the fresh boot automatically detected and resent the pending record, landing correctly in Firebase with the pending marker cleared. Re-ran with the marker artificially absent (the old behavior) to confirm the record really would have been silently lost without this fix.

---

## 2. Second bug found: misleading blank verification form when offline (fixed)

**The bug:** Farm-verification claims are fetched on demand (by design, to keep bandwidth down — see §3). If an FC opened a farmer's verification form while offline, and that farmer's enrollment data had never been downloaded to this device before, the fetch would silently fail — and the form would render **every single question as "No claim from farmer,"** indistinguishable from a farmer who genuinely left everything blank. An FC could unknowingly submit a "verification" that checked nothing against real data.

**The fix:** the app now detects this specific case (fetch attempted, not confirmed successful, no cached data) and blocks the form from opening at all, with a clear bilingual message telling the FC to reconnect and try again — instead of silently proceeding with a hollow form. Verified both ways: the warning correctly blocks farmers whose data was never cached, and a farmer whose data *was* cached while online still opens and works normally offline (no false positives).

---

## 3. Firebase usage — architecture redesign

### What was actually happening

The app already had a good design on paper: farmer records stay lean, and the heavy stuff (each farmer's full enrollment + verification claims, `forms/{farmerId}`) is meant to be fetched **on demand only**, exactly when an admin or FC opens that specific farmer. There's even a comment in the code from an earlier fix explaining this is "what keeps the whole-list sync within the free 10 GB/month bandwidth tier at 5000 entries."

The problem: the app's live-sync listener (the thing that makes changes appear on other devices within ~1 second) was subscribed to the **entire namespace root** — which includes `forms/`. Every single app boot or reconnect downloaded the complete `forms/` tree for every farmer, regardless of whether anyone was about to look at them, silently defeating the on-demand design. Nothing in the app even *reads* that downloaded data (`cloudToDB()`, which turns the raw snapshot into the app's working data, never touches `c.forms` at all) — it was pure waste, every time, for every user.

A second, smaller version of the same problem: the activity/audit log grows forever in Firebase (each device only capped its own local *view* to 200 entries — nothing ever got deleted from the cloud), and that unbounded log was also fully downloaded by the same root listener.

### Measured, not estimated

I built a realistic test dataset (250 farmers, 40% with real submitted forms — a mix of enrollment-only and enrollment+verification, using the app's actual question schema) in an isolated Firebase namespace, and measured actual bytes with the real SDK:

| | Bytes | Share |
|---|---:|---:|
| `forms/` | 1,304,104 | 92% |
| `haatFarmers` | 75,524 | 5% |
| `convFarmers` | 30,729 | 2% |
| `activity` | 7,771 | 1% |
| everything else | ~2,000 | <1% |
| **Total boot download** | **1,420,524 (1.42 MB)** | |

That's at just 40% form coverage and 250 farmers. Real-world steady state — most of 5,000 farmers eventually having a submitted enrollment, many also having an FC verification — points to a **100–150 MB download on every single app open**, for every FC and admin, not once but every time the app is (re)opened.

### The fix, and the measured result

1. **Split the one root listener into targeted per-collection listeners** — `haatFarmers`, `convFarmers`, `fcs`, `verificationPlans`, and a few smaller ones — explicitly excluding `forms/`. Forms stay exactly where they already were meant to be: fetched only when a specific farmer's record is opened. (A boot-order guard was added so the UI doesn't briefly flash "0 records" while the 9 separate listeners are still reporting in for the first time — everything still updates atomically once they've all arrived.)
2. **Capped the live activity log** to the 300 most recent entries. Anything older is moved (not deleted — the accountability trail of who-did-what survives) to a separate `activityArchive/` path that isn't part of the live sync at all.

**Re-measured on the same test dataset:**

| | Old architecture | New architecture |
|---|---:|---:|
| Boot download | 1,581,302 bytes | 214,534 bytes |
| **Reduction** | | **86%** |

This isn't a projection — it's the same real Firebase call, before and after the fix, on the same data.

### What this means at 10 FCs / 5,000 farmers

- **Lean records** (haatFarmers + convFarmers + small collections), the only thing every device now downloads on boot: roughly **5–10 MB total**, using this app's own real measured per-record sizes (≈650 bytes/haat farmer, ≈1,650 bytes/conversion farmer).
- **Forms** stay fetched only for the specific farmer whose drawer, verification form, or comparison view is actually opened — a few tens of KB per farmer looked at, not thousands of farmers downloaded speculatively.
- **Activity log** stays bounded at ~60–90 KB regardless of how much history accumulates over the program's lifetime.

Even with 10 FCs and a couple of admins each reopening the app several times a day, this puts total monthly Firebase RTDB egress in the **tens of MB to low hundreds of MB** range — comfortably inside the Spark (free) plan's 10 GB/month bandwidth limit, versus the old architecture which could have blown through it from a handful of devices alone.

---

## 4. What was tested and confirmed working (no bugs found)

Beyond the two bugs above, the following were driven end-to-end through the real UI (not just unit-checked) and found correct:

**Haat onboarding, online:** application submission → FC field verification with photo attachment → admin decision (onboard/hold/reject with note) → haat assignment → mark active/inactive → income visit logging → seasonal re-verification detection (180-day interval, correctly surfaces in both the dashboard and the Verification Queue's Seasonal tab).

**Haat onboarding, offline:** verification submission (including marking 75 claims) while offline, durable queuing confirmed in IndexedDB, full recovery and correct sync on reconnect (claims and stage both landed correctly in Firebase, verification lock correctly released) — plus the new-farmer-enrollment case (record creation, not just an update) offline, with the same durable-queue and clean-flush behavior confirmed.

**Conversion program:** the 100-mark scoring framework (A1/A2 chemical-free checks, B1–B4 natural-practice adoption, C area-expansion) was checked against hand-computed expected scores, including the "no-compromise" rule (any A1/A2 failure forces "Not Adopted" regardless of an otherwise-high score) — correct in both the underlying calculation and the real assessment modal. Auto score-banding (Not Adopting / In Progress / Adopted) correctly reflects saved scores in the live UI. Bulk-assign-by-taluka correctly assigned all 99 test farmers in one action.

**Cross-device consistency:** two independent sessions against the same data — live propagation confirmed in both directions within ~3 seconds, and simultaneous edits to two different farmers on two different devices did not clobber each other. Re-verified specifically against the new split-listener architecture (not just the old code) to rule out a regression from the sync-engine changes above.

---

## 5. Recommended next phase — not built yet, needs your decision first

**Role-scoped reads for FCs.** Right now, every FC's device syncs *all* 5,000 farmers, not just the ones relevant to them — a deliberate v9 decision so FCs could "back each other up." At 10 FCs, that means the lean-record sync (§3) gets multiplied by 10 unnecessarily.

The natural next step is genuine server-side scoping — using Firebase's query support (e.g., fetch only farmers where `fcId` equals the current FC, plus a separate small query for unassigned farmers in their district) instead of downloading everyone and filtering in the browser. Done right, this would cut the already-small remaining sync further, roughly in proportion to team size.

I'm flagging this rather than building it because:
- It depends on a product decision this app doesn't currently make explicitly — how much visibility an FC should default to (own farmers only? own district? explicit "see all" toggle?) — which came up in an earlier conversation about simplifying the app's workflow and hasn't been finalized.
- It requires adding database index rules (`fcId`) for the queries to actually run server-side instead of silently falling back to client-side filtering (which would look like it worked but deliver none of the savings).
- It's a change to the core farmer-fetching model — the same category of risk as the fixes in this report, and I'd rather ship and confirm those first before stacking another architectural change in the same sitting.

Happy to design and build this as a follow-up once you've had a chance to decide the scoping model.

---

## 6. Also still open (from earlier in this project, unrelated to this audit)

Two items flagged in an earlier conversation remain open and weren't part of this pass:
- **Crop/district name cleanup** — 156 of 166 distinct crop values in the live data are romanized Gujarati that never matched the canonical bilingual catalog (e.g. "Gau", "Dudhi", "Tameta"). Needs your confirmation on ambiguous/high-volume mappings before any bulk correction, since guessing wrong would mislabel real records.
- These are unrelated to the Firebase-usage or offline-reliability work above and don't block shipping this report's changes.

---

## 7. Shipping

All changes above are complete and verified in the isolated test namespace, syntax-checked, and the temporary namespace-override test patch has been fully reverted (confirmed `FB_NAMESPACE` is back to the real `prakrutik_kheti` constant, no test artifacts left in the file). **Nothing has been pushed live yet.**

Next step, pending your go-ahead: bump the version (v35 → v36), final syntax + diff review, commit, and push — same process as every other release this project has shipped.
