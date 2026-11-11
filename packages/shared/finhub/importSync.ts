// packages/shared/finhub/importSync.ts
//
// What a re-import writes to an append-only log (HANDOFF-finhub-v2.md, "Event envelope":
// corrections are a `reversal` naming the wrong event, then a new event with a suffixed id).
// The importer builds every event again from its sources, each with its natural id; this compares
// them with what the log holds:
//
// - id not in the log → create it;
// - the version in force (`id`, or its latest `-rN` replacement not reversed) says the same → nothing;
// - it says something else and an importer recorded it → reverse it and add the next `-rN`;
// - a person recorded the version in force (a correction made in the app) → leave it, report it;
// - every version was reversed (someone cancelled it on purpose) → leave it, report it.
//
// Pure: the dev importer passes in what it built and what it read; nothing here writes.

import { reversalId, REVERSAL, type FinEvent } from './envelope';

export interface Correction<E> {
  /** The version in force now, to be reversed. */
  liveId: string;
  reversalId: string;
  replacement: E;
  /** Top-level payload fields that differ (names only, no values). */
  changed: string[];
}

export interface ImportPlan<E> {
  create: E[];
  corrections: Correction<E>[];
  unchanged: number;
  /** Ids whose version in force was recorded by a person: an import never replaces it. */
  keptManual: string[];
  /** Ids with every version reversed. */
  cancelled: string[];
}

/** JSON with sorted keys and without undefined: the same data always gives the same text. */
export function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

function changedFields(a: FinEvent, b: FinEvent): string[] {
  const out: string[] = [];
  if (a.type !== b.type) out.push('type');
  if (a.effectiveDate !== b.effectiveDate) out.push('effectiveDate');
  if ((a.note ?? '') !== (b.note ?? '')) out.push('note');
  const pa = (a.payload ?? {}) as Record<string, unknown>;
  const pb = (b.payload ?? {}) as Record<string, unknown>;
  for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    if (canonical(pa[k]) !== canonical(pb[k])) out.push(`payload.${k}`);
  }
  return out;
}

export function planImport<E extends FinEvent>(
  built: readonly E[],
  stored: readonly FinEvent[],
  opts: { isImporter: (e: FinEvent) => boolean; reversal: (o: { id: string; reverses: string; note: string }) => E },
): ImportPlan<E> & { reversals: E[] } {
  const byId = new Map(stored.map(e => [e.id, e]));
  const taken = new Set(byId.keys());
  const reversed = new Set(stored.filter(e => e.type === REVERSAL && e.reverses).map(e => e.reverses!));
  const plan: ImportPlan<E> & { reversals: E[] } = { create: [], corrections: [], unchanged: 0, keptManual: [], cancelled: [], reversals: [] };

  for (const b of built) {
    const chain: FinEvent[] = [];
    if (byId.has(b.id)) chain.push(byId.get(b.id)!);
    for (let n = 2; byId.has(`${b.id}-r${n}`); n++) chain.push(byId.get(`${b.id}-r${n}`)!);
    if (!chain.length) { plan.create.push(b); taken.add(b.id); continue; }

    const live = [...chain].reverse().find(e => !reversed.has(e.id));
    if (!live) { plan.cancelled.push(b.id); continue; }
    if (!opts.isImporter(live)) { plan.keptManual.push(b.id); continue; }
    const changed = changedFields(live, b);
    if (!changed.length) { plan.unchanged++; continue; }

    let n = 1;
    while (taken.has(reversalId(live.id, n))) n++;
    const revId = reversalId(live.id, n);
    let r = 2;
    while (taken.has(`${b.id}-r${r}`)) r++;
    const replacement = { ...b, id: `${b.id}-r${r}` };
    taken.add(revId);
    taken.add(replacement.id);
    plan.corrections.push({ liveId: live.id, reversalId: revId, replacement, changed });
    plan.reversals.push(opts.reversal({ id: revId, reverses: live.id, note: `Corrigido na importação: ${changed.join(', ')}; substituído por ${replacement.id}.` }));
  }
  return plan;
}
