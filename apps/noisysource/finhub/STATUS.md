# STATUS — FinHub (Strata)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task.

**Last updated:** 2026-11-25 (FinHub MCP and setups merged; book wiped to start over; planned: Atlas uses FinHub as truth, trips)

## In progress (2026-11-27)
- **Client contracts** (branch `agent/finhub-client-contracts`), new "Client Contracts" page: a
  contract is a pot of days at a daily rate over a period (the Malt contract), with
  renegotiations (new rate, more days, later end, from a month on), monthly handovers (days ×
  rate, paid N days later), and **days off** (`daysOff`: vacations, days off and the client's
  closures, entered here: FinHub is the master of the financial calendar). The projection
  (`src/utils/clientContracts.ts`, tested) counts weekdays minus days off to the day the days
  run out, and warns N months before. Collections `clientContracts`, `contractHandovers`,
  `daysOff`, with rules; **run `pnpm test:rules:finhub` before merging**.
- Next (decided 2026-11-27): FinHub keeps only the financial calendar (days off, trips, money
  dates) and is its master; Atlas writes it to a "FinHub" Google calendar and shows a unified
  calendar of everything on its Dashboard. Then Atlas proposes the contract from its PDF and
  checks each Malt payment against its handover.

## In progress (2026-11-25)
- **What he committed is kept** (branch `agent/finhub-committed`): committing an Atlas import in
  the workbench also writes `committed` on the import (`src/utils/committed.ts`): the items he
  kept, with his edits. Atlas compares it with its proposal and learns from the differences
  (Atlas repo, "capture now" for its learning loop). Rules allow it on commit only. Run
  `pnpm test:rules:finhub` before merging (not runnable in the cloud session).

## Earlier (2026-11-24)
- **Contracts have versions** (branch `agent/finhub-contract-versions`): a contract's terms
  are a list of versions, each from a month on (`src/utils/contractVersions.ts`, tests
  `pnpm --filter finhub test`). Payroll for a month uses the version in force; the top-level
  terms mirror the latest, so old code and old contracts work unchanged (a contract without
  versions has the same terms every month). Editing asks "changes from which month" or "fix a
  mistake in the latest terms"; the Contracts tab shows the terms in force in the selected
  month and a history with Remove. Leave, bonuses and pro-rata months are not versions: they
  go on that month's payslip (Renato was on leave in January 2026, which is why January's
  payslip looked like a different contract).
- **Rules fix in the same PR:** `entityExists` / `accountExists` / `batchExists` looked under
  `users/{id}/...`, but the book is `finhub_books/{id}/...`, so every write that checks one
  (contracts, accounts, statement imports) was refused. Now `finhub_books`.
