/**
 * FinHub v2 — NoisySource 2026 importer, DEV ONLY (HANDOFF-finhub-v2.md, "Acceptance: rebuild 2026").
 * Flagged for human review: it writes real 2026 values to kidclub-dev, and nowhere else.
 *
 * Reads the local documents in the main checkout's gitignored prodata/ (never copies them):
 *   finhub-seed.json, finhub-v2-noisysource.json, Recibs/<company NIF>_RC_2026_M<mm>P1_F.pdf,
 *   extratos noisySource/Extrato_Conta_2026-*.pdf
 * builds NoisySource's events (scripts/finhub-v2/lib/buildNoisySource.ts), validates every one,
 * compares them with what dev holds (packages/shared/finhub/importSync.ts), runs the self-check on
 * the result, and writes to kidclub-dev: finhub/noisysource/events/{id}
 *   - events that don't exist yet;
 *   - corrections: when an imported event's source changed (e.g. a value in
 *     finhub-v2-noisysource.json), a `reversal` of the version in force plus a `-rN` replacement.
 *     Nothing is overwritten, and a version a person recorded in the app is never replaced.
 *
 * - Refuses any project but kidclub-dev (`--project` other than kidclub-dev exits; every URL and
 *   document path is checked in lib/firestoreDev.ts). Never touches finances_entities.
 * - Dry run by default: prints counts and the self-check, writes nothing.
 * - Idempotent: deterministic ids; an unchanged event is skipped, and each create carries the
 *   precondition exists=false, so nothing is ever overwritten.
 *
 *   node scripts/finhub-v2/run.mjs scripts/finhub-v2/import-noisysource-dev.ts            # dry run
 *   node scripts/finhub-v2/run.mjs scripts/finhub-v2/import-noisysource-dev.ts --write    # write to kidclub-dev
 *   add --amounts to print euro amounts in the self-check (local console only)
 *   add --offline to skip reading dev's existing ids (dry run without network)
 *
 * Auth: `gcloud auth print-access-token` (your gcloud session), header x-goog-user-project.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractPdfTextItems, groupTextLines, parseBpiPdfLines } from '../../apps/noisysource/finances/src/lib/parsers/bpiPdf';
import { todayInLisbon } from '../../packages/shared/finhub/dates';
import { planImport } from '../../packages/shared/finhub/importSync';
import { buildNsEvent, parseNsEvent, type NsEvent } from '../../packages/shared/finhub/noisysource/events';
import { buildNoisySourceEvents, IMPORTER, type SourcePayslip, type SourceStatement } from './lib/buildNoisySource';
import { createEvents, DEV_PROJECT, listEvents, requireDevProject } from './lib/firestoreDev';
import { parsePayslipLines } from './lib/payslipPdf';
import { monthsOf2026, selfCheck } from './lib/selfCheck';

const args = process.argv.slice(2);
requireDevProject(args);
const WRITE = args.includes('--write');
const AMOUNTS = args.includes('--amounts');
const OFFLINE = args.includes('--offline');
if (WRITE && OFFLINE) { console.error('--write needs dev: drop --offline.'); process.exit(1); }

const PRODATA = resolve(execSync('git rev-parse --path-format=absolute --git-common-dir', { encoding: 'utf8' }).trim(), '..', 'prodata');

async function main() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const textLines = async (file: string) => groupTextLines(await extractPdfTextItems(readFileSync(file), pdfjs as never));

  const seed = JSON.parse(readFileSync(join(PRODATA, 'finhub-seed.json'), 'utf8'));
  const inputs = JSON.parse(readFileSync(join(PRODATA, 'finhub-v2-noisysource.json'), 'utf8'));

  // Statements: NoisySource's BPI account, 2026.
  const stmtDir = join(PRODATA, 'extratos noisySource');
  const statements: SourceStatement[] = [];
  for (const f of readdirSync(stmtDir).filter(f => /^Extrato_Conta_2026-.*\.pdf$/.test(f)).sort()) {
    statements.push({ file: f, statement: parseBpiPdfLines(await textLines(join(stmtDir, f))) });
  }
  const ibanDigits = String(seed.entities.noisysource.accounts.find((a: { key: string }) => a.key === inputs.accountId)?.iban ?? '').replace(/\D/g, '');
  for (const s of statements) {
    const acct = s.statement.accountNumber.replace(/\D/g, '');
    if (!acct || !ibanDigits.includes(acct.slice(1, 8))) throw new Error(`${s.file}: not ${inputs.accountId}'s statement`);
  }

  // Payslips: NoisySource's 2026 runs; byte-identical copies ("… (1).pdf") are skipped.
  const payDir = join(PRODATA, 'Recibs');
  const hashes = new Map<string, string>();
  const payslips: SourcePayslip[] = [];
  let duplicates = 0;
  for (const f of readdirSync(payDir).filter(f => /^\d{9}_RC_2026_M\d\dP1_F.*\.pdf$/.test(f)).sort()) {
    const buf = readFileSync(join(payDir, f));
    const h = createHash('sha256').update(buf).digest('hex');
    if (hashes.has(h)) { duplicates++; continue; }
    hashes.set(h, f);
    try {
      for (const p of parsePayslipLines(await textLines(join(payDir, f)))) payslips.push({ file: f, payslip: p });
    } catch (e) {
      throw new Error(`${f}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const now = new Date().toISOString();
  const { events, errors, notes } = buildNoisySourceEvents(seed, inputs, statements, payslips, now);
  console.log(`Read: ${statements.length} statements, ${payslips.length} payslips (${duplicates} duplicate file skipped).`);
  if (errors.length) {
    console.error(`\n${errors.length} problem(s), nothing written:\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  for (const n of notes) console.log(`note: ${n}`);

  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  console.log(`\nBuilt ${events.length} events:`);
  for (const [t, n] of [...byType.entries()].sort()) console.log(`  ${t.padEnd(26)} ${n}`);

  const lastStatementMonth = statements.map(s => s.statement.dateTo).sort().pop()!.slice(0, 7);

  // What dev holds now (offline: nothing).
  const stored: NsEvent[] = [];
  if (!OFFLINE) {
    for (const raw of await listEvents()) {
      const r = parseNsEvent(raw);
      if (!r.ok) { console.error(`${DEV_PROJECT} holds an invalid event ${r.id}: ${r.error}. Nothing written.`); process.exit(1); }
      stored.push(r.event);
    }
  }
  const plan = planImport(events, stored, {
    isImporter: e => e.recordedBy.startsWith('importer:'),
    reversal: o => buildNsEvent('reversal', {}, { id: o.id, reverses: o.reverses, note: o.note, source: 'import:seed', recordedBy: IMPORTER, recordedAt: now }) as unknown as NsEvent,
  });
  const replacements = plan.corrections.map(c => c.replacement);
  const after = [...stored, ...plan.create, ...plan.reversals, ...replacements];

  const check = selfCheck(after, { today: todayInLisbon(), accountId: inputs.accountId, amounts: AMOUNTS, months: monthsOf2026(lastStatementMonth) });
  console.log(`\nSelf-check (${check.ok ? 'contract chain and EC days pass' : 'FAILURES above'}):\n${check.lines.join('\n')}`);

  console.log(`\n${OFFLINE ? 'offline (dev not read)' : `${DEV_PROJECT} finhub/noisysource/events: ${stored.length} there`}; `
    + `${plan.create.length} new, ${plan.corrections.length} corrections, ${plan.unchanged} unchanged.`);
  for (const c of plan.corrections) console.log(`  correct ${c.liveId} → ${c.replacement.id} (reversal ${c.reversalId}): ${c.changed.join(', ')}`);
  if (plan.keptManual.length) console.log(`  kept, recorded in the app: ${plan.keptManual.join(', ')}`);
  if (plan.cancelled.length) console.log(`  kept, every version reversed: ${plan.cancelled.join(', ')}`);
  if (OFFLINE) { console.log('Offline dry run: nothing written.'); return; }
  if (!WRITE) { console.log('Dry run: nothing written. Add --write to write them.'); return; }
  if (!check.ok) { console.error('Self-check failed: not writing.'); process.exit(1); }
  const written = await createEvents([...plan.create, ...plan.reversals, ...replacements] as never);
  console.log(`Wrote ${written} events to ${DEV_PROJECT}.`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
