#!/usr/bin/env ts-node
/**
 * Migration Script: Legacy Subscriptions → Family-Centric Model
 * 
 * This script migrates existing subscriptions from the legacy model (userId-based)
 * to the new family-centric model (familyId + childId).
 * 
 * Usage:
 *   ts-node scripts/migrate-to-family-model.ts [--dry-run] [--project=dev|prod]
 * 
 * Options:
 *   --dry-run    : Show what would be migrated without making changes
 *   --project=   : Firebase project (dev or prod, default: dev)
 */

import * as admin from 'firebase-admin';
import * as path from 'path';
import * as readline from 'readline';

interface MigrationStats {
  familiesCreated: number;
  childrenCreated: number;
  childrenMatched: number;
  studySubscriptionsUpdated: number;
  transportSubscriptionsUpdated: number;
  bookingsUpdated: number;
  errors: Array<{ type: string; id: string; error: string }>;
}

// Helper to parse name into first/last
function parseName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || '',
  };
}

// Helper to calculate age from date
function calculateAge(birthDate: Date | admin.firestore.Timestamp | string): number | undefined {
  try {
    let date: Date;
    if (birthDate instanceof Date) {
      date = birthDate;
    } else if (birthDate instanceof admin.firestore.Timestamp) {
      date = birthDate.toDate();
    } else if (typeof birthDate === 'string') {
      date = new Date(birthDate);
    } else {
      return undefined;
    }
    
    if (isNaN(date.getTime())) return undefined;
    
    const today = new Date();
    let age = today.getFullYear() - date.getFullYear();
    const monthDiff = today.getMonth() - date.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < date.getDate())) {
      age--;
    }
    return age >= 0 ? age : undefined;
  } catch {
    return undefined;
  }
}

