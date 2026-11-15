# HANDOFF — Repo restructure to match the Google Cloud layout

**Agreed with Renato:** 2026-11-11. **Read first:** root `CLAUDE.md` (pipeline, cost and prod
safety) and `infra/gcp/HANDOFF-gcp-reorg.md` (what was done in Google Cloud on 2026-11-10).

**Progress (2026-11-15):** PRs 1–5 (#143–#147) are merged; `noisysource-dev` exists and its
pipeline runs. PR 6 is open; PRs 7 and 8 are written (branches `agent/ns-functions`,
`agent/ns-domotics`, stacked on it). Update this line and the
table below as PRs merge.

## Why
Google Cloud has one folder per company: Noisy Phocus holds KidClub's projects (`kidclub-dev`,
`rainbow-prod-2454b`), NoisySource holds `noisysource-dev` / `noisysource-prod` (the future
home of FinHub, Domotics and Tasks). The repo still models the old world: every app deploys
into the KidClub projects through one `firebase.json`, one `firestore.rules`, one functions
codebase, one Terraform root and one KidClub-named pipeline.

## Decided
- **One repo.** The deploy units split along the two project pairs, not the repo.
- **Build the new pair beside the old.** KidClub's files don't move until the final cleanup.
  The NoisySource unit is built new; each app is removed from the KidClub unit only once it
  runs in its new home.
- **Nothing changes what deploys to `rainbow-prod-2454b`** except through the normal
  `staging` → `main` promotion.
- **Layout:** `firebase/<pair>/` is a complete Firebase project directory: `firebase.json`,
  `.firebaserc`, Firestore rules and indexes, and its `functions/`. `firebase/noisysource/`
  is created first; `firebase/kidclub/` gets the same shape at cleanup. Apps stay under
  `apps/<company>/`.
- **Functions:** the NoisySource codebase is bundled with esbuild from its first day, so it
  can import shared code and needs no hand-mirrored copies. KidClub's codebase stays on plain
  `tsc` for now.
- **Terraform:** a new `noisysource` root with fresh state (same bucket, prefixes
  `noisysource-dev` / `noisysource-prod`), first applied by Renato, then by CI on both
  environments. It must not own functions' runtime settings (`firebase deploy` sets those;
  see the 2026-11-10 incident in the GCP handoff). The org root (folders, billing, budget
  cutoff, WIF, state bucket) and KidClub prod's state reconciliation are state surgery, so
  they wait for cleanup and are their own explicit steps.
- **CI:** a new generic `_deploy-env.yml`, used only by the NoisySource pair at first.
  KidClub moves onto it at cleanup, once it is proven.
- **Lighter path for the private tools:** a PR into `staging` previews on `noisysource-dev`;
  merging into `staging` deploys to `noisysource-prod`. The `staging` → `main` promotion then
  deploys KidClub only. A merge is therefore a release, FinHub's rules included.
- **The Domotics bridge's live data goes to `noisysource-prod`**, in one cutover straight
  from `kidclub-dev`. Dev keeps the app's `?demo` mode.
- **Firestore in `noisysource-*`:** `europe-west3`, single region, both projects. It can't be
  changed after creation.
- **Domotics keeps its two identities** (`admin@kidclub.pt` as owner,
  `domotics-bridge@kidclub.pt` as the bridge) in the new project's rules.
- **FinHub is rebuilt as a whole** (v2) directly in the NoisySource unit. Don't preserve its
  current structure; don't break what's deployed until the replacement exists.
- **`packages/shared`** shrinks to what both companies use (money, VAT, dates, login). Domain
  models move to the app that owns them. Cross-company types (`CostSummary`, the billing read
  shape) get a small contracts package when the first cross-project read is built.

## Facts that shape the order (checked 2026-11-11)
- `noisysource-dev` and `noisysource-prod` have no Firebase and no Firestore API yet.
- `deploy-parts.mjs` deploys **everything** for a path no rule knows, so CI must learn the new
  directories before they appear (PR 3 comes before PR 4 and PR 6).
- On dev, a change to `.github/`, root `package.json`, `firebase.json`, `.firebaserc` or root
  config deploys every part, Terraform included. After each such PR, check that the dev
  functions kept their secrets, service account and max instances.
- `functions` builds with `tsc`; `functions/build.cjs` is unused. Only test files import
  `packages/shared` (by relative path).
