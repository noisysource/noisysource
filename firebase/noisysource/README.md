# Firebase project folder: NoisySource

The Firebase config of the NoisySource projects (`noisysource-dev`, `noisysource-prod`):
rules, indexes and, as they arrive, functions and hosting. Run `firebase` from this folder
and it acts on these projects only; the repo root's `firebase.json` is KidClub's.

Deployed by CI (`.github/workflows/_deploy-env.yml`): a PR into `staging` deploys what it
changes here to `noisysource-dev`; merging it deploys the same to `noisysource-prod`
(`deploy-noisysource-prod.yml`). A merge into `staging` is a release for these projects.

## Hosting
`firebase deploy` only serves folders inside this one, so each hosting target's `public` is
`hosting/<target>` (gitignored). CI copies the app's build there. By hand:

```bash
pnpm --filter domotics build:nsdev
mkdir -p hosting && rm -rf hosting/domotics && cp -R ../../apps/noisysource/domotics/dist hosting/domotics
firebase deploy --only hosting:domotics --project noisysource-dev
```

## Rules tests
Needs Java. From this folder:

```bash
pnpm test:rules:domotics    # from the repo root
```

These rules are the only copy of the Domotics rules (the KidClub projects' root file had one
until 2026-11-16). The owner is `admin@noisysource.com` and the bridge
`domotics-bridge@kidclub.pt`, and both addresses must be verified; `domotics-identity` tests
that. Atlas, Renato's assistant, is `atlas@kidclub.pt` (verified): the owner's access to the
house minus bridge admin, with its commands held to the app's shapes; `domotics-atlas` tests that. The emulator here uses port 8089, so it doesn't collide with one on 8080.
