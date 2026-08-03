# Side Notes — Things to Fix When the Time Is Right

Running list of issues spotted in the wild. Pick up as tasks as we go.

---

## KidClub

- **School year field unnecessary** — When subscribing to KidClub services or adding children, the school year field is shown but it's not needed. Remove it from the child registration and subscription forms.

## Developer Experience

- **Dev deploys must use `build:staging`** — Both KidClub and FinHub have `.env.production` pointing to `rainbow-prod-2454b`. Running plain `npm run build` embeds the prod Firebase config, which breaks auth on `kidclub-dev` hosting (login loop / unauthorized domain). Always use `npm run build:staging` for dev deploys. Long-term fix: the CI/CD pipeline should enforce this.
- **Reduce CLI login friction** — Always on the same machine. Find a way to whitelist it or set up machine-to-machine auth so we don't have to re-authenticate for GCP/Firebase CLI all the time (gcloud auth, firebase login, etc.).
- **Two hosting websites per app in Firebase Console** — Each app appears twice (one `*.web.app` and one `*.firebaseapp.com`). Should only be one. Investigate whether the extra default site can be removed or if this is a Firebase artefact.
- **CI/CD pipeline** — Set up a commit → check → deploy pipeline. Automate builds and deploys on push so we're never deploying stale or wrong-mode builds manually.
- **Cost of dev deploys** — Check if deploying to Firebase Hosting dev environment has any meaningful cost. If deploying is cheap/free, keep current flow. If not, shift to local dev with Firebase emulators as the primary test environment and only deploy to dev for milestone checks.

## Vendus / Billing

- **Invoices created as FT instead of FR** — Some invoices in Vendus are of type "FT" (fatura simplificada) instead of "FR" (fatura-recibo). Spotted during testing; unclear if these are old test entries or a current bug. Investigate whether the invoice type is being set correctly in the billing flow and whether these should be voided or corrected.
- **Vendus sandbox environment** — Vendus has a sandbox/test environment. Wire it up so that dev/staging builds use the Vendus sandbox instead of live, preventing test data from polluting production invoices.
- **EasyPay sandbox environment** — EasyPay also has a sandbox. Same as above — dev/staging should point to EasyPay sandbox so test payments don't hit real money flows. Both sandbox integrations should be driven by env vars already in `.env.staging`.
- **Vendus Pay** — Vendus offers its own payment solution ("Vendus Pay"). Investigate whether it covers the same use cases as EasyPay (MB Way, reference payments, etc.) and whether consolidating to a single vendor (Vendus for invoicing + payments) makes more sense than maintaining two integrations.
