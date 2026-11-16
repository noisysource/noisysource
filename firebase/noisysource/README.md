# Firebase project folder: NoisySource

The Firebase config of the NoisySource projects (`noisysource-dev`, `noisysource-prod`):
rules, indexes and, as they arrive, functions and hosting. Run `firebase` from this folder
and it acts on these projects only; the repo root's `firebase.json` is KidClub's.

Deployed by CI (`.github/workflows/_deploy-env.yml`): a PR into `staging` deploys what it
changes here to `noisysource-dev`.

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
firebase emulators:exec --only firestore --project demo-kidclub-rules \
  "node ../../scripts/rules-tests/domotics-automation.rules-test.cjs && node ../../scripts/rules-tests/domotics-incidents.rules-test.cjs && node ../../scripts/rules-tests/domotics-energy.rules-test.cjs && node ../../scripts/rules-tests/domotics-climate.rules-test.cjs"
```

These are the same tests that run against the root rules file (`pnpm test:rules:domotics`),
so the two copies of the Domotics rules are held to the same behaviour until the root copy
is removed. The emulator here uses port 8089, so it doesn't collide with one on 8080.
