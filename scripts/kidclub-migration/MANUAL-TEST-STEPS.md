# Manual test steps — Phase 4, click by click

**Site:** https://kidclub-dev-arcoiris.web.app  (dev — never prod)
**Date these steps were written:** 2026-09-23. They assume "today" is on or near that date,
because the parent screens only show **the next 4 weeks**.

**Logins**
| Role | Account |
|---|---|
| Parent | `parent-test@kidclub.pt` — password from the seed step; reset in the Firebase console if lost |
| Admin | `admin@kidclub.pt` |

Use a **private/incognito window** for the parent, and a normal window for admin. Otherwise you
will spend the afternoon logging in and out.

**Reset the test data at any point:**
```bash
cd scripts/kidclub-migration
node set-test-absences.mjs --reset --apply
node set-test-absences.mjs --period 2026-10 --apply
```

Fill in the last column as you go. Anything that does not match goes in `STATUS.md`.

---

## Part 1 — Parent can record an absence (the core of the rewrite)

| # | Where | Do | Expect | ✓ / ✗ |
|---|---|---|---|---|
| 1.1 | Incognito → `/login` | Log in as `parent-test@kidclub.pt` | Lands on the client area, no "não autorizado" | |
| 1.2 | `/client/subscriptions` | Look at the list | Grouped **by child** (the page loads them through the family, not by email): **Ana** transporte + estudo, **Bruno** transporte + estudo, **Carla** transporte. No other family's children | |
| 1.3 | `/client/transport/TEST-SUB-TR-ANA` | Open Ana's transport | Section listing trips for the **próximas 4 semanas**, grouped by day, each with a red **"Cancelar"** button | |
| 1.4 | same | Pick a day **in October**, click **"Cancelar"** on one trip | Row turns grey, strikethrough, button becomes green **"Restaurar"** | |
| 1.5 | same | **Reload the page (F5)** | Still cancelled — it is a stored event, not screen state. *This is the single most important assertion in the document* | |
| 1.6 | same | Click **"Restaurar"** | Returns to green/normal | |
| 1.7 | `/client/study/TEST-SUB-ST-BRUNO` | Same on Bruno's study room | Button reads **"Cancelar dia"**; same behaviour | |
| 1.8 | Ana's transport, a **two-leg day** (Monday or Wednesday) | Cancel **only the 08:00 trip** | Only that leg cancels. The 17:00 leg stays active — they are separate occurrences | |

**1.9 — the trips with no button.** Any trip showing a disabled button with the tooltip
*"Sem ocorrência gerada para esta viagem"* means no event exists for it. On the QA family there
should be **none**. If you see one, note the date.

## Part 2 — 🔴 Authorisation boundary (the one failure that is serious)

Still logged in as the **parent**, in the same incognito window.

| # | Where | Do | Expect | ✓ / ✗ |
|---|---|---|---|---|
| 2.1 | Paste `/client/transport/XiblZZlEVZHsSLFdN5z5` | This is **Carolina Almeida's real subscription**, another family | **Refused** — error, redirect, or empty. It must **not** render her trips | |
| 2.2 | Paste `/admin/billing` | Parent tries the admin area | Redirected to `/not-authorized` or the landing page | |
| 2.3 | Paste `/admin/subscriptions` | Same | Same | |

If 2.1 shows another family's data, **stop testing and report it**. Everything else here is a
money-accuracy question; that one is a data-protection question.

## Part 3 — The ≥3 absence credit threshold

Switch to the **admin** window.

| # | Where | Do | Expect | ✓ / ✗ |
|---|---|---|---|---|
| 3.1 | `/admin/billing` | Find **Família Teste QA**, period **Outubro 2026** | Total **€246.05** | |
| 3.2 | same row | Read Ana's transport line | **€92.16**, 2 faltas, **no credit** — below the threshold | |
| 3.3 | same | Read Bruno's study line | **€22.95**, 3 faltas, credit **€13.77** — at the threshold | |
| 3.4 | Parent window → Ana's transport | Cancel **one more October trip** (making 3) | | |
| 3.5 | Admin → `/admin/billing`, reload | Ana's transport line | Credit **switches on**, amount drops below €92.16 | |
| 3.6 | Parent window → Bruno's study | **Restaurar** one of his three cancelled days (leaving 2) | | |
| 3.7 | Admin → reload | Bruno's study line | Credit **switches off**, amount returns to **€36.72** | |

The recalculation is a backend trigger — give it a few seconds and reload rather than expecting
it instantly.

## Part 4 — Discounts (the marginal model)

`/admin/subscriptions`, filter to Família Teste QA. Compare against `/admin/billing` for October.

