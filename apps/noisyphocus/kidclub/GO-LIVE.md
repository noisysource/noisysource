# GO-LIVE — handoff for the prod promotion session

Written 2026-09-24, at the end of the September reconciliation session, for the
session that will plan and execute the move to prod. Read this before touching
anything; it exists so you don't have to reconstruct the reasoning.

`STATUS.md` remains the running record. This file is only about going live.

---

## 1. The rule that governs the whole migration

Renato's decision, 2026-09-24:

> **dev is the source of truth for all subscriptions. Account ids and the links
> to email — keep whatever is in prod.**

Split precisely:

| | Source of truth | Fields |
|---|---|---|
| **Subscription content** | **dev** | `days`, `schedule`, times, `weekPattern`, `status`, `monthlyPrice`, `monthlyFee`, `basePrice`, `appliedDiscounts`, `schoolName` |
| **Identity** | **prod** | `familyId`, `childId`, `userId`, `contactEmail`, `email`, contact name/phone |

This is not cosmetic. **dev and prod are separate Firebase projects**, so a
Firebase Auth uid from dev means nothing in prod. Copying a dev `userId` over a
prod one silently detaches a family from their own subscriptions — which is
exactly the failure that hid Leonor Lago's subscription from her mother for
weeks. Never write an identity field from dev.

---

## 2. State of play

**prod is untouched.** Everything below was applied to `kidclub-dev` only.

Applied to dev during the reconciliation (see STATUS.md for the full record):

- 73 time normalisations (quarter-hour rounding from the real route sheet)
- 12 structural day/leg corrections
- 3 study-room `basePrice` repairs
- 10 synthetic test records deleted
- 1 malformed address + 1 stale fee (Gil Figueiredo)
- 1 email lowercased + 1 manual child link (Leonor Lago)

Dev totals after all of it: **€2 983,20/month** — transport €2 095,20, study
€888,00, across 23 active transport and 13 active study subscriptions.

