# HANDOFF — Real data for FinHub (KidClub billing on dev, seed file, importer)

> Written 2026-10-12 for the agent doing this and for Renato. Facts were checked on `staging`
> that day; re-check the code before relying on them. No real values in this file: those are in
> `prodata/` (gitignored, main checkout only).

## Goal

FinHub has **no real data anywhere** yet (dev holds a partial draft, prod nothing). Before the
release (`staging` → `main`), FinHub must run on **dev** with real numbers that Renato has
checked. Then release, and load the same data into prod.

1. **Copy KidClub's prod billing into dev**, pseudonymised, so FinHub's KidClub page, EasyPay
   commission, Custos do mês and Previsão run on real volume without touching prod.
2. **Build one seed file** with all FinHub data, `prodata/finhub-seed.json` (never committed),
   from the dev export, the documents Renato puts in `prodata/`, and his answers.
3. **Build an importer in FinHub** (Dev Tools → "Importar seed").
4. **On dev:** wipe FinHub's data, import the seed, import bank statements; Renato checks.
5. **Release** (RELEASE-TEST-PLAN.md §4). Renato then imports the seed on prod himself.

## Read first

- Root `CLAUDE.md`: "Cost & Production Safety" and "Agent Workflow".
- `apps/noisysource/finances/STATUS.md`.
- `prodata/finhub-data-review.md` (**local only**): what dev already has, **5 conflicts** between
  dev and the hard-coded setup that only Renato can resolve, and the list of gaps.
- `prodata/finhub-dev-export.json` (**local only**): read-only export of dev's FinHub data,
  2026-10-12.
- `RELEASE-TEST-PLAN.md` §3, §5, §6, and `packages/shared/HANDOFF-vat-convention.md` §3:
  recurring amounts are **VAT-inclusive with a VAT code** (`packages/shared/lib/vat.ts`).

## Rules for this work

- **Real values stay in `prodata/`.** Names, salaries, IBANs, NIFs, balances, payslips and
  statements never go into a commit, PR, STATUS.md or test fixture. Fixtures use made-up values.
- **Never write to prod.** Prod is read only in step 1, through `.claude/skills/prod-data-check`
  and an entry in Renato's own `.claude/settings.local.json` for that session, removed after.
- **Writes go to `kidclub-dev` only.** Any script that writes must refuse every other project id.
- **Ask, don't guess.** Ask Renato in small batches, starting with the 5 conflicts. Anything
  still unknown stays `"TODO"` in the seed, and the importer refuses that record.
- **Code** goes in a worktree off `staging`, PR into `staging`. A PR into `staging` deploys
  KidClub and FinHub to dev automatically (#88).

## Step 1 — KidClub prod billing → dev

**What FinHub reads from KidClub** (checked 2026-10-12): only `_apps/arcoiris/billing`, through
`api.kidclub.listBilling()` / `monthlyProcessedVolumeCents()` (KidClub revenue page, EasyPay
volume, forecast). The IVA page's `getKidclubVatSummary` reads Vendus directly, not Firestore.
Re-check with `git grep -n arcoiris -- apps/noisysource/finances/src packages/shared` first.

- **Scope:** billing only, unless Renato asks for more. Dev's KidClub admin (Cobranças) will list
  the copied bills too.
- **Pseudonymise** personal fields before writing: at least `billingName` and `billingEmail`;
  inspect a few prod docs first, list every personal field you find (child names in lines,
  multibanco references, etc.) and agree the list with Renato. Keep amounts, dates, statuses
  and line types exact; map `familyId` consistently (same family → same pseudonym).
- **Side effects on dev:** no Firestore trigger listens on `_apps/arcoiris/billing` (KidClub's
  billing triggers fire on `studyroom`, `transportationSubscriptions` and `reservationEvents`;
  the only billing-related scheduler is `createCampBalanceBillings`, which reads camps). Re-check
  in `functions/src`. Don't use payment or invoice actions on copied bills in dev's admin
  (EasyPay is the sandbox there and Vendus is blocked, but it's noise).
- **Dev's own test bills stay.** Check copied ids don't collide with existing dev ids.
- **Script:** read prod, write dev. Dry run first (counts and totals per month and status), then
  write. Repeatable: keep prod ids and tag each copy (e.g. `_copiedFromProd: "<date>"`), so a
  refresh is one command and only touches copies. Commit the script, not its output.
  Practical notes: Firestore REST with a user token from `gcloud auth print-access-token` needs
  the header `x-goog-user-project: <project>`; in zsh write `"${B}/x/${e}:listCollectionIds"`
  (a bare `$e:l…` is a zsh modifier).
- **Check:** FinHub dev → NoisyPhocus → KidClub, monthly totals vs prod KidClub Cobranças.

## Step 2 — the seed file

- **Format:** JSON grouped by entity (`private`, `noisysource`, `noisyphocus`) plus global
  `finances_people` / `finances_companies`. Each record has a readable key (e.g. `private-bpi`)
  that becomes its Firestore id; references use keys. Dates ISO. Recurring entries carry a
  `vatCode`.
- **In code:** a schema (zod is already a `@shared` dependency) and a committed
  `finhub-seed.example.json` with made-up values.
- **Seeded:** people, companies, accounts (incl. vouchers), categories, employmentContracts,
  incomeSources, ecContracts, creditContracts, loans, insurances, recurring, irsConfig.
  **Not seeded:** bankTransactions (import statements on Contas instead, which also sets
  balances), payrollRuns, costSummary (computed), financeEvents/forecastEvents, the vault.
- **Draft** from the dev export + Renato's answers + documents in `prodata/` (payslips,
  statements, contracts, insurance policies, invoices). Write where each value came from in
  `prodata/finhub-seed-sources.md` so Renato can check it.

## Step 3 — the importer

- FinHub Dev Tools → **"Importar seed"**: pick the file → validate (schema, `TODO`s, keys that
  point nowhere: listed as errors) → **preview** per entity (create / update / unchanged) →
  Import.
- Writes **through the api domains**, including the syncs (`src/lib/contractSync.ts`, the
  insurance sync in `InsurancesPage.tsx`), so derived recurring entries are created exactly as
  the UI creates them. Deterministic ids via `upsertWithId` (`src/lib/api/domains/base.ts`):
  re-importing updates, never duplicates.
- Runs as the logged-in user under the Firestore rules; the same screen works on dev and prod.
- **Remove** `createInitialSetup()` in `src/pages/admin/DevtoolsPage.tsx` (duplicates on every
  run, real salaries in code) and the old backup export/import (`src/lib/api/domains/backups.ts`:
  it targets the pre-migration `orgs/{orgId}` model and KidClub's root collections).
- Tests (`pnpm --filter finances test`): schema, key resolution, preview diff.

## Step 4 — on dev

- With Renato's OK: wipe FinHub's dev data (Dev Tools → wipe), import the seed, import each
  account's statements on Contas.
- Renato checks with RELEASE-TEST-PLAN §3 and §6, plus a "seed" scenario you add to §6
  (every entity's pages show the seeded data; re-importing changes nothing).

## Step 5 — release

- RELEASE-TEST-PLAN §4: the `staging` → `main` PR deploys KidClub + FinHub to prod; smoke test;
  merge.
- Renato imports `prodata/finhub-seed.json` on prod through Dev Tools. Nothing from step 1 goes
  to prod (prod has the real billing already).
