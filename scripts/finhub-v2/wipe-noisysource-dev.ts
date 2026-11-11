/**
 * FinHub v2 — wipes NoisySource's event log on kidclub-dev ONLY (finhub/noisysource/events).
 * Flagged for human review. The rules deny deletes from the app, so this uses your gcloud
 * session (IAM), like the importer. Refuses any project but kidclub-dev; never touches anything
 * outside finhub/noisysource/events (finances_entities and the rest of dev are left alone).
 *
 *   node scripts/finhub-v2/run.mjs scripts/finhub-v2/wipe-noisysource-dev.ts          # dry run: counts
 *   node scripts/finhub-v2/run.mjs scripts/finhub-v2/wipe-noisysource-dev.ts --write  # delete them
 */
import { deleteEvents, DEV_PROJECT, listEventIds, requireDevProject } from './lib/firestoreDev';

const args = process.argv.slice(2);
requireDevProject(args);

async function main() {
  const ids = await listEventIds();
  console.log(`${DEV_PROJECT} finhub/noisysource/events: ${ids.length} events.`);
  if (!args.includes('--write')) { console.log('Dry run: nothing deleted. Add --write to delete them all.'); return; }
  const n = await deleteEvents(ids);
  console.log(`Deleted ${n} events from ${DEV_PROJECT}.`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