- **Rules tests not run here** (the emulator can't be downloaded in the cloud session): run
  `pnpm test:rules:finhub` before merging.
- **Next:** Atlas's year pass (`finhub_contracts`, Atlas repo) proposes each person's
  contracts with versions from all the year's payslips; the import commit merges them into
  contracts he already has (the import's months win). Then the monthly imports.
- January 2026's first import (Noisy Source) is in "From Atlas": discard it and re-run after
  the year pass.

## What this is
FinHub's new and only UI: the **Strata Treasury** app Renato generated in Google AI Studio
(repo `noisysource/Finhub`, 2026-11-23), moved here. Decisions (Renato, 2026-11-23):
- **One app.** Strata's screens replace the old FinHub UI (`apps/noisysource/finances`),
  which stays live in the KidClub projects only until this one works, then is removed.
- **FinHub has no AI.** Atlas (repo `noisysource/Atlas`) does the AI work and the reading
  (it already has Drive and Gmail): it reads the documents and **writes the data into
  Firebase**; FinHub reads and shows it. AI costs stay in one place, Atlas's costs panel.
  Atlas also uses the same data to answer money questions.
- What Atlas writes (changed 2026-11-23, once Strata's code showed it already has a review
  workbench): **one import per entity and month**, `finhub_books/{book}/atlas_imports/{id}`,
  holding drafts in the workbench's own shapes: statements with their lines categorised,
  payslips, and the contracts, subscriptions and loans Atlas found. Renato opens one in the
  workbench ("From Atlas" tab → Review in workbench), unticks what's wrong and commits; that
  commit (Strata's own `importDriveGeneratedBundle`) writes the books and marks the import
  applied. Atlas writes nothing else: not entities, not records, and can't delete. One OK in
  Atlas per import, then one commit here.
- **One shared book** for Noisy Source, the household and Noisy Phocus, not one per person.

## How it's built
- App: `apps/noisysource/finhub` (React 19, Vite 8, Tailwind 4, its own Vite config).
  Plain Google sign-in (no Gmail/Drive scopes).
- Data: `finhub_books/noisysource-group/...` in `noisysource-dev` (`FINHUB_BOOK_ID`,
  `src/firebase.ts`). Strata's model and field names are kept: the `userId` field and the
  rules' `{userId}` hold the **book id**, not a person's.
- Rules: the FinHub block at the end of `firebase/noisysource/firestore.rules`. Strata's own
  rules, plus: only that one book; written by `isFinhubUser()` (`admin@noisysource.com`,
  verified); read by them and by Atlas (`isAtlas()`). Atlas can't write yet.
- `src/lib/api.ts`: Strata's old server calls (Gemini parsing, Gmail/Drive scans, AI match
  suggestions) all answer "moved to Atlas". The buttons still exist; they get replaced by
  "what Atlas imported" as the Atlas side is built.
- Site (dev): `https://noisysource-dev-strata.web.app` (its first name, `noisysource-dev-finhub`, was deleted on 2026-11-23 by the Terraform run of #160's merge into `staging`, and Firebase never gives a deleted name back). **Not in prod yet.** No functions.

## Before Renato can test on dev (his, once)
1. After the PR's first deploy creates the site: Firebase console → `noisysource-dev` →
   Authentication → Settings → Authorised domains → add `noisysource-dev-strata.web.app`.
2. Open the site, sign in as `admin@noisysource.com`. In the first screen choose the
   **blank** start, not "Load Sample Portfolio" (that fills the book with a made-up company).
   The entities it creates are placeholders: name them as Atlas will (e.g. "Noisy Source"),
   and add the bank accounts, before opening an import (the workbench needs an entity and an
   account).
3. **Atlas needs its own user in `noisysource-dev`** for FinHub (its house user is in
   `noisysource-prod`): `./apps/noisysource/domotics-bridge/deploy/create-agent-user.sh
   noisysource-dev atlas@kidclub.pt`, then in Atlas `npm run finhub:connect` (Atlas repo). When
   FinHub reaches prod, Atlas's FinHub user moves to `noisysource-prod`.

## Next steps (agreed order, 2026-11-23)
1. ✅ #171: Strata in the monorepo on `noisysource-dev`, no AI, shared book, Atlas reads.
   ✅ Atlas imports inbox: rules for `atlas_imports`, the "From Atlas" tab, the hand-off to the
   workbench and "applied" on commit.
2. **Atlas import** (repo `noisysource/Atlas`): `finhub_inventory` and `finhub_import`, which
   write the imports above. Atlas reads PDFs as text; scans/JPEGs (car invoice, IMT) need image
   reading added to it. Invoices as documents (the Invoice Vault) aren't in an import yet:
   their lines arrive through the statements.
3. Confirming in FinHub; the forecast counts confirmed items (provisional ones shown apart).
   Then decide how the v2 engine (`packages/shared/finhub`, cent-exact matching) sits
   behind these screens.
4. Personal (Renato & Marisa: add her to `isFinhubUser()`) and Noisy Phocus (KidClub
   billing, read-only cross-project).
5. Prod: `noisysource-prod-finhub` in `env/prod.tfvars`, its `.firebaserc` target,
   `.env.nsprod`, the app in `deploy-noisysource-prod.yml`, its authorised domain.

## FinHub MCP and setups (2026-11-25, branch `agent/finhub-mcp`)
- `mcp/finhub`: Claude Code reads the book and proposes (`finhub_read`, `finhub_get`,
  `finhub_propose`); proposals land in "From Atlas", marked "by Claude Code".
- An import can carry a **setup** (entities, accounts with a dated balance, loans): the card
  lists them and **Create these** makes the missing ones, then marks it applied. IBANs are never
  in a proposal: add them in Accounts.
- The AI Studio banner "Create Noisysource & Import 6 Payslips" is gone (it created the wrong
  company, "NOISYSOURCE - LDA", with sample payslips).
- 2026-11-25: the book was wiped (Reset Workspace) to start over from Atlas's proposals.

## Planned (agreed 2026-11-24, after the contracts and month imports are settled)

Each is its own session and its own PR(s); put them on the kanban (FinHub board) when one starts.

1. **FinHub is the source of truth for Atlas.** Before the year pass or a month import,
   Atlas reads the contracts already saved in the book and gives them to the extraction as
   known facts; it proposes only what the payslips change. Merging flips: what Renato saved
   wins over an import's version for the same month (today the import wins,
   `mergeVersions` in `src/utils/contractVersions.ts`). So a correction made once in FinHub
   (14 payments, per-diem rate, part-time hours) sticks, with no need to repeat it to Atlas.
2. **Trips.** Per diems (ajudas de custo) are a fixed daily rate per person (Renato:
   €175.42/day, from the Sep/Oct 2026 payslips: 3 and 4 days) times the days of a trip.
   - The rate becomes a contract term (a version field, like the meal allowance).
   - A trip in the book: who, entity, where, from–to, purpose, calendar event, expected
     flight + hotel + per diem (days × rate), status planned → booked → paid → reconciled.
   - The forecast shows flight/hotel when booked and the per diem in the next salary.
   - Atlas plans it ("plan a trip to Brussels for Renato, 3–6 Dec": calendar event + a trip
     draft for his OK) and reconciles it afterwards (invoices from Gmail, the payslip's
     per-diem line, the bank lines): planned vs real per trip.
   - Rules: Atlas would need to propose trips (like `atlas_imports`, pending until his OK).
3. **A FinHub MCP**: built 2026-11-25 (#178), see "FinHub MCP and setups" above. Decided
   (Renato, 2026-11-24): agents read and write, but every write is a proposal, and the final
   approval is always his, in FinHub.

Facts learnt on the way (2026-11-24): every Noisy Source contract is 14 payments; only
Bernardo gets a separate holiday-subsidy slip (`…_M06P2_…`, a second run); Marisa and
Bernardo are part-time (20h/week); Renato has a meal card (€10.20/day) and a €420 child
voucher; Renato was on leave in January 2026.

## Risky / in flight
- This PR changes `pnpm-lock.yaml` peer entries for other packages (Tailwind 4 brings
  `lightningcss`/`jiti@2`), root `package.json` and `.github/`, so its dev deploy is
  **everything** in both units (the other apps get `staging`'s code).
- Merging changes the rules in `noisysource-prod` too (one rules file): the FinHub block is
  added beside Domotics', nothing of Domotics changes.
- The FinHub rules test (`pnpm test:rules:finhub`) ran on 2026-11-23 with `staging` (#160,
  #168) merged in: it passes, and so do `test:rules:tasks` and `test:rules:domotics` on the
  same rules file (the FinHub block sits after the Tasks and Atlas-gate blocks).
- The original repo `noisysource/Finhub` still has two real payslips in its history
  (`public/assets/aistudio/`). Archive or delete it now that the code lives here.
