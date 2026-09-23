# Phase 4 — dev validation test plan

Run against **`kidclub-dev`** (`kidclub-dev-arcoiris.web.app`). Prod is read-only throughout;
the prod checks below exist to catch divergence, not to change anything.

Tick each step. Anything that does not match the "expected" column is a finding — write it in
`STATUS.md` rather than fixing it inline, unless it is obviously trivial.

**Logins**
- staff/admin — `admin@kidclub.pt`
- parent — `parent-test@kidclub.pt` (password was set at seed time; reset from the Firebase
  console if lost). No roles at all, so it exercises the real parent path.

**Test data** — `TEST-FAMILY-QA`, seeded by `seed-test-family.mjs`. Every document carries
`isTestData: true` and a `TEST-` id prefix. Re-seed at any time; `--delete --apply` removes it.

---

## A. Parent path — the point of the whole rewrite

This has **never been exercised by a real parent**, on any environment. It is the highest-value
part of this plan.

| # | Step | Expected |
|---|---|---|
| A1 | Log in as `parent-test@kidclub.pt` | Sees **only** Família Teste QA: Ana, Bruno, Carla |
| A2 | Mark an absence on a future day for **Ana's transport** | Saves without error; the day shows as cancelled |
| A3 | Re-open the page | The absence is still there — it is a stored event, not UI state |
| A4 | Un-mark it | Returns to expected |
| A5 | Try to mark a day in the **past** | Currently **allowed** — there is no cutoff. Note what it does; this is a known gap, not a regression |
| A6 | Log in as `admin@kidclub.pt` and mark an absence on the same subscription | Works too — same path, both roles |

**A7 — the authorisation boundary.** As the parent, try to reach another family's data (open a
billing or calendar URL for a different `familyId`). Expected: **permission denied**. This is the
`firestore.rules` scoping and the `primaryContact.userId` check. If a parent can read another
family's events, stop and report it — that is the one failure here that is serious.

## B. The ≥3-absence credit threshold

The single most informative click in this plan.

| # | Step | Expected |
|---|---|---|
| B1 | Admin → billing → Família Teste QA, October 2026 | Ana transport **€92.16, 2 absences, €0 credit** |
| B2 | Mark **one more** absence on Ana's transport, in October | Absence count 3 → credit switches **on**, amount drops |
| B3 | Bruno's study line, same month | **€22.95, 3 absences, €13.77 credit** — already crediting |
| B4 | Un-mark one of Bruno's three | Falls to 2 → credit switches **off**, amount returns to €36.72 |

Reset either side with `node set-test-absences.mjs --reset --apply` then
`node set-test-absences.mjs --period 2026-10 --apply`.

## C. Discounts — the marginal model

| # | Check | Expected |
|---|---|---|
| C1 | Ana study (first-enrolled child) | €48.00 — **no** sibling discount |
| C2 | Bruno study | sibling €4.80 **+ manual 15% €6.48** — the manual and `returningStudent` must never stack to 30% |
| C3 | Ana transport | multi-trip **€4.80 only** — the second leg of each two-leg day, not every trip |
| C4 | Bruno transport | multi-trip + sibling + school 20% together |
| C5 | Carla transport (starts **15 Oct**) | **€17.28**, 4 system absences, €17.28 credit — decision 8 pro-rating a boundary month |
| C6 | Admin toggles a discount off, then hits **"Repor automático"** | The automatic rule resumes; no double application (decisions 9 and 11) |

## D. Real migrated data

| # | Check | Expected |
|---|---|---|
| D1 | Inês Pinto (Carolina Almeida), October | **€182.40** |
| D2 | Miguel Melo (José Eduardo) | **€165.12** |
| D3 | Andreia Lobo (Maria Manon) | **€130.56** |
| D4 | Sandra Abreu (Mogo siblings) | **€210.00** — Diogo loses his sibling discount, being ranked first by value |
| D5 | Any month, whole-database total | **€2,892.96** — identical in every month, August 2027 included |
| D6 | Susete Luis' exclusion calendar | Migrated absences visible; no orphaned unclickable dates |
| D7 | José Miguel Duarte / Edson | Billing **restored** (€113.28 / €72.00), records `pending` not cancelled |

