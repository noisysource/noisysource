# STATUS — FinHub (Strata)

> Read this first when you start a session on this app. Update it before you sign off, even mid-task.

**Last updated:** 2026-11-23 (step 1: Strata in the monorepo, no AI, shared book; dev only)

## What this is
FinHub's new and only UI: the **Strata Treasury** app Renato generated in Google AI Studio
(repo `noisysource/Finhub`, 2026-11-23), moved here. Decisions (Renato, 2026-11-23):
- **One app.** Strata's screens replace the old FinHub UI (`apps/noisysource/finances`),
  which stays live in the KidClub projects only until this one works, then is removed.
- **FinHub has no AI.** Atlas (repo `noisysource/Atlas`) does the AI work and the reading
  (it already has Drive and Gmail): it reads the documents and **writes the data into
  Firebase**; FinHub reads and shows it. AI costs stay in one place, Atlas's costs panel.
  Atlas also uses the same data to answer money questions.
- What Atlas writes: **facts** from documents (payslips, bank lines, invoices) as data, each
  with its source Drive file and an id derived from it (re-reading never duplicates); and
  what it **infers** (contracts, salaries, the loan, recurring expenses) as real records
  marked "to confirm", which Renato confirms in FinHub. Atlas can't delete, and can't change
  what he confirmed or reconciled (rules, not trust). One OK per import batch in Atlas.
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
   The entities it creates are placeholders until the Atlas import.

## Next steps (agreed order, 2026-11-23)
1. ✅ This PR: Strata in the monorepo on `noisysource-dev`, no AI, shared book, Atlas reads.
2. **Atlas import** (repo `noisysource/Atlas`): read a month folder of the Noisy Source Drive
   `2026` folder (Jan–Sep subfolders, plus Tesla invoices), extract, write the facts, propose
   the plan items "to confirm", one OK per batch. Here: the "to confirm" fields on the
   collections it writes, and the rules that let Atlas write them with the limits above.
   Atlas reads PDFs as text; scans/JPEGs (car invoice, IMT) need image reading added to it.
3. Confirming in FinHub; the forecast counts confirmed items (provisional ones shown apart).
   Then decide how the v2 engine (`packages/shared/finhub`, cent-exact matching) sits
   behind these screens.
4. Personal (Renato & Marisa: add her to `isFinhubUser()`) and Noisy Phocus (KidClub
   billing, read-only cross-project).
5. Prod: `noisysource-prod-finhub` in `env/prod.tfvars`, its `.firebaserc` target,
   `.env.nsprod`, the app in `deploy-noisysource-prod.yml`, its authorised domain.

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
