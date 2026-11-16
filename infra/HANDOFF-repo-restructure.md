# HANDOFF — Repo restructure to match the Google Cloud layout

**Agreed with Renato:** 2026-11-11. **Read first:** root `CLAUDE.md` (pipeline, cost and prod
safety) and `infra/gcp/HANDOFF-gcp-reorg.md` (what was done in Google Cloud on 2026-11-10).

**Progress (2026-11-16):** PRs 1–8 (#143–#150) are merged. Domotics runs on `noisysource-dev`
(pipeline, rules, five functions, site `noisysource-dev-domotics.web.app`; Renato signed in
there), with no live data until the cutover. **Step 9 is done** (#152, merged
2026-11-16): `noisysource-prod` has its rules, the five functions and the site
`noisysource-prod-domotics.web.app`, deployed on every merge into `staging`; Renato signed in
there. **Step 10, the cutover, was done on 2026-11-16** (bridge stopped 12:49, running on
`noisysource-prod` from 12:58 WET): the Pi publishes to `noisysource-prod`, the history and
settings are there (244 documents), and the Netatmo token lives only there. `kidclub-dev`
still has the old copy of everything else, frozen at 12:46, and its Domotics site and functions
are dead weight until step 11. **Next: step 11** (remove Domotics from the KidClub unit). Update this
line and the table below as PRs merge.

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
| 6 | `firebase/noisysource/`: config, Domotics-only rules, their tests | NoisySource rules | Rules tests | merged, #148. KidClub dev deployed nothing |
| 7 | NoisySource functions codebase with the five Domotics callables | NoisySource functions; **everything** on KidClub dev (`pnpm-workspace.yaml` and the lockfile change) | Callables exist; KidClub functions check | merged, #149. Five functions active in `europe-west3` as `functions-runtime@`; KidClub dev full deploy clean. Needed two Terraform additions, applied by Renato: the build account's role and the image repository |
| 8 | Domotics app: a second build mode (`nsdev`) for the new project beside the `kidclub-dev` one, hosting target, site address from the build's project. The three shared files stay in `packages/shared` until the cleanup | NoisySource hosting; Domotics hosting on KidClub dev | Renato signs in on the new site | merged, #150. Renato signed in on the new site 2026-11-16. The pipeline now copies each build into `firebase/noisysource/hosting/<target>` (firebase deploy refuses a folder outside the Firebase project folder) |
| 9 | `noisysource-prod`: Terraform apply, prod caller `deploy-noisysource-prod.yml` (deploy on merge to `staging`), Domotics build mode `nsprod` | **Everything** on both dev projects; on merge, everything on `noisysource-prod` for the first time | Prod site up, sign-in works | merged, #152. Prod run green, five functions active as `functions-runtime@`, Renato signed in on the prod site 2026-11-16 |
| 10 | Cutover, by Renato, no PR: copy `domotics_*` data, create the bridge user, switch the Pi's project and API key | — | Live data on the new site | done 2026-11-16 with the runbook below (tools in #153). Checked from the data: 244 documents copied, the bridge writes state, climate and energy to `noisysource-prod`, `domotics_config/netatmo` is gone from `kidclub-dev` |
| 11 | Remove Domotics from the KidClub unit: rules block, function exports, hosting target, `deploy_domotics` | **Everything** | Reaches prod by promotion; Renato then deletes the five old functions and the old sites | |

### Step 9, by hand (Renato) — done 2026-11-16, kept as the record of a project's first setup
The merge is the first deploy to `noisysource-prod`; it fails at sign-in to Google Cloud
until 1 and 2 are done, and at the app's build until 3 is.

1. **First Terraform apply** (creates the project's Firebase, the Firestore database in
   `europe-west3` for good, the site, the deploy and runtime accounts). From the PR's branch:
   ```bash
   gcloud services enable cloudresourcemanager.googleapis.com --project noisysource-prod
   cd infra/gcp/terraform/noisysource
   terraform init -backend-config="prefix=noisysource-prod" -reconfigure
   terraform apply -var-file=env/prod.tfvars -target=google_project_service.apis
   terraform apply -var-file=env/prod.tfvars   # expect the same resources as dev had, nothing changed or destroyed
   terraform output web_app_config
   ```
2. **Let CI reach the Terraform state:**
   ```bash
   gcloud storage buckets add-iam-policy-binding gs://kidclub-terraform-state \
     --member="serviceAccount:github-deploy@noisysource-prod.iam.gserviceaccount.com" \
     --role="roles/storage.objectAdmin"
   ```
3. **`apps/noisysource/domotics/.env.nsprod`** with the six values from `web_app_config`
   (same shape as `.env.nsdev`), committed on the PR's branch. Any session can do this from
   the output of step 1.
4. **Google sign-in:** Firebase console → `noisysource-prod` → Authentication → Sign-in
   method → Google → enable. Then Settings → Authorised domains: `noisysource-dev` lists
   its site (`noisysource-dev-domotics.web.app`) beside the project's two defaults, so check
   `noisysource-prod-domotics.web.app` is listed and add it if it isn't.
5. Merge the PR, watch "Deploy NoisySource to Prod" go green, open
   `https://noisysource-prod-domotics.web.app` and sign in. The house is empty until step 10.

### Step 10, the cutover (Renato) — runbook, run on 2026-11-16 and kept for the rollback
Do it outside the heating windows (05:30–08:00, 16:30–23:00): the bridge is stopped for a few
minutes, and with it the heating automation. Run everything from
`apps/noisysource/domotics-bridge` in a checkout of `staging`, at home (the Pi is
`pi@192.168.1.125`).

Before, at any time (changes nothing for the house):
1. **The bridge's account in the new project.** Enables email/password sign-in in
   `noisysource-prod`, creates `domotics-bridge@kidclub.pt` there with a new password, writes
   `deploy/bridge.env` (now with `GCLOUD_PROJECT=noisysource-prod`) and signs in once to prove
   it works:
   ```bash
   ./deploy/create-bridge-user.sh noisysource-prod
   ```
2. **Dry run of the copy** (reads only; expect about 8 + 20 + 22 + 194 documents):
   ```bash
   node deploy/cutover-copy.mjs --from kidclub-dev --to noisysource-prod
   ```

The cutover:

3. **Stop the bridge and keep its old credentials** on the Pi:
   ```bash
   ssh pi@192.168.1.125 'sudo systemctl stop domotics-bridge && cp -p ~/domotics-bridge/bridge.env ~/domotics-bridge/bridge.env.kidclub-dev'
   ```
4. **Copy the data.** Settings, tariff, floor plan, vendor credentials and the history
   (`domotics_config`, `_climate`, `_energy`, `_incidents`). It checks the copy, then deletes
   `domotics_config/netatmo` from `kidclub-dev`: the Netatmo token rotates, so it must live in
   one project only. From this moment the old site can't switch lights:
   ```bash
   node deploy/cutover-copy.mjs --from kidclub-dev --to noisysource-prod --write
   ```
5. **Point the Pi at the new project and start it:**
   ```bash
   scp deploy/bridge.env pi@192.168.1.125:~/domotics-bridge/bridge.env
   ssh pi@192.168.1.125 'chmod 600 ~/domotics-bridge/bridge.env && sudo systemctl start domotics-bridge && sleep 90 && journalctl -u domotics-bridge -n 40 --no-pager'
   ```
   Expect a sign-in line and 7 devices, as after any restart.
6. **Check** `https://noisysource-prod-domotics.web.app`, signed in, with the phone off the
   WiFi: thermostats and pump are live, a light switches, Energia and Clima show the history.
   From now on this is the house's address; `kidclub-dev-domotics.web.app` shows the state
   frozen at the cutover.
7. Keep the new `deploy/bridge.env` (it's the only copy on the Mac of the new password; the
   script keeps it across re-runs). If it was created in a worktree, move it to the main
   checkout's `apps/noisysource/domotics-bridge/deploy/` before removing the worktree.

Rollback, if step 5 or 6 fails:
```bash
ssh pi@192.168.1.125 'cp -p ~/domotics-bridge/bridge.env.kidclub-dev ~/domotics-bridge/bridge.env && sudo systemctl restart domotics-bridge'
node deploy/cutover-copy.mjs --from noisysource-prod --to kidclub-dev --only domotics_config/netatmo --write
```
That puts the bridge and the Netatmo token back in `kidclub-dev`. What the bridge recorded in
`noisysource-prod` in between stays there.

The systemd unit in the repo now defaults to `noisysource-prod` too, but the one installed on
the Pi doesn't need replacing: `bridge.env` carries the project and wins over the unit.

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
