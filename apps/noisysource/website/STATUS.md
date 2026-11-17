# Website (noisysource.com) — STATUS

NoisySource's public website. A single page whose intro builds the logo:
void → photons pass by → two collide (flash) → the burst collapses into **noisy** (white
photons that keep shimmering) → **source** slides in (solid blue) → a photon wave crosses the
name (white and wavy over noisy, straight and blue over source) → the dot of the i lights up →
the horizon draws (clean, then scattering) → the tagline is typed like a person would, typo
included: `for (const i of intelligence) combine(human, artificial);`. Click to replay.

## Brand (decided with Renato, 2026-11-17)
- Wordmark: `noisy` made of white photons (the noise), `source` solid signal blue, the i's dot
  is a blue light (the idea). Lettering: Oxanium 500 ("machine", sober). Code: JetBrains Mono.
- Story: from noise (chaos, photons) comes the idea; human + artificial intelligence combined.
- Palette: void `#03040a`, ice `#e8eefc`, signal blue `#4a7bff`, light `#cfe0ff`.
- Tagline: `for (const i of intelligence) combine(human, artificial);` (human white,
  artificial blue, the `i` pulses with the logo's light). Valid syntax; `combine` etc. are
  assumed declared, like any code excerpt.
- Icon / favicon: the light alone (blue dot with its glow), `public/favicon.svg`.
- No contact details on the page (email and location removed on purpose, 2026-11-17).

## Atlas, hidden in plain sight (Renato, 2026-11-17)
The page teases Atlas (Renato's assistant, repo `noisysource/Atlas`) without announcing it:
- **The sky**: real constellations sit among the stars (Orion, Cassiopeia, Ursa Major, Lyra,
  Cygnus, Crux). Hovering one draws its lines and names it; clicking does nothing. The odd one
  out is the Pleiades: its label reads **atlas**, which isn't a constellation (it's one of the
  Pleiades' stars). Clicking that one wakes Atlas. Shapes and positions: `SKY` in `intro.js`.
- **combine()'s signature**: hovering `combine` in the tagline shows
  `function combine(human: Natural, artificial: Synthetic): Atlas` (`typewriter.js`).
- **Typing `atlas`** anywhere wakes it too (queued if the tagline is still typing).
- **Waking it**: the light in the i flares, and the tagline is erased and retyped as
  `const atlas = combine(human, artificial);  // not yet.`, then restored.
- **Browser console**: the tagline plus "you looked closer. so does it. try typing its name."
- Rejected along the way: brain-as-logo, coral/blue human-vs-AI S monogram, code brackets.

## How it's built
- Vite, plain JS + CSS. Only dependencies: the two fonts, self-hosted via `@fontsource/*`
  (no Google Fonts request). No Firebase SDK yet, so it has no `.env.<mode>` files and the CI
  build skips the `projectId` check (`"firebase": false` in the workflows' `apps` entry).
- `src/intro.js`: the whole scene on a 2D canvas. Timeline `T` at the top. The letters of
  "noisy" are sampled from the real glyphs, so the photons land on the lettering at any size.
- `src/typewriter.js`: the tagline tokens/colours and the human typing (with the typo).
- `index.html` + `src/style.css`: tagline styling, flash, glow, grain, corner labels.
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
- PR #160 into `staging`, **kept as a draft on purpose: Renato isn't ready to launch.** Merging
  it releases to `noisysource-prod` (and creates the noisysource.com custom domain). Pushes to
  the branch only update the dev preview: https://noisysource-dev-website.web.app
- Last done: intro rebuilt around the new logo (brain removed).

## Next step
1. After the merge into `staging` (prod Terraform creates the custom domain): read the DNS
   records to add with
   `terraform output custom_domain_dns_records` (prod state), or Firebase console → Hosting →
   `noisysource-prod-website` → Custom domains. Add them at noisysource.com's DNS provider.
   **Don't touch the MX / Google Workspace records** — only add the A/TXT (and the `www`
   CNAME/A) records Firebase asks for. The SSL certificate is issued automatically after
   verification (minutes to a few hours).
2. Final logo kit (custom-drawn letters instead of Oxanium, still/animated, icon, light/dark,
   favicon sizes) once Renato signs off on the direction.
3. Features Renato wants to add next (to be defined).

## Open questions for Renato
- Contact email on the page is `hello@noisysource.com`: does that mailbox (or alias) exist?