**D8 — invoiced records are frozen.** The 5 invoiced September records must be unchanged and
un-editable:
`A7OXOljX1W9xrEn5mhP8_2026-09`, `IF63OZ6AWZKPQ9ctZpiF_2026-09`, `M7f2nAhCV1U8rnm0e805_2026-09`,
`Nk7GmFSkSm7zzLYdMD66_2027-08`, `lwHDLzM42YlNfiYen4GA_2026-09`. Their `updatedAt` must still
predate the migration. The reconciliation report lists 4 of them as diverging — **reported, never
corrected**, per decision 5.

## E. Things that will look wrong and are not

- Financial Summary shows **€0** driver/electricity cost. The prod import overwrote dev's
  `config/transportation`. Re-enter €1400 / €300 in "Custos Fixos" if you want that page to read
  correctly.
- **August 2027 bills a full month** with zero events, as does the second half of July 2027.
  `yearEndDate` is 2027-07-15 (confirmed correct, decision 17) and billing runs to August
  regardless — decision 10.
- 3 children have **no `children` record** (Afonso Santos, Camila Felix, Laura Baptista) and
  Matilde Lopes resolves to no family. Reported by `identity.mjs`, deliberately not invented.

---

## F. Prod checks — READ ONLY

Do not write to prod. Read with a `gcloud auth print-access-token` against the Firestore REST
API, the pattern the migration scripts use; add no standing access.

**F1 — divergence introduced by testing.** Dev and prod have drifted on purpose. Confirm prod
still holds its own values:

```bash
node migrate.mjs --project rainbow-prod-2454b        # DRY RUN — --apply is refused for prod
```

Expect, unchanged from 2026-09-22: 11 orphan subs, 75 excludedDates + 13 eventModifications,
35 auto-cancelled records, 5 invoiced frozen, **0 existing reservationEvents**, 4,683 events to
create.

**F2 — the Brito status correction has NOT reached prod.** Verified 2026-09-23:

| | dev | prod |
|---|---|---|
| `transportationSubscriptions/cz7N6U8qsO20Zvo2wBEM` (Francisco Brito) | `active` | **`pending`** |
| `transportationSubscriptions/MFsSlj2IN7rAI98k0FyK` (Julia Brito) | `active` | **`pending`** |

Renato corrected these in dev on 2026-09-23 — `active` is the true status. **Prod is still
wrong**, and because `migrate.mjs` only generates for `active` transport subscriptions, a prod
run today would skip both.

**🔴 F3 — order matters, and getting it backwards destroys data.**

Flipping Julia's status in dev **wiped her recorded absence**. `onTransportBillingSync`
recomputed the September billing record and rebuilt the line item without its saved
`excludedDates`; `['2026-09-22']` disappeared. Prod still has it, so nothing was lost for good,
and dev was repaired by hand — but the lesson is a sequencing rule for prod:

> **Migrate prod FIRST, then make status corrections.** The migration converts `excludedDates`
> into `reservationEvents`, which a billing recompute cannot touch. Correcting the status before
> migrating destroys the very history the migration exists to preserve.

Any other status corrections spotted during testing belong on this list, not in prod, until the
prod migration has run.

**F4 — prod must be untouched.** Spot-check a few `updatedAt` values against the figures above;
nothing in prod should carry a 2026-09-23 timestamp from this work.

---

## G. When it all passes

1. Update `STATUS.md` — what passed, what did not.
2. Decide the Phase 5 route. Decision 16 currently says "import dev into prod"; dev now holds a
   synthetic QA family, a test Auth account and test mutations, so read that decision's caveat
   again before acting on it.
3. `migrate.mjs` **refuses prod outright**. Enabling it is a deliberate code change, reviewed —
   not a flag added in passing.
