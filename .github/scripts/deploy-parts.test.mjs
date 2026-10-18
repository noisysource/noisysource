// Tests for deploy-parts.mjs. Run: node --test .github/scripts/
// The plan job runs these before trusting the script's answer, since a wrong
// answer here means a change silently never reaches dev.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARTS, Repo, planFromFiles, lockfileParts } from './deploy-parts.mjs';

// A tiny monorepo shaped like the real one.
const FIXTURE = {
  'apps/noisyphocus/kidclub/src/App.tsx': "import { Booking } from '@shared/models';\nimport '@/styles.css';",
  'apps/noisyphocus/kidclub/vite.config.ts': "import { createViteConfig } from '../../../vite.config.base';",
  'apps/noisysource/finances/src/App.tsx': [
    'import {',
    '  BankTransaction,',
    "} from '@shared/models/BankTransaction';",
    "import { vat } from '../../../../packages/shared/lib/vat';",
  ].join('\n'),
  'apps/noisysource/domotics/src/App.tsx': "import type { Device } from '@shared/models/Device';",
  'functions/src/index.ts': "import * as admin from 'firebase-admin';",
  'functions/src/party.test.ts': "import { x } from '../../packages/shared/models/partyPricing';",
  'packages/shared/models/index.ts': "export * from './Booking';",
  'packages/shared/models/Booking.ts': "import { money } from '../lib/money';",
  'packages/shared/models/BankTransaction.ts': 'export interface BankTransaction {}',
  'packages/shared/models/Device.ts': 'export interface Device {}',
  'packages/shared/models/partyPricing.ts': 'export const x = 1;',
  'packages/shared/lib/money.ts': 'export const money = 1;',
  'packages/shared/lib/vat.ts': 'export const vat = 1;',
  'packages/shared/lib/unused.ts': 'export const unused = 1;',
  'packages/shared/ProtectedRoute.tsx': "import type { AppUser } from '@shared/dist/models';",
  'packages/shared/tsconfig.json': '{}',
  'vite.config.base.ts': "import { defineConfig } from 'vite';",
};

function repo(overrides = {}) {
  const files = { ...FIXTURE, ...overrides };
  for (const [k, v] of Object.entries(files)) if (v === null) delete files[k];
  return new Repo(Object.keys(files), (f) => files[f]);
}

function deployed(changed, opts = {}) {
  const plan = planFromFiles(changed, { repo: repo(opts.files), lockfile: opts.lockfile });
  if (plan.everything) return 'everything';
  return PARTS.filter((p) => plan.parts.get(p).length).sort();
}

test('docs, scripts and the Pi bridge deploy nothing', () => {
  assert.deepEqual(
    deployed([
      'CLAUDE.md',
      'apps/noisysource/finances/STATUS.md',
      'scripts/seed-finhub.js',
      'apps/noisysource/domotics-bridge/src/index.ts',
      'mcp/firestore/index.js',
    ]),
    [],
  );
});

test('pipeline and workspace config deploy everything', () => {
  for (const f of ['.github/workflows/deploy-dev.yml', '.github/scripts/deploy-parts.mjs', 'package.json',
    'pnpm-workspace.yaml', 'firebase.json', '.firebaserc', 'tsconfig.base.json', 'vite.config.base.ts']) {
    assert.equal(deployed([f]), 'everything', f);
  }
});

test('a file no rule knows about deploys everything', () => {
  assert.equal(deployed(['some-new-root-config.json']), 'everything');
});

test('each owned path deploys only its own part', () => {
  assert.deepEqual(deployed(['apps/noisyphocus/kidclub/src/App.tsx']), ['kidclub']);
  assert.deepEqual(deployed(['apps/noisysource/finances/.env.staging']), ['finances']);
  assert.deepEqual(deployed(['apps/noisysource/domotics/public/icon.png']), ['domotics']);
  assert.deepEqual(deployed(['functions/src/domotics/legrand.ts']), ['functions']);
  assert.deepEqual(deployed(['infra/gcp/terraform/iam.tf']), ['terraform']);
  assert.deepEqual(deployed(['firestore.rules']), ['firestore_rules']);
  assert.deepEqual(deployed(['firestore.indexes.json']), ['firestore_indexes']);
  assert.deepEqual(deployed(['storage.rules']), ['storage_rules']);
});

test('packages/shared deploys only the packages that import the changed file', () => {
  // finances imports BankTransaction directly (multi-line import).
  assert.deepEqual(deployed(['packages/shared/models/BankTransaction.ts']), ['finances']);
  // kidclub reaches Booking through the models barrel, and money through Booking.
  assert.deepEqual(deployed(['packages/shared/models/Booking.ts']), ['kidclub']);
  assert.deepEqual(deployed(['packages/shared/lib/money.ts']), ['kidclub']);
  // relative path into packages/shared counts too
  assert.deepEqual(deployed(['packages/shared/lib/vat.ts']), ['finances']);
  assert.deepEqual(deployed(['packages/shared/models/Device.ts']), ['domotics']);
  // only a functions *test* imports partyPricing: tests aren't deployed
  assert.deepEqual(deployed(['packages/shared/models/partyPricing.ts']), []);
  // imported by nobody
  assert.deepEqual(deployed(['packages/shared/lib/unused.ts']), []);
});

