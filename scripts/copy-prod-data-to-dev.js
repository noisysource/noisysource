#!/usr/bin/env node
/**
 * Copies real families/children/studyroom/transportationSubscriptions data from
 * rainbow-prod-2454b into kidclub-dev, for testing the missing-fields export/import
 * against realistic data. Preserves document IDs so familyId/childId relationships
 * stay intact.
 *
 * READ-ONLY against prod. Never writes to rainbow-prod-2454b.
 *
 * Additive, not destructive: before writing each doc, checks for an ID collision
 * with what's already in dev and skips it (reported, not overwritten) rather than
 * clobbering anything already there — dev may have live manual-testing data in
 * parallel with this running.
 *
 * Vendus safety: syncVendusClient (functions/src/kidclub/syncVendusClient.ts)
 * fires on create/update of any families/{familyId} doc with profileComplete=true,
 * and calls the REAL Vendus API (vendus.ts's BASE_URL is hardcoded to
 * https://www.vendus.pt/ws/v1.1 -- no sandbox branching exists). Copying prod
 * family docs as-is would create/update real Vendus client records for real
 * families as a side effect. Mitigated by forcing profileComplete: false on every
 * copied family doc -- syncVendusClient explicitly no-ops when that's false.
 * Every other field is copied as-is.
 *
 * Other known Firestore triggers on these collections were checked and are safe
 * for a single create-only write (see commit message / PR description for the
 * full analysis): onStudyroomCreated/onTransportCreated only email
 * admin@kidclub.pt (not a customer); the status-change/billing/approval triggers
 * are onDocumentUpdated and don't fire on initial creation; the discount-recalc
 * triggers fire on create but only rewrite fee/discount fields internally in
 * Firestore, no external reach. This is why the script does exactly one set() per
 * doc and never updates a doc a second time after creating it.
 *
 * Auth: Application Default Credentials for both projects (the currently
 * authenticated gcloud identity needs read access to prod and write access to
 * dev) -- same reasoning as the other scripts here, see
 * migrate-studyroom-contact-email.js.
 *
 * Usage:
 *   node scripts/copy-prod-data-to-dev.js --dry-run
 *   node scripts/copy-prod-data-to-dev.js
 */

const admin = require('firebase-admin');

const COLLECTIONS = ['families', 'children', 'studyroom', 'transportationSubscriptions'];

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const prodApp = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'rainbow-prod-2454b' }, 'prod');
  const devApp = admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'kidclub-dev' }, 'dev');
  const prodRoot = prodApp.firestore().collection('_apps').doc('arcoiris');
  const devRoot = devApp.firestore().collection('_apps').doc('arcoiris');

  console.log(`Copying rainbow-prod-2454b -> kidclub-dev${dryRun ? ' (dry run)' : ''}`);
  console.log('families docs will be copied with profileComplete forced to false (see header comment — avoids live Vendus API calls).\n');

  const summary = {};

  for (const name of COLLECTIONS) {
    const prodSnap = await prodRoot.collection(name).get();
    let copied = 0, skipped = 0;
    const skippedIds = [];

    for (const doc of prodSnap.docs) {
      const devRef = devRoot.collection(name).doc(doc.id);
      const existing = await devRef.get();
      if (existing.exists) {
        skipped++;
        skippedIds.push(doc.id);
        continue;
      }

      const data = { ...doc.data() };
      if (name === 'families') data.profileComplete = false;

      if (!dryRun) await devRef.set(data);
      copied++;
    }

    summary[name] = { total: prodSnap.size, copied, skipped };
    console.log(`${name}: ${prodSnap.size} in prod, ${copied} copied, ${skipped} skipped (collision)${skippedIds.length ? ' [' + skippedIds.join(', ') + ']' : ''}`);
  }

  console.log('\nSummary:');
  for (const name of COLLECTIONS) {
    const s = summary[name];
    console.log(`  ${name}: ${s.copied} copied${dryRun ? ' (dry run — no writes made)' : ''}, ${s.skipped} skipped`);
  }
}

main().catch(err => {
  console.error('Copy failed:', err);
  process.exit(1);
});
