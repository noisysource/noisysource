// Which entity an Atlas import belongs to. Run: pnpm --filter finhub test
const assert = require('node:assert/strict');
const { entityForHint, entityKey } = require('../node_modules/.tmp/test/entityMatch.cjs');

const entities = [
  { id: 'lda', name: 'NoisySource, Lda' },
  { id: 'phocus', name: 'Noisy Phocus, Lda' },
  { id: 'home', name: 'Household (Renato & Marisa)' },
  { id: 'old', name: 'Noisy Source', archived: true },
];
assert.equal(entityKey('NOISYSOURCE - LDA'), 'noisysource');
assert.equal(entityForHint('Noisy Source', entities)?.id, 'lda');
assert.equal(entityForHint('Noisy Phocus', entities)?.id, 'phocus');
assert.equal(entityForHint('Household', entities)?.id, 'home');
assert.equal(entityForHint('Someone else', entities), undefined);
console.log('ok  entity for an import: names match without case, spacing or "Lda"; archived ones are skipped');
