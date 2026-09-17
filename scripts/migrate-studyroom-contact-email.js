#!/usr/bin/env node
/**
 * One-time backfill: studyroom docs that only have `email` set get `contactEmail`
 * copied over. Historically some admin flows wrote `email` instead of
 * `contactEmail`, which is why unclaimed-subscription detection had to query both
 * fields (see familyService.hasUnclaimedSubscriptions) — this migration is what
 * lets that eventually be simplified back down to one field.
 *
 * Non-destructive: only adds/sets `contactEmail`, never removes `email`. Idempotent
 * — skips docs that already have `contactEmail` set to a non-empty value.
 *
 * Auth: uses Application Default Credentials (the already-authenticated `gcloud`
 * session), not a service-account key file. The scripts/*-service-account.json
 * convention some older scripts here use is deliberately not followed — those
 * exact files were found committed in git history earlier and are being retired,
 * not relied on for new scripts. Run `gcloud auth application-default login` if
 * this errors on credential loading.
 *
 * Usage:
 *   node scripts/migrate-studyroom-contact-email.js --project=kidclub-dev --dry-run
 *   node scripts/migrate-studyroom-contact-email.js --project=kidclub-dev
 *
 * Refuses to run against rainbow-prod-2454b without --confirm-prod, on top of
 * whatever human sign-off process this is being run under.
 */

const admin = require('firebase-admin');

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    })
  );
  return {
    project: args.project,
    dryRun: !!args['dry-run'],
    confirmProd: !!args['confirm-prod'],
  };
}

async function main() {
  const { project, dryRun, confirmProd } = parseArgs();

  if (!project) {
    console.error('Usage: node scripts/migrate-studyroom-contact-email.js --project=<id> [--dry-run]');
    process.exit(1);
  }
  if (project === 'rainbow-prod-2454b' && !confirmProd) {
    console.error(
      'Refusing to run against rainbow-prod-2454b without --confirm-prod.\n' +
      'This migration should be verified against dev first — see the task description.'
    );
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: project,
  });
  const db = admin.firestore();

  console.log(`Project: ${project}${dryRun ? ' (dry run)' : ''}`);

  // KidClub data lives under _apps/arcoiris/{collection}, not at collection root
  // — see apps/noisyphocus/kidclub/src/lib/db.ts.
  const snap = await db.collection('_apps/arcoiris/studyroom').get();
  let scanned = 0, migrated = 0, alreadyOk = 0, skippedNoEmail = 0;

  for (const doc of snap.docs) {
    scanned++;
    const data = doc.data();
    const hasContactEmail = typeof data.contactEmail === 'string' && data.contactEmail.trim().length > 0;
    const legacyEmail = typeof data.email === 'string' ? data.email.trim() : '';

    if (hasContactEmail) { alreadyOk++; continue; }
    if (!legacyEmail) { skippedNoEmail++; continue; }

    console.log(`  ${doc.id}: contactEmail <- "${legacyEmail}"`);
    if (!dryRun) {
      await doc.ref.update({ contactEmail: legacyEmail, updatedAt: new Date() });
    }
    migrated++;
  }

  console.log('\nSummary:');
  console.log(`  Scanned:              ${scanned}`);
  console.log(`  Already had contactEmail: ${alreadyOk}`);
  console.log(`  Migrated:             ${migrated}${dryRun ? ' (dry run — no writes made)' : ''}`);
  console.log(`  Skipped (no email at all): ${skippedNoEmail}`);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
