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
  Cygnus, Crux, the Pleiades). Hovering one draws its lines and names it. **Inside the
  Pleiades, one single star is Atlas**: only with the pointer exactly on it does it name itself,
  and only clicking that star wakes Atlas. **Any other click deletes the tagline and types it
  again** (a hint that you're looking in the wrong place). Shapes: `SKY` in `intro.js`.
- **combine()'s signature**: hovering `combine` in the tagline shows
  `function combine(human: Natural, artificial: Synthetic): Atlas` (`typewriter.js`).
- **Typing `atlas`** anywhere wakes it too (queued if the tagline is still typing).
- **Waking it**: the light in the i flares, and the tagline is erased and retyped as
  `const atlas = combine(human, artificial);` / `atlas.wake();` followed by a faint `>`. Stray
  clicks no longer change it once it's awake.
- **The `>`** opens the Atlas session (`src/terminal.js`): boot sequence, then (enigmatic on purpose, Renato 2026-11-17)
  "something stirs. / you were not meant to find this. few do. / four breaths. spend them well.
  the unknown keeps what it is given.", a notice that the conversation is kept, and "who wakes
  what sleeps, and what do they seek in the noise?". From there it's a real model, through
  `/api/atlas`, speaking in fragments and riddles (voice in `systemPrompt`, atlasGateLogic.ts;
  the opening lives in both `OPENING` there and `terminal.js`, keep them identical).
- **The gate** (`atlasGate`, `firebase/noisysource/functions/src/website/`): Gemini on a
  free-tier key, steered to find out **who** woke Atlas (recruiter / investor / manager /
  colleague / curious / other) and **why**. 4 replies per visitor, then Atlas sleeps; on the
  last ones it hints to "ask the real Renato for the phrase". **The phrase opens the door**:
  checked in code, never by the model; then 20 more replies and Atlas may share what's in
  `profile`. **Humankind isn't ready (Renato, 2026-11-17):** one shared limit for the whole
  web, 49 messages (7 × 7), then Atlas goes quiet for **7 hours** ("one for each sister": Atlas
  is the father of the Pleiades, the cluster hiding him in the sky). Nothing is tracked per
  person: no IPs, no user agents. Plus 12 s timeout, no retries, maxInstances 3. Every
  awakening is saved in `atlas_awakenings/{session}` (who, why, how it was found, referrer,
  transcript with the phrase redacted, `seen: false`) for Renato's Atlas to report. Without a server (the claude.ai preview) the terminal falls back to
  short "not yet" lines.
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

## One-time setup for the gate (Renato, by hand — nothing secret goes in the repo)
For each project (`noisysource-dev` first, then `noisysource-prod`), Firestore console → create
the document **`atlas_gate/config`** with:
- `geminiApiKey` (string): an API key from Google AI Studio, created in a project **without
  billing** (e.g. `noisysource-agent`), so it can only use the free tier: Google refuses past
  the limit, it can't charge. Free-tier conversations may be used by Google to improve its
  models, which is fine here (nothing private reaches the model).
- `passphrase` (string): the phrase you hand out. Case, accents and punctuation don't matter.
- optional: `enabled` (false = Atlas sleeps for everyone), `model` (default
  `gemini-flash-lite-latest`), `globalLimit` (49), `quietHours` (7), `profile` (what Atlas may
  say about you once the door is open; empty = it says it can't share anything yet).
Without the doc, Atlas just answers "...atlas is asleep." Clients can't read `atlas_gate` (rules).

## Not built yet (agreed in the 2026-11-17 voice call)
- **Your Atlas telling you** "somebody's trying to reach you": the data is ready
  (`atlas_awakenings`, readable by `atlas@kidclub.pt`, `seen` flag; contract in root
  CLAUDE.md), the polling/announcing lives in the Atlas repo (`noisysource/Atlas`).
- **Backup email** when your Atlas is off: not built; needs a mail sender for the NoisySource
  projects (KidClub's `SendEmailFromOutbox` lives in the KidClub unit).
- **Second layer**: a confirmation code by email for approved people (for now the phrase is
  the only key).
- App Check on `/api/atlas` (for now the caps are the protection).

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
