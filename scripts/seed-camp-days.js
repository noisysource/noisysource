#!/usr/bin/env node
/**
 * Script to seed Christmas Camp days
 * 
 * Usage:
 *   node scripts/seed-camp-days.js [--project=dev|prod] [--dry-run]
 * 
 * Options:
 *   --project=   : Firebase project (dev or prod, default: dev)
 *   --dry-run    : Show what would be created without making changes
 */

const admin = require('firebase-admin');
const path = require('path');
const readline = require('readline');

const campDays = [
  {
    date: '2024-12-17',
    name: 'Arco-Íris de Natal',
    morning: 'Jogos e brincadeiras de integração',
    lunch: 'Arco-Iris 12:30 - 14:00',
    afternoon: 'Manualidades de Natal (Fazer enfeites e cartões de natal)',
    capacity: 20,
    price: 20.00,
    active: true,
  },
  {
    date: '2024-12-18',
    name: 'A Cozinha do Pai Natal',
    morning: 'Workshop Bombons Chocolate e Salame',
    lunch: 'Arco-Iris 12:30 - 14:00',
    afternoon: 'Decorar Arvore de Natal Filme de Natal',
    capacity: 20,
    price: 20.00,
    active: true,
  },
  {
    date: '2024-12-19',
    name: 'Castelo Mágico',
    morning: 'Grupo 1 (7) - sai às 10h00 Grupo 2 (7) - sai as 11h00',
    lunch: 'Pic-Nic (pais) sobremesa : Salame',
    afternoon: 'Grupo 1(7) - regressa as 16h30 Grupo 2 (7) - regressa as 17h30',
    capacity: 20,
    price: 25.00,
    active: true,
  },
  {
    date: '2024-12-22',
    name: 'Perlim Mágico',
    morning: 'Perlim saida as 9h30',
    lunch: 'Pic-Nic (pais)',
    afternoon: 'Perlim chegada as 18h30',
    capacity: 20,
    price: 25.00,
    active: true,
  },
  {
    date: '2024-12-23',
    name: 'Descobertas mágicas',
    morning: 'Choupal Descobre o tesouro mágico',
    lunch: 'Arco-Iris 12:30 - 14:00',
    afternoon: 'Caça aos duendes no parque verde',
    capacity: 20,
    price: 20.00,
    active: true,
  },
  {
    date: '2024-12-24',
    name: 'Play time',
    morning: 'Convivio Livre no arco-iris ou Filme de Natal',
    lunch: 'Arco-Iris 12:30 - 14:00',
    afternoon: '',
    capacity: 15,
    price: 10.00,
    active: true,
  },
  {
    date: '2024-12-26',
    name: 'Natal Solidário',
    morning: 'Brincadeiras - Livres Preparação',
    lunch: 'Arco-Iris 12:30 - 14:00',
    afternoon: 'Mercadinho de Natal 14h às 19h',
    capacity: 20,
    price: 20.00,
    active: true,
  },
  {
    date: '2024-12-29',
    name: 'Planeta Aquarela',
    morning: 'Grupo 1 - Planeta Aquarela (09:30-12:30) Grupo 2 - Arco Iris - Jogos livres',
    lunch: 'Arco-Iris - 13h-14h',
    afternoon: 'Grupo 1 - Arco Iris - Jogos livres Grupo 2 - Planeta Aquarela (14:30-16:30)',
    capacity: 20,
    price: 25.00,
    active: true,
  },
  {
    date: '2024-12-30',
    name: 'Play time',
    morning: 'Jogos e Brincadeiras - Arco Iris (Arvore dos desejos - 2026)',
    lunch: 'Arco-Iris - 13h-14h',
    afternoon: 'Filme de Natal e Brincadeiras',
    capacity: 20,
    price: 20.00,
    active: true,
  },
];

async function seedCampDays(dryRun, project) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Seed Christmas Camp Days`);
  console.log(`Project: ${project}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (days will be created)'}`);
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
  } catch (error) {
    console.error(`\n✗ Error initializing Firebase Admin:`);
    console.error(`  Could not load service account: ${serviceAccountPath}`);
    console.error(`  Error: ${error.message}`);
    process.exit(1);
  }

  const db = admin.firestore();
  const stats = {
    created: 0,
    skipped: 0,
    errors: [],
  };

  try {
    console.log('📋 Seeding camp days...\n');

    for (const dayData of campDays) {
      try {
        // Check if day already exists (by date)
        const existingDays = await db.collection('campDays')
          .where('date', '==', dayData.date)
          .limit(1)
          .get();

        if (!existingDays.empty) {
          console.log(`  ⚠ Day ${dayData.date} (${dayData.name}) already exists - skipping`);
          stats.skipped++;
          continue;
        }

        if (dryRun) {
          console.log(`  [DRY-RUN] Would create: ${dayData.date} - ${dayData.name} (€${dayData.price})`);
          stats.created++;
        } else {
          await db.collection('campDays').add({
            ...dayData,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`  ✓ Created: ${dayData.date} - ${dayData.name} (€${dayData.price})`);
          stats.created++;
        }
      } catch (error) {
        stats.errors.push({ date: dayData.date, name: dayData.name, error: error.message });
        console.error(`  ✗ Error creating ${dayData.date} (${dayData.name}):`, error.message);
      }
    }

    // Print summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('Summary');
    console.log(`${'='.repeat(60)}`);
    console.log(`Days Created:  ${stats.created}`);
    console.log(`Days Skipped:  ${stats.skipped}`);
    console.log(`Errors:        ${stats.errors.length}`);
    
    if (stats.errors.length > 0) {
      console.log(`\nErrors encountered:`);
      stats.errors.forEach(err => {
        console.log(`  - ${err.date} (${err.name}): ${err.error}`);
      });
    }

    if (dryRun) {
      console.log(`\n⚠ This was a DRY RUN. No changes were made.`);
      console.log(`Run without --dry-run to create days.`);
    } else {
      console.log(`\n✓ Seeding completed!`);
    }
  } catch (error) {
    console.error(`\n✗ Script failed:`, error);
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

  rl.question(`\n⚠ WARNING: This will create camp days in Firestore!\nAre you sure you want to continue? (yes/no): `, (answer) => {
    rl.close();
    if (answer.toLowerCase() === 'yes') {
      seedCampDays(false, project).catch(console.error);
    } else {
      console.log('Operation cancelled.');
      process.exit(0);
    }
  });
} else {
  seedCampDays(true, project).catch(console.error);
}

