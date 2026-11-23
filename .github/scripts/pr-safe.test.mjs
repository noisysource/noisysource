// Tests for pr-safe.mjs. Run: node --test .github/scripts/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terraformTargets, functionsOnly } from './pr-safe.mjs';

test('a PR applies what it creates or changes, and keeps what it would delete or replace', () => {
  // The real plan from 2026-11-23: the website PR would delete the kanban PR's site.
  const plan = {
    resource_changes: [
      { address: 'google_firebase_hosting_site.sites["noisysource-dev-tasks"]', change: { actions: ['delete'] } },
      { address: 'google_firebase_hosting_site.sites["noisysource-dev-web"]', change: { actions: ['create'] } },
      { address: 'google_project_service.apis["run.googleapis.com"]', change: { actions: ['no-op'] } },
      { address: 'google_storage_bucket.b', change: { actions: ['update'] } },
      { address: 'google_x.replaced', change: { actions: ['delete', 'create'] } },
      { address: 'data.google_project.p', change: { actions: ['read'] } },
    ],
  };
  assert.deepEqual(terraformTargets(plan), {
    targets: ['google_firebase_hosting_site.sites["noisysource-dev-web"]', 'google_storage_bucket.b'],
    kept: ['google_firebase_hosting_site.sites["noisysource-dev-tasks"]', 'google_x.replaced'],
  });
  assert.deepEqual(terraformTargets({}), { targets: [], kept: [] });
});

test('functions: only the ones this branch exports, with the codebase when there is one', () => {
  assert.equal(functionsOnly(['onCampDepositPaid', 'getCampAvailability'], undefined), 'functions:getCampAvailability,functions:onCampDepositPaid');
  assert.equal(functionsOnly(['atlasGate', 'legrandGetHome'], 'noisysource'), 'functions:noisysource:atlasGate,functions:noisysource:legrandGetHome');
  assert.equal(functionsOnly(['ok', 'not ok;rm'], undefined), 'functions:ok');
  assert.throws(() => functionsOnly([], undefined), /no functions/);
});