- Domotics uses three shared files (`models/Room`, `models/Device`, `lib/energyBill`), five
  callables and no Secret Manager secrets. Vendor credentials are in `domotics_config/*`.
- **The Netatmo refresh token rotates** (`functions/src/domotics/legrand.ts`). Copying
  `domotics_config/netatmo` to another project while the first still runs breaks one of the
  two, so that copy happens at the cutover and not before.
- The Domotics app hardcodes `kidclub-dev-domotics.web.app` in five places.
- Renato runs IAM grants and secret writes himself; give him the exact command.

## PR sequence
One worktree and one branch off `staging` per PR, PR into `staging`.

| # | PR | Deploys on dev | Check after | Status |
|---|---|---|---|---|
| 1 | Docs: this file; root and infra `CLAUDE.md` fixes | Nothing | — | merged, #143 |
| 2 | Leftovers: add `test:rules:client-events`; drop `rainbow-78314` from `.firebaserc`; delete `env/dev.tfvars` and `functions/build.cjs`; remove the root `deploy*` scripts; drop the prod domotics site from `prod.tfvars` and fix its database comment | **Everything, Terraform included** | Dev functions' secrets, service account, max instances (tests #140's fix) | merged, #144. Full deploy clean: Terraform 0 changes, all 76 dev functions unchanged |
| 3 | `deploy-parts.mjs` learns deploy units and the new paths (`--unit kidclub` by default, `--unit noisysource`; the table is `UNITS` in the script) | **Everything** | Same functions check | merged, #145. Full deploy clean again |
| 4 | Terraform `noisysource` root (`infra/gcp/terraform/noisysource/`); Renato applies it to `noisysource-dev` | Nothing | Plan output before the apply (35 to add, nothing else) | applied to `noisysource-dev` 2026-11-15, #146 |
| 5 | Generic `_deploy-env.yml` and a `noisysource-dev` caller | **Everything** on KidClub dev; first run on `noisysource-dev` | Functions check; new run green | merged, #147. `noisysource-dev` Terraform applied by CI with 0 changes; KidClub dev full deploy clean |
| 6 | `firebase/noisysource/`: config, Domotics-only rules, their tests | NoisySource rules | Rules tests | open |
| 7 | NoisySource functions codebase with the five Domotics callables | NoisySource functions | Callables exist | |
| 8 | Domotics app: shared files move in, env points at the new project, site URL from env | NoisySource hosting | Renato signs in on the new site | |
| 9 | `noisysource-prod`: Terraform apply, prod caller (deploy on merge to `staging`) | **Everything** | Prod site up, sign-in works | |
| 10 | Cutover, by Renato, no PR: copy `domotics_*` data, create the bridge user, switch the Pi's project and API key | — | Live data on the new site | |
| 11 | Remove Domotics from the KidClub unit: rules block, function exports, hosting target, `deploy_domotics` | **Everything** | Reaches prod by promotion; Renato then deletes the five old functions and the old sites | |

Cutover notes (step 10): do it outside the heating windows (05:30–08:00, 16:30–23:00).
Rollback is the Pi's env file plus copying `domotics_config/netatmo` back, since the token
will have rotated.

## After Domotics
1. **FinHub v2** in the NoisySource unit, with the contracts package and the cross-project
   read grants (a FinHub function service account with `roles/datastore.viewer` on the KidClub
   project, and the reverse for `costSummary`). Old FinHub stays in the KidClub projects until
   v2 replaces it, then leaves the KidClub unit the way Domotics did. Update the Cross-App
   Data Contracts in root `CLAUDE.md` then.
2. **`packages/shared` shrinks** as each owner takes its models (KidClub's in KidClub-only PRs).
3. **Cleanup:** KidClub's files into `firebase/kidclub/` (one PR, full deploy); KidClub onto
   the generic workflow; the org Terraform root; KidClub prod state reconciliation
   (`infra/gcp/terraform/HANDOFF-terraform-cleanup.md`, task 5).

## Still open
- **`virtual-hybrid-43xkp`:** doesn't block anything. Renato finds which Google account owns
  billing `01914B-C628E5-7B7AC1`; shut the project down if it shows no spend.
- **Functions source inside `firebase/<pair>/`** was chosen so the Firebase CLI never has to
  accept a source outside its project directory. Hosting `public` paths still point out to
  `apps/`; confirm that works in PR 6, on `noisysource-dev`, where nothing can break.
