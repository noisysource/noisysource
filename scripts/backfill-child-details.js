#!/usr/bin/env node
/**
 * One-time reconciliation: backfill schoolName/schoolYear/homeAddress on children
 * docs from data that already exists elsewhere, before the "these are now required"
 * change in EnrollmentDetailsForm.tsx makes their absence a blocker.
 *
 * - schoolName/schoolYear: pulled from the child's transportationSubscriptions/
 *   studyroom docs — matched by childId where already linked, and by normalized
 *   childName for subs that are themselves still missing childId (legacy orphaned
 *   records). First non-empty value found wins.
 * - homeAddress: pulled from the child's family billingAddress (familyId ->
 *   families.billingAddress) when that's itself reasonably complete (street, city,
 *   postalCode all present). Written with homeAddressSource: 'family_billing_address'
 *   so it's clearly flagged as inherited, not confirmed -- a child's actual home
 *   address isn't guaranteed to match billing.
 *
 * This is a reconciliation of already-existing data, applied directly -- not a
 * guess. Whatever's still missing after this is left for the CSV export/import in
 * the admin UI (see SubscriptionsAdminPage.tsx).
 *
 * Auth: Application Default Credentials, same as migrate-studyroom-contact-email.js
 * -- see that file for why the scripts/*-service-account.json convention isn't used.
 *
 * Usage:
 *   node scripts/backfill-child-details.js --project=kidclub-dev --dry-run
 *   node scripts/backfill-child-details.js --project=kidclub-dev
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
  return { project: args.project, dryRun: !!args['dry-run'], confirmProd: !!args['confirm-prod'] };
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function addressComplete(addr) {
  return !!(addr && String(addr.street || '').trim() && String(addr.city || '').trim() && String(addr.postalCode || '').trim());
}

async function main() {
  const { project, dryRun, confirmProd } = parseArgs();
  if (!project) {
    console.error('Usage: node scripts/backfill-child-details.js --project=<id> [--dry-run]');
    process.exit(1);
  }
  if (project === 'rainbow-prod-2454b' && !confirmProd) {
    console.error('Refusing to run against rainbow-prod-2454b without --confirm-prod. Verify against dev first.');
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: project });
  const db = admin.firestore();
  const root = db.collection('_apps').doc('arcoiris');

  console.log(`Project: ${project}${dryRun ? ' (dry run)' : ''}`);

  const [childrenSnap, transportSnap, studySnap, familiesSnap] = await Promise.all([
    root.collection('children').get(),
    root.collection('transportationSubscriptions').get(),
    root.collection('studyroom').get(),
    root.collection('families').get(),
  ]);

  const familiesById = new Map(familiesSnap.docs.map(d => [d.id, d.data()]));

  // Candidate subs for school info, per child: by childId (both collections) and by
  // normalized name for subs still missing childId.
  const subsByChildId = new Map(); // childId -> [{schoolName, schoolYear}]
  const subsByName = new Map();    // normalizedName -> [{schoolName, schoolYear}]
  for (const d of [...transportSnap.docs, ...studySnap.docs]) {
    const data = d.data();
    const info = { schoolName: data.schoolName, schoolYear: data.schoolYear };
    if (!info.schoolName && !info.schoolYear) continue;
    if (data.childId) {
      if (!subsByChildId.has(data.childId)) subsByChildId.set(data.childId, []);
      subsByChildId.get(data.childId).push(info);
    } else {
      const key = normalizeName(data.childName ?? data.studentName ?? '');
      if (!key) continue;
      if (!subsByName.has(key)) subsByName.set(key, []);
      subsByName.get(key).push(info);
    }
  }

  let alreadyComplete = 0, resolvedByAutofill = 0, stillMissing = 0;
  const writes = [];

  for (const doc of childrenSnap.docs) {
    const data = doc.data();
    const missingSchoolName = !String(data.schoolName || '').trim();
    const missingSchoolYear = !String(data.schoolYear || '').trim();
    const missingAddress = !addressComplete(data.homeAddress);

    if (!missingSchoolName && !missingSchoolYear && !missingAddress) {
      alreadyComplete++;
      continue;
    }

    const patch = {};

    if (missingSchoolName || missingSchoolYear) {
      const fullName = normalizeName(`${data.firstName ?? ''} ${data.lastName ?? ''}`);
      const candidates = [...(subsByChildId.get(doc.id) ?? []), ...(subsByName.get(fullName) ?? [])];
      for (const c of candidates) {
        if (missingSchoolName && !patch.schoolName && c.schoolName) patch.schoolName = c.schoolName;
        if (missingSchoolYear && !patch.schoolYear && c.schoolYear) patch.schoolYear = c.schoolYear;
      }
    }

    if (missingAddress && data.familyId) {
      const family = familiesById.get(data.familyId);
      if (family && addressComplete(family.billingAddress)) {
        patch.homeAddress = family.billingAddress;
        patch.homeAddressSource = 'family_billing_address';
      }
    }

    if (Object.keys(patch).length > 0) {
      writes.push({ id: doc.id, name: `${data.firstName ?? ''} ${data.lastName ?? ''}`.trim(), patch });
    }

    const willBeComplete =
      (!missingSchoolName || !!patch.schoolName) &&
      (!missingSchoolYear || !!patch.schoolYear) &&
      (!missingAddress || !!patch.homeAddress);
    if (willBeComplete) resolvedByAutofill++; else stillMissing++;
  }

  for (const w of writes) {
    console.log(`  ${w.id} (${w.name}): ${Object.keys(w.patch).join(', ')}`);
    if (!dryRun) {
      await root.collection('children').doc(w.id).update({ ...w.patch, updatedAt: new Date() });
    }
  }

  console.log('\nSummary:');
  console.log(`  Total children:              ${childrenSnap.size}`);
  console.log(`  Already complete before run:  ${alreadyComplete}`);
  console.log(`  Resolved by auto-fill:        ${resolvedByAutofill}${dryRun ? ' (dry run — no writes made)' : ''}`);
  console.log(`  Still missing after auto-fill: ${stillMissing}`);
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