test('packages/shared changes that imports cannot trace deploy every consumer', () => {
  const all = ['domotics', 'finances', 'functions', 'kidclub'];
  assert.deepEqual(deployed(['packages/shared/tsconfig.json']), all);
  // deleted file: gone from the head tree, so nobody can be seen importing it
  assert.deepEqual(deployed(['packages/shared/lib/gone.ts']), all);
  // an import into packages/shared that doesn't resolve makes that consumer
  // depend on all of it
  assert.deepEqual(
    deployed(['packages/shared/lib/unused.ts'], {
      files: { 'apps/noisysource/domotics/src/x.ts': "import { y } from '@shared/lib/does-not-exist';" },
    }),
    ['domotics'],
  );
});

test('@shared/dist/<x> resolves to packages/shared/<x>', () => {
  assert.deepEqual(
    deployed(['packages/shared/models/Booking.ts'], {
      files: {
        'apps/noisyphocus/kidclub/src/App.tsx': "import { a } from 'react';",
        'apps/noisysource/finances/src/App.tsx': "import { ProtectedRoute } from '@shared/ProtectedRoute';",
      },
    }),
    ['finances'],
  );
});

// --- pnpm-lock.yaml -------------------------------------------------------

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      react:
        specifier: ^18.2.0
        version: 18.3.1

  apps/noisysource/domotics:
    dependencies:
      firebase:
        specifier: ^10.14.1
        version: 10.14.1

  apps/noisysource/domotics-bridge:
    dependencies:
      tuyapi:
        specifier: ^7.0.0
        version: 7.7.0

  apps/noisysource/finances:
    dependencies:
      chart.js:
        specifier: ^4.0.0
        version: 4.5.0

packages:

  '@tootallnate/once@2.0.0':
    resolution: {integrity: sha512-aaa}
    engines: {node: '>= 10'}

  chart.js@4.5.0:
    resolution: {integrity: sha512-bbb}

snapshots:

  '@tootallnate/once@2.0.0':
    optional: true

  chart.js@4.5.0:
    dependencies:
      '@kurkle/color': 0.3.4
`;

const withDomoticsDep = LOCK
  .replace(`      firebase:
        specifier: ^10.14.1
        version: 10.14.1
`, `      firebase:
        specifier: ^10.14.1
        version: 10.14.1
      three:
        specifier: 0.170.0
        version: 0.170.0
`)
  .replace(`    resolution: {integrity: sha512-bbb}
`, `    resolution: {integrity: sha512-bbb}

  three@0.170.0:
    resolution: {integrity: sha512-ccc}
`)
  // v9 writes dependency-less snapshot entries inline as "{}"
  .replace(`  '@tootallnate/once@2.0.0':
    optional: true
`, `  '@tootallnate/once@2.0.0':
    optional: true

  three@0.170.0: {}
`);

test('lockfile: a new dependency of one package deploys only that package', () => {
  assert.deepEqual(lockfileParts(LOCK, withDomoticsDep), { parts: ['domotics'], importers: ['apps/noisysource/domotics'] });
  assert.deepEqual(deployed(['pnpm-lock.yaml'], { lockfile: () => lockfileParts(LOCK, withDomoticsDep) }), ['domotics']);
});

test('lockfile: the Pi bridge\'s dependencies deploy nothing', () => {
  const bumped = LOCK.replace('version: 7.7.0', 'version: 7.7.1');
  assert.deepEqual(deployed(['pnpm-lock.yaml'], { lockfile: () => lockfileParts(LOCK, bumped) }), []);
});

test('lockfile: anything that could be shared deploys everything', () => {
  const cases = {
    'existing snapshot changed': LOCK.replace("'@kurkle/color': 0.3.4", "'@kurkle/color': 0.3.5"),
    'existing package changed': LOCK.replace('sha512-aaa', 'sha512-zzz'),
    'settings changed': LOCK.replace('autoInstallPeers: true', 'autoInstallPeers: false'),
    'root package changed': LOCK.replace('version: 18.3.1', 'version: 18.3.2'),
    'only packages added, no importer changed': LOCK.replace(`    resolution: {integrity: sha512-bbb}
`, `    resolution: {integrity: sha512-bbb}

  orphan@1.0.0:
    resolution: {integrity: sha512-ddd}
`),
    'unknown workspace package': LOCK.replace('importers:\n', 'importers:\n\n  apps/noisysource/tasks:\n    dependencies:\n      x:\n        specifier: 1.0.0\n        version: 1.0.0\n'),
  };
  for (const [name, head] of Object.entries(cases)) {
    assert.ok(lockfileParts(LOCK, head).everything, name);
  }
  assert.ok(lockfileParts(null, LOCK).everything, 'lockfile added');
});