**All five PRs are merged and `staging` is deployed to dev. No PRs are open.**
`staging` HEAD is `5602c75` (#37). Merged 2026-09-24: `#39` calendar indexes,
`#38` quarter-hour picker, `#40` email normalisation, `#37` study-room pricing +
event parity, `#41` STATUS consolidation + this file. `#36` was closed,
superseded by `#41`.

**dev is clean and current — you do not need to deploy anything to start.**
Verified after the final staging deploy, at three levels rather than trusting a
green check:

| Layer | Evidence |
|---|---|
| picker (#38) | bundle contains `D2(13,19).filter(t=>t>="13:30")`, `D2(7,20)`, with `[0,15,30,45]` inside — the generated quarter-hour list |
| events (#37) | bundle contains `"confirmed","active"` ×2 |
| emails (#40) | `toLowerCase` present |
| **functions (#37)** | live behavioural test: study-room sub 1 day €24 → add a day → **€48** → revert → **€24**, record restored identically |

That last row is the one that matters — it proves the deployed Cloud Function,
not just the shipped bundle.

---

## 3. Mechanisms available

All three follow the same conventions: **dry run by default**, `--apply` to
write, prod additionally gated behind `--i-know-this-is-prod`, auth via
`gcloud auth print-access-token` (no service-account key — org policy blocks
them).

| Script | Does | Prod-ready |
|---|---|---|
| `scripts/kidclub-migration/identity.mjs` | Phase 0 identity repair: merges duplicate children, links orphan subs to families by email, backfills `childId` | yes (pre-existing) |
| `scripts/kidclub-migration/normalize-emails.mjs` | Lowercases every stored email; carries the one manual child link that no heuristic can match | yes — **applied to dev, 2 writes, re-run reports 0** |
| `scripts/kidclub-migration/promote-subscriptions.mjs` | **The promotion itself.** Diffs dev against prod and carries dev's *content* across while preserving prod's *identity* | yes — **never run against prod yet** |

`promote-subscriptions.mjs` enforces §1 structurally: it has an explicit
`CONTENT_FIELDS` allow-list and an `IDENTITY_FIELDS` deny-list, and strips
identity fields again immediately before writing. Self-tested dev→dev as a
clean no-op, which proves the diff logic rather than just the syntax.

**It reports but never performs deletions.** Dev had 10 test records removed;
whether the same ids are junk in prod is a judgement call, not something to
infer from absence. Same for docs that exist in dev but not prod — reported,
never created.

---

## 4. Not covered — decide before running anything

**The operation is running at a loss, and discounts alone cannot fix it.**
Surfaced 2026-09-24 by the new discount simulator on Resumo Financeiro. Fixed
monthly costs are **€3 400** (transport €1 850: van 500 + driver 1200 +
electricity 150; study €1 550: teacher 800 + rent 750) against revenue of
€2 983,20 — a **−€416,80/month loss, −14,0% margin**.

| Scenario | Receita | Lucro | Margem |
|---|---|---|---|
| Current | €2 983,20 | **−€416,80** | −14,0% |
| Bissaya 10% | €3 129,60 | −€270,40 | −8,6% |
| Aluno 0% + Bissaya 10% | €3 237,60 | −€162,40 | −5,0% |
| Aluno 0% + Bissaya 0% | €3 384,00 | −€16,00 | −0,5% |
| **All four discounts at 0%** | €3 600,00 | **+€200,00** | +5,6% |

Removing *every* discount only reaches +€200. So this is not a "how much margin
do we want" decision — the discount levers cannot close a €417 gap on their own.
Closing it properly means base prices, cost structure, or volume. Sanity-check
the cost inputs first: they are editable on that page, and if driver (€1 200) or
teacher (€800) are aspirational rather than actual, the picture changes.

**Two things the simulator does NOT model** (accepted, deferred by Renato
2026-09-25):

1. It prices discounts with the **current flat sum-of-percentages** logic, not
   the marginal/per-unit design recorded below. Worked example: José Miguel
   Duarte, 6 trips, gross €144, Multi-viagem 10% + Bissaya 20%. Flat gives
   144 × 0.70 = **€100,80** (what he pays today). Marginal would apply
   Multi-viagem only to the 1 trip that is a same-day second trip — he has two
   trips on Monday and one on every other day — landing near **€113**, about
   €12/month more for one child. **Decide the model before using the slider to
   pick rates**, or the rates chosen will not produce the numbers seen.
2. Costs are a fixed constant in the scenario. It can answer "what if Bissaya
   were 10%" but not "what if we dropped the van". The cost fields on the page
   are editable, but that writes real config — a change, not a simulation.

**Pricing and discounts.** Renato wants these tackled in the promotion session.
Findings that bear on it:

- `applyDiscounts` is **flat sum-of-percentages off gross**. STATUS.md records
  that the *intended* design is marginal/per-unit. Decide the discount **model**
  and the **rates** together — changing rates under the current model, then
  reworking the model, moves every number twice.
- Simulated on dev data: removing "Aluno do ano anterior" (15%, 7 subs) plus
  cutting "Escola Bissaya" 20%→10% yields **+€254,40/month (+8,5%)**, roughly
  €14,64/month per point of Bissaya. It lands on **12 of 24 families**, average
  +14,8%, three above +17%.
- "Aluno do ano anterior" is `trigger: "manual"`. Removing the rule from config
  will **not** strip it from the 7 subs already carrying it — `recalcForFamily`
  preserves manual discounts deliberately. Those need un-toggling per sub.
  "Escola Bissaya" is `auto_school` and re-derives on the next recalc.

**What a discount edit rewrites.** `autoCreateBillingSchedule` loops from the
1st of the *current* month to 1 August. Records that are `pending` (or
auto-cancelled) get rewritten; anything `paid`/`invoiced`/`processing` is frozen.
Past months are never visited **regardless of payment status** — so from 1
October an unpaid September invoice silently stops updating, with no code change
and no signal. In dev today that is **283 of 312 records rewritable**.

**Billing statuses run `pending → processing → paid → invoiced`.** `invoiced` is
terminal and means *paid* — it is set only after the Vendus document is created.
It does not mean "awaiting payment".

**Prod data is unaudited.** dev was a prod copy, so these are almost certainly
present in prod too:

- Stale fees — 4 found in dev, each surfacing only when its doc happened to be
  written. Audit query: `monthlyFee == trips × 6 × weeks − discounts`.
- Study-room `basePrice` drift. Audit query: `basePrice == 24 × days.length`.
- Gil Figueiredo's malformed Monday dropoff address and the €24/month
  overbilling that came with it.
- Mary Pratas paid **2027-08 instead of 2026-09** (€142,80, Vendus
  `FR 01P2026/195`). Terminal status, so **no migration script will fix it** —
  it needs a credit note. See the Backlog item in STATUS.md.

---

## 5. Housekeeping

- ~~`#36` is superseded.~~ DONE — `#41` merged, `#36` closed.
- **`staging` is ~10 commits ahead of `main`** and has never been promoted.
  CLAUDE.md says to branch off `main`; that is currently wrong in practice and
  produced one PR that couldn't even compute a merge ref, and another that
  patched a file `staging` had deleted. **Branch off `staging`** until main is
  caught up, or promote staging→main first.
- **Every PR deploys to the same `kidclub-dev` project**, so only the most
  recent deploy is live. Testing between merges is misleading; merge, then test
  once.
- Worktrees from the reconciliation session have been removed. `git worktree
  list` should show only the main checkout plus whatever you create. Branches
  stay on origin, so nothing was lost — but clean up after yourself too, since a
  stale worktree has already caused one credential-exposure incident here.

---

## 6. Suggested order for the next session

1. ~~Merge the five PRs.~~ Done — dev already holds `staging` (§2), verified at
   bundle and function level. Start from step 2.
2. Decide the discount model and rates (§4). Re-run the simulation afterwards —
   the numbers above assume the current flat model.
3. Dry-run `identity.mjs` against **prod**, read the report, decide what to apply.
4. Dry-run `normalize-emails.mjs` against **prod**, apply.
5. Dry-run `promote-subscriptions.mjs` against **prod**. Read every line — this
   is the one that carries the reconciliation across. Only then `--apply`.
6. Audit prod for the two stale-fee classes (§4) and fix what surfaces.
7. Deal with Mary Pratas' mis-paid period separately; it is a credit note, not a
   migration.

Prod access is opt-in per CLAUDE.md: add `firestore-prod` to your own gitignored
`.claude/settings.local.json` for the session, and remove it afterwards.