// Find or create Family for a user
async function findOrCreateFamily(
  db: admin.firestore.Firestore,
  userId: string,
  userEmail: string,
  userName: string,
  dryRun: boolean,
  stats: MigrationStats
): Promise<string | null> {
  try {
    // Try to find existing family
    const familiesSnapshot = await db.collection('families')
      .where('primaryContact.userId', '==', userId)
      .limit(1)
      .get();

    if (!familiesSnapshot.empty) {
      return familiesSnapshot.docs[0].id;
    }

    // Create new family
    if (dryRun) {
      console.log(`  [DRY-RUN] Would create Family for user ${userId} (${userEmail})`);
      return `dry-run-family-${userId}`;
    }

    const familyData = {
      primaryContact: {
        userId,
        email: userEmail || '',
        name: userName || userEmail?.split('@')[0] || 'User',
        phone: '',
      },
      status: 'active' as const,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const familyRef = await db.collection('families').add(familyData);
    stats.familiesCreated++;
    console.log(`  ✓ Created Family ${familyRef.id} for user ${userId}`);
    return familyRef.id;
  } catch (error: any) {
    stats.errors.push({ type: 'family', id: userId, error: error.message });
    console.error(`  ✗ Error creating/finding family for ${userId}:`, error.message);
    return null;
  }
}

// Find or create Child for a subscription
async function findOrCreateChild(
  db: admin.firestore.Firestore,
  familyId: string,
  studentName: string,
  dryRun: boolean,
  stats: MigrationStats,
  schoolName?: string,
  schoolYear?: string,
  studentAge?: number,
): Promise<string | null> {
  try {
    const { firstName, lastName } = parseName(studentName);

    // Try to find existing child by name
    const childrenSnapshot = await db.collection('children')
      .where('familyId', '==', familyId)
      .where('firstName', '==', firstName)
      .where('lastName', '==', lastName)
      .limit(1)
      .get();

    if (!childrenSnapshot.empty) {
      const childId = childrenSnapshot.docs[0].id;
      stats.childrenMatched++;
      console.log(`    ✓ Matched existing Child ${childId} for ${studentName}`);
      
      // Update child with additional info if missing
      const childData = childrenSnapshot.docs[0].data();
      const updates: any = {};
      if (!childData.schoolName && schoolName) updates.schoolName = schoolName;
      if (!childData.schoolYear && schoolYear) updates.schoolYear = schoolYear;
      
      if (Object.keys(updates).length > 0 && !dryRun) {
        updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        await childrenSnapshot.docs[0].ref.update(updates);
        console.log(`      Updated child with additional info`);
      }
      
      return childId;
    }

    // Create new child
    if (dryRun) {
      console.log(`    [DRY-RUN] Would create Child for ${studentName}`);
      return `dry-run-child-${studentName}`;
    }

    // Estimate date of birth from age if provided
    let dateOfBirth: admin.firestore.Timestamp | undefined;
    if (studentAge && studentAge > 0 && studentAge < 25) {
      const birthYear = new Date().getFullYear() - studentAge;
      dateOfBirth = admin.firestore.Timestamp.fromDate(new Date(birthYear, 0, 1));
    } else {
      // Default to 5 years ago if no age
      dateOfBirth = admin.firestore.Timestamp.fromDate(
        new Date(new Date().getFullYear() - 5, 0, 1)
      );
    }

    const childData: any = {
      familyId,
      firstName,
      lastName,
      dateOfBirth,
      age: studentAge,
      status: 'active' as const,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (schoolName) childData.schoolName = schoolName;
    if (schoolYear) childData.schoolYear = schoolYear;

    const childRef = await db.collection('children').add(childData);
    stats.childrenCreated++;
    console.log(`    ✓ Created Child ${childRef.id} for ${studentName}`);
    return childRef.id;
  } catch (error: any) {
    stats.errors.push({ type: 'child', id: studentName, error: error.message });
    console.error(`    ✗ Error creating/finding child for ${studentName}:`, error.message);
    return null;
  }
}

// Migrate Study Room subscriptions
async function migrateStudyRoomSubscriptions(
  db: admin.firestore.Firestore,
  dryRun: boolean,
  stats: MigrationStats
): Promise<void> {
  console.log('\n📚 Migrating Study Room Subscriptions...');

  // Get all subscriptions - Firestore doesn't support querying for null
  // So we get all and filter
  const allSubscriptions = await db.collection('studyroom').get();
  
  const toMigrate = allSubscriptions.docs.filter(doc => {
    const data = doc.data();
    // Migrate if no familyId but has userId
    return (!data.familyId || data.familyId === null || data.familyId === undefined) && data.userId;
  });

  console.log(`  Found ${toMigrate.length} study room subscriptions to migrate`);

  // Group by userId
  const byUserId = new Map<string, typeof toMigrate>();
  for (const doc of toMigrate) {
    const userId = doc.data().userId;
    if (!userId) continue;
    
    if (!byUserId.has(userId)) {
      byUserId.set(userId, []);
    }
    byUserId.get(userId)!.push(doc);
  }

  // Process each user's subscriptions
  for (const [userId, subscriptions] of byUserId) {
    console.log(`\n  Processing user ${userId} (${subscriptions.length} subscriptions)`);

    // Get user info (try from auth or from first subscription)
    let userEmail = '';
    let userName = '';
    
    try {
      const userRecord = await admin.auth().getUser(userId);
      userEmail = userRecord.email || '';
      userName = userRecord.displayName || userEmail?.split('@')[0] || '';
    } catch {
      // Fallback: get from subscription data
      const firstSub = subscriptions[0]?.data();
      userEmail = firstSub?.email || firstSub?.contactEmail || '';
      userName = firstSub?.guardianName || firstSub?.parentName || '';
    }

    // Find or create family
    const familyId = await findOrCreateFamily(db, userId, userEmail, userName, dryRun, stats);
    if (!familyId) continue;

    // Process each subscription
    for (const doc of subscriptions) {
      try {
        const data = doc.data();
        const studentName = data.studentName || data.childName || '';
        
        if (!studentName) {
          console.log(`    ⚠ Skipping subscription ${doc.id} - no student name`);
          continue;
        }

        // Find or create child
        const childId = await findOrCreateChild(
          db,
          familyId,
          studentName,
          data.schoolName,
          data.schoolYear,
          data.studentAge || data.childAge,
          dryRun,
          stats
        );

        if (!childId) continue;

        // Update subscription
        const updates: any = {
          familyId,
          childId,
          childName: studentName,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        
        if (data.studentAge || data.childAge) {
          updates.childAge = data.studentAge || data.childAge;
        }

        if (!dryRun) {
          await doc.ref.update(updates);
          stats.studySubscriptionsUpdated++;
          console.log(`    ✓ Updated subscription ${doc.id}`);
        } else {
          console.log(`    [DRY-RUN] Would update subscription ${doc.id}`);
          stats.studySubscriptionsUpdated++;
        }
      } catch (error: any) {
        stats.errors.push({ type: 'study', id: doc.id, error: error.message });
        console.error(`    ✗ Error updating subscription ${doc.id}:`, error.message);
      }
    }
  }
}

// Migrate Transport subscriptions
async function migrateTransportSubscriptions(
  db: admin.firestore.Firestore,
  dryRun: boolean,
  stats: MigrationStats
): Promise<void> {
  console.log('\n🚌 Migrating Transport Subscriptions...');

  const allSubscriptions = await db.collection('transportationSubscriptions').get();
  
  const toMigrate = allSubscriptions.docs.filter(doc => {
    const data = doc.data();
    return !data.familyId && (data.userId || data.contactEmail);
  });

  console.log(`  Found ${toMigrate.length} transport subscriptions to migrate`);

  // Group by userId or email
  const byUserId = new Map<string, typeof toMigrate>();
  for (const doc of toMigrate) {
    const data = doc.data();
    const userId = data.userId;
    const email = data.contactEmail;
    
    if (userId) {
      if (!byUserId.has(userId)) {
        byUserId.set(userId, []);
      }
      byUserId.get(userId)!.push(doc);
    } else if (email) {
      // For email-only subscriptions, we'll handle separately
      if (!byUserId.has(`email:${email}`)) {
        byUserId.set(`email:${email}`, []);
      }
      byUserId.get(`email:${email}`)!.push(doc);
    }
  }

  // Process each user's subscriptions
  for (const [userIdOrEmail, subscriptions] of byUserId) {
    const isEmailKey = userIdOrEmail.startsWith('email:');
    const userId = isEmailKey ? null : userIdOrEmail;
    const email = isEmailKey ? userIdOrEmail.replace('email:', '') : '';

    console.log(`\n  Processing ${userId || email} (${subscriptions.length} subscriptions)`);

    // Get user info
    let userEmail = email;
    let userName = '';
    
    if (userId) {
      try {
        const userRecord = await admin.auth().getUser(userId);
        userEmail = userRecord.email || email;
        userName = userRecord.displayName || userEmail?.split('@')[0] || '';
      } catch {
        // Fallback: get from subscription
        const firstSub = subscriptions[0]?.data();
        userEmail = firstSub?.contactEmail || email;
        userName = firstSub?.parentName || '';
      }
    } else {
      // Email-only: try to find user by email
      try {
        const userRecord = await admin.auth().getUserByEmail(email);
        const actualUserId = userRecord.uid;
        userEmail = email;
        userName = userRecord.displayName || email?.split('@')[0] || '';
        
        // Find or create family with actual userId
        const familyId = await findOrCreateFamily(db, actualUserId, userEmail, userName, dryRun, stats);
        if (!familyId) continue;

        // Process subscriptions with actual userId
        for (const doc of subscriptions) {
          await processTransportSubscription(db, doc, familyId, dryRun, stats);
        }
        continue;
      } catch {
        // No user found - will create family without userId
        userName = email?.split('@')[0] || '';
      }
    }

    // Find or create family (if userId is null, we'll need to handle differently)
    if (!userId) {
      console.log(`    ⚠ No userId found for ${email}, skipping...`);
      continue;
    }

    const familyId = await findOrCreateFamily(db, userId, userEmail, userName, dryRun, stats);
    if (!familyId) continue;

    // Process each subscription
    for (const doc of subscriptions) {
      await processTransportSubscription(db, doc, familyId, dryRun, stats);
    }
  }
}

async function processTransportSubscription(
  db: admin.firestore.Firestore,
  doc: admin.firestore.QueryDocumentSnapshot,
  familyId: string,
  dryRun: boolean,
  stats: MigrationStats
): Promise<void> {
  try {
    const data = doc.data();
    const studentName = data.studentName || data.childName || '';
    
    if (!studentName) {
      console.log(`    ⚠ Skipping subscription ${doc.id} - no student name`);
      return;
    }

    // Find or create child
    const childId = await findOrCreateChild(
      db,
      familyId,
      studentName,
      undefined,
      undefined,
      data.studentAge || data.childAge,
      dryRun,
      stats
    );

    if (!childId) return;

    // Update subscription
    const updates: any = {
      familyId,
      childId,
      childName: studentName,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    
    if (data.studentAge || data.childAge) {
      updates.childAge = data.studentAge || data.childAge;
    }

    if (!dryRun) {
      await doc.ref.update(updates);
      stats.transportSubscriptionsUpdated++;
      console.log(`    ✓ Updated subscription ${doc.id}`);
    } else {
      console.log(`    [DRY-RUN] Would update subscription ${doc.id}`);
      stats.transportSubscriptionsUpdated++;
    }
  } catch (error: any) {
    stats.errors.push({ type: 'transport', id: doc.id, error: error.message });
    console.error(`    ✗ Error updating subscription ${doc.id}:`, error.message);
  }
}

// Migrate Bookings
async function migrateBookings(
  db: admin.firestore.Firestore,
  dryRun: boolean,
  stats: MigrationStats
): Promise<void> {
  console.log('\n🎉 Migrating Party Bookings...');

  const allBookings = await db.collection('bookings').get();
  
  const toMigrate = allBookings.docs.filter(doc => {
    const data = doc.data();
    return !data.familyId && data.email;
  });

  console.log(`  Found ${toMigrate.length} bookings to migrate`);

  // Group by email
  const byEmail = new Map<string, typeof toMigrate>();
  for (const doc of toMigrate) {
    const email = doc.data().email;
    if (!email) continue;
    
    if (!byEmail.has(email)) {
      byEmail.set(email, []);
    }
    byEmail.get(email)!.push(doc);
  }

  // Process each email's bookings
  for (const [email, bookings] of byEmail) {
    console.log(`\n  Processing ${email} (${bookings.length} bookings)`);

    // Try to find user by email
    let userId: string | null = null;
    try {
      const userRecord = await admin.auth().getUserByEmail(email);
      userId = userRecord.uid;
    } catch {
      // No user found - skip
      console.log(`    ⚠ No user found for ${email}, skipping...`);
      continue;
    }

    // Find or create family
    const familyId = await findOrCreateFamily(db, userId, email, email.split('@')[0], dryRun, stats);
    if (!familyId) continue;

    // Process each booking
    for (const doc of bookings) {
      try {
        const data = doc.data();
        const childName = data.childName || '';
        
        let childId: string | undefined;
        if (childName) {
          // Try to find or create child
          childId = await findOrCreateChild(
            db,
            familyId,
            childName,
            undefined,
            undefined,
            data.childAge,
            dryRun,
            stats
          ) || undefined;
        }

        // Update booking
        const updates: any = {
          familyId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        
        if (childId) {
          updates.childId = childId;
        }

        if (!dryRun) {
          await doc.ref.update(updates);
          stats.bookingsUpdated++;
          console.log(`    ✓ Updated booking ${doc.id}`);
        } else {
          console.log(`    [DRY-RUN] Would update booking ${doc.id}`);
          stats.bookingsUpdated++;
        }
      } catch (error: any) {
        stats.errors.push({ type: 'booking', id: doc.id, error: error.message });
        console.error(`    ✗ Error updating booking ${doc.id}:`, error.message);
      }
    }
  }
}

// Main migration function
async function runMigration(dryRun: boolean, project: string): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Migration: Legacy Subscriptions → Family-Centric Model`);
  console.log(`Project: ${project}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (changes will be saved)'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Initialize Firebase Admin
  const serviceAccountPath = path.join(
    __dirname,
    `${project}-service-account.json`
  );

  try {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (error: any) {
    console.error(`\n✗ Error initializing Firebase Admin:`);
    console.error(`  Could not load service account: ${serviceAccountPath}`);
    console.error(`  Error: ${error.message}`);
    console.error(`\n  Make sure the service account file exists.`);
    process.exit(1);
  }

  const db = admin.firestore();
  const stats: MigrationStats = {
    familiesCreated: 0,
    childrenCreated: 0,
    childrenMatched: 0,
    studySubscriptionsUpdated: 0,
    transportSubscriptionsUpdated: 0,
    bookingsUpdated: 0,
    errors: [],
  };

  try {
    // Run migrations
    await migrateStudyRoomSubscriptions(db, dryRun, stats);
    await migrateTransportSubscriptions(db, dryRun, stats);
    await migrateBookings(db, dryRun, stats);

    // Print summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('Migration Summary');
    console.log(`${'='.repeat(60)}`);
    console.log(`Families Created:      ${stats.familiesCreated}`);
    console.log(`Children Created:      ${stats.childrenCreated}`);
    console.log(`Children Matched:       ${stats.childrenMatched}`);
    console.log(`Study Subs Updated:     ${stats.studySubscriptionsUpdated}`);
    console.log(`Transport Subs Updated: ${stats.transportSubscriptionsUpdated}`);
    console.log(`Bookings Updated:      ${stats.bookingsUpdated}`);
    console.log(`Errors:                ${stats.errors.length}`);
    
    if (stats.errors.length > 0) {
      console.log(`\nErrors encountered:`);
      stats.errors.forEach(err => {
        console.log(`  - ${err.type} ${err.id}: ${err.error}`);
      });
    }

    if (dryRun) {
      console.log(`\n⚠ This was a DRY RUN. No changes were made.`);
      console.log(`Run without --dry-run to apply changes.`);
    } else {
      console.log(`\n✓ Migration completed!`);
    }
  } catch (error: any) {
    console.error(`\n✗ Migration failed:`, error);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const projectArg = args.find(arg => arg.startsWith('--project='));
const project = projectArg ? projectArg.split('=')[1] : 'dev';

// Confirm if not dry-run
if (!dryRun) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question(`\n⚠ WARNING: This will modify your Firestore database!\nAre you sure you want to continue? (yes/no): `, (answer) => {
    rl.close();
    if (answer.toLowerCase() === 'yes') {
      runMigration(false, project).catch(console.error);
    } else {
      console.log('Migration cancelled.');
      process.exit(0);
    }
  });
} else {
  runMigration(true, project).catch(console.error);
}