| # | Line | Expect | ✓ / ✗ |
|---|---|---|---|
| 4.1 | Ana — **estudo** | **€48.00**, no sibling discount. She enrolled first, so she is the full-price sibling | |
| 4.2 | Bruno — **estudo** | sibling **€4.80** + manual 15% **€6.48**. Never 30% — the manual and `returningStudent` must not stack | |
| 4.3 | Ana — **transporte** | multi-trip **€4.80 only**. That is the *second* leg of each two-leg day, not every trip. If it is ~€12, the model went back to flat | |
| 4.4 | Bruno — **transporte** | multi-trip **€4.80** + sibling **€9.12** + escola **€16.42** | |
| 4.5 | Carla — **transporte** | **€17.28**, 4 faltas, credit **€17.28**. She starts 15 Oct; the pre-start days are system-cancelled and pro-rate the month (decision 8) | |

**4.6 — "Repor automático".** On any QA subscription row, toggle a discount off manually, save,
then click the reset button and confirm the dialog *"Repor os descontos automáticos de …"*.
Expect: the automatic discount comes back, the manual *"Aluno do ano anterior"* on Bruno's study
is **kept**, and the fee updates after ~1.5s (it waits for the backend trigger on purpose).

## Part 5 — Real migrated families

`/admin/billing`, **Outubro 2026**.

| # | Family | Expect | ✓ / ✗ |
|---|---|---|---|
| 5.1 | Inês Pinto (Carolina Almeida) | **€182.40** | |
| 5.2 | Miguel Melo (José Eduardo) | **€165.12** | |
| 5.3 | Andreia Lobo (Maria Manon) | **€130.56** | |
| 5.4 | Sandra Abreu (irmãos Mogo) | **€210.00** | |
| 5.5 | Regina Gomes (José Miguel Duarte) | **€113.28**, status **pendente** — restored by decision 6 | |
| 5.6 | Suzety Dossantos (Edson) | **€72.00**, status **pendente** | |
| 5.7 | Francisco + Julia Brito | Both **ativo**. Julia's **22 Setembro** shows as a falta — it was destroyed by the status change and restored by hand | |

**5.8 — Susete Luis' calendar.** Open her billing row → **"Dias sem serviço"**. The marked days
should match the pills on the row, with **no orphaned dates you cannot un-click**. That was the
original `toIsoDate()` bug (commit `eb905ed`).

**5.9 — invoiced records are frozen.** Find the September records for Susete Luis
(`A7OXOljX1W9xrEn5mhP8_2026-09`) and Inês Pinto (`lwHDLzM42YlNfiYen4GA_2026-09`). Status
**faturado**. They must not be editable or recomputed. The reconciliation report deliberately
lists them as diverging — reported, never corrected (decision 5).

## Part 6 — Do NOT press these

| Button | Why |
|---|---|
| **"🛠️ Recalcular tudo"** (`/admin/billing`) | Recomputes every family. It would mask whether the migration produced these numbers. Only after testing, deliberately |
| **"📅 Gerar ocorrências"** | Additive-only backfill. Harmless but pointless here — the migration already generated everything |

If you press either by accident, say so — the numbers above stop being evidence, and dev should
be re-migrated before conclusions are drawn.

## Part 7 — Things that look wrong and are not

- **Financial Summary shows €0** driver/electricity. The prod import overwrote dev's config.
  Re-enter €1400 / €300 in "Custos Fixos" if you want that page correct.
- **August 2027 bills a full month** with no school days, as does late July. `yearEndDate` is
  2027-07-15 and billing runs to August regardless (decisions 10 and 17).
- **Every month totals €2,892.96** across the database. Flat pricing — that is the point.
- Some families show **"(no billing record)"** for October. Expected where a record was never
  created; the migration creates events, not billing records.

---

## Part 8 — Prod checks, READ ONLY

Never write to prod. These exist to confirm prod has **not** drifted while dev was worked on.

```bash
node migrate.mjs --project rainbow-prod-2454b     # dry run; --apply is refused for prod
```

| # | Expect | ✓ / ✗ |
|---|---|---|
| 8.1 | **0 existing reservationEvents** — the prod migration has not run | |
| 8.2 | 11 orphan subs, 75 excludedDates + 13 eventModifications, 35 auto-cancelled, 5 invoiced | |
| 8.3 | 4,683 events to create, 4,780 writes total | |
| 8.4 | Francisco and Julia Brito still **`pending`** in prod — the correction is dev-only so far | |

**🔴 8.5 — the sequencing rule.** When prod is eventually migrated: **migrate first, correct
statuses afterwards.** Flipping Julia's status in dev destroyed her 22-09 absence, because the
billing recompute rebuilt the line item without its `excludedDates`. After migration those
absences live in `reservationEvents`, where a recompute cannot reach them.

---

## When you are done

1. Note pass/fail per part in `STATUS.md`.
2. If Parts 1–3 pass, the rewrite's core is proven: a parent can record an absence, cannot reach
   another family, and the credit threshold works in both directions.
3. Only then decide the Phase 5 route — and re-read decision 16's caveat first, because dev now
   contains a synthetic family and a test account that must never reach prod.
