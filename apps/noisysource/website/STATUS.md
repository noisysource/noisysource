# Website (noisysource.com) — STATUS

NoisySource's public website. A single page with an animated, looping WebGL scene:
void → photons pass by → two collide → expansion → the mind (neurons firing, building to an
overload) → explosion → void. Deliberately minimal and mysterious; the scene hints at the
agent being built without naming it.

## How it's built
- Vite, plain JS + CSS, no dependencies (the scene is hand-written WebGL in `src/cosmos.js`).
  No Firebase SDK yet, so it has no `.env.<mode>` files and the CI build skips the
  `projectId` check (`"firebase": false` in the workflows' `apps` entry).
- `src/cosmos.js`: the scene. Stages, timings (`SEQ`), colours and the firing curve
  (`fireLevel`) are at the top of the function.
- `src/typewriter.js`: the lines typed under the shape (`LINES`).
- `index.html` + `src/style.css`: the corner labels, flash, glow, grain.
- Run locally: `pnpm --filter website dev` → http://localhost:5176

## Where it runs
- Deploy unit `noisysource`, hosting target `website` (`firebase/noisysource/firebase.json`).
- Dev: site `noisysource-dev-website` (https://noisysource-dev-website.web.app). A PR into
  `staging` that touches this folder deploys its preview there.
- Prod: site `noisysource-prod-website` (https://noisysource-prod-website.web.app). A merge into
  `staging` deploys it (the NoisySource unit releases on merge into staging, not on the
  staging → main promotion).
- Custom domain: `noisysource.com` (and `www.noisysource.com` redirecting to it), declared in
  `infra/gcp/terraform/noisysource/env/prod.tfvars` → `custom_domains`. Terraform creates the
  domain on the prod site; it only goes live once the DNS records are added at the registrar
  (see "Next step").

## In progress
- First version: page moved into the monorepo, hosting + CI + Terraform wired (PR into `staging`).

## Next step
1. After the merge into `staging` (prod Terraform creates the custom domain): read the DNS
   records to add with
   `terraform output custom_domain_dns_records` (prod state), or Firebase console → Hosting →
   `noisysource-prod-website` → Custom domains. Add them at noisysource.com's DNS provider.
   **Don't touch the MX / Google Workspace records** — only add the A/TXT (and the `www`
   CNAME/A) records Firebase asks for. The SSL certificate is issued automatically after
   verification (minutes to a few hours).
2. Features Renato wants to add next (to be defined).

## Open questions for Renato
- Contact email on the page is `hello@noisysource.com`: does that mailbox (or alias) exist?
