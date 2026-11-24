import { useEffect, useState } from 'react';
import { Pencil, Trash2, Plus, Check, X } from 'lucide-react';
import { Closure, ClosureSaveResult, closuresService } from '../../lib/closures';
import { reportClientError } from '../../lib/clientErrors';

/**
 * Club-wide closures (Renato, 2026-11-24): date ranges in which KidClub is
 * closed for everyone, e.g. 16-31 December.
 *
 * Every change is saved at once through the setClubClosures callable, because
 * saving is what applies it: each study day and transport trip inside a
 * closure becomes a "closed" day for every family, their open bills are
 * recomputed with the closure's credit (the typed percentage of the month, or
 * the share of the month's real days), and days of a removed or shortened
 * closure are put back.
 * That touches every family, so a save can take up to a minute; the panel
 * says so and then reports what changed.
 */

const fmtDay = (iso: string) =>
  new Date(`${iso}T12:00`).toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' });

const rangeText = (c: { from: string; to: string }) =>
  c.from === c.to ? fmtDay(c.from) : `${fmtDay(c.from)} a ${fmtDay(c.to)}`;

interface Draft { id: string | null; from: string; to: string; label: string; percent: string }

const EMPTY: Draft = { id: null, from: '', to: '', label: '', percent: '' };

// "50", "12,5" or blank. Returns undefined for blank, NaN for anything unusable.
const parsePercent = (text: string): number | undefined => {
  const t = text.trim().replace(',', '.');
  return t === '' ? undefined : Number(t);
};

const creditText = (c: Closure) =>
  c.percent !== undefined ? `crédito de ${c.percent}% do mês` : 'crédito pelos dias encerrados';

function resultText(r: ClosureSaveResult): string {
  const parts: string[] = [];
  if (r.closed) parts.push(`${r.closed} dia(s)/viagem(ns) marcados como encerrados`);
  if (r.reopened) parts.push(`${r.reopened} repostos`);
  if (!parts.length) parts.push('nenhum dia alterado');
  parts.push(`${r.families} família(s) com a faturação recalculada`);
  return `Guardado: ${parts.join(', ')}.`;
}

export default function ClosuresPanel({ onChanged }: { onChanged?: () => void }) {
  const [closures, setClosures] = useState<Closure[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    closuresService.get().then(setClosures).catch(err => {
      reportClientError('[ClosuresPanel] load failed', err);
      setError('Não foi possível carregar os encerramentos.');
      setClosures([]);
    });
  }, []);

  const save = async (next: Closure[]) => {
    setSaving(true);
    setError(null);
    setMessage(null);
    setWarning(null);
    try {
      const result = await closuresService.save(next);
      setClosures(result.closures);
      setDraft(null);
      setMessage(resultText(result));
      if (result.failedFamilies.length) {
        setWarning(
          `${result.failedFamilies.length} família(s) não foram recalculadas. Os dias estão certos; `
          + 'use "Recalcular" em Faturação, ou guarde de novo, para atualizar as faturas.',
        );
      }
      onChanged?.();
    } catch (err: any) {
      reportClientError('[ClosuresPanel] save failed', err);
      setError(err?.message ?? 'Não foi possível guardar.');
    } finally {
      setSaving(false);
    }
  };

  const draftError = (d: Draft): string | null => {
    if (!d.from || !d.to) return 'Indique as duas datas.';
    if (d.to < d.from) return 'A data de fim é anterior à de início.';
    if (!d.label.trim()) return 'Indique uma descrição (por exemplo, "Férias de Natal").';
    const percent = parsePercent(d.percent);
    if (percent !== undefined) {
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return 'A percentagem tem de ser um número acima de 0 e até 100 (ou fique em branco).';
      if (d.from.slice(0, 7) !== d.to.slice(0, 7)) return 'Com percentagem, o encerramento tem de ficar dentro de um só mês. Crie um encerramento por mês.';
    }
    return null;
  };

  const submitDraft = () => {
    if (!draft || !closures) return;
    const problem = draftError(draft);
    if (problem) { setError(problem); return; }
    const entry: Closure = {
      id: draft.id ?? `c${Date.now().toString(36)}`,
      from: draft.from, to: draft.to, label: draft.label.trim(),
    };
    const percent = parsePercent(draft.percent);
    if (percent !== undefined) entry.percent = percent;
    save(draft.id ? closures.map(c => (c.id === draft.id ? entry : c)) : [...closures, entry]);
  };

  const remove = (c: Closure) => {
    if (!closures) return;
    const ok = window.confirm(
      `Remover o encerramento "${c.label}" (${rangeText(c)})?\n\n`
      + 'Os dias voltam a contar como dias de serviço e as faturas ainda em aberto são recalculadas.',
    );
    if (ok) save(closures.filter(x => x.id !== c.id));
  };

  return (
    <div className="mb-4 text-sm bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-amber-700">Encerramentos do KidClub</span>
        {!draft && closures && (
          <button onClick={() => { setDraft(EMPTY); setError(null); }} disabled={saving}
            className="inline-flex items-center gap-1 text-xs text-amber-700 hover:text-amber-900 disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" /> Adicionar
          </button>
        )}
      </div>
      <p className="text-xs text-amber-700/80 mt-0.5">
        Dias em que o KidClub está fechado para todos. Cada inscrição com dias (ou viagens) no encerramento
        recebe um crédito na fatura desse mês: a percentagem indicada, igual para todos, ou, em branco, os
        dias encerrados a dividir pelos dias que teria nesse mês. Não contam como faltas.
      </p>

      {closures === null && <p className="text-xs text-gray-500 mt-2">A carregar…</p>}
      {closures?.length === 0 && !draft && <p className="text-xs text-gray-500 mt-2">Nenhum encerramento definido.</p>}

      {closures && closures.length > 0 && (
        <ul className="mt-2 space-y-1">
          {closures.map(c => (
            <li key={c.id} className="flex items-center justify-between gap-2 bg-white/70 rounded px-2 py-1">
              <span className="text-gray-800">
                <span className="font-semibold">{c.label}</span>
                <span className="text-gray-500"> · {rangeText(c)} · {creditText(c)}</span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <button onClick={() => { setDraft({ id: c.id, from: c.from, to: c.to, label: c.label, percent: c.percent !== undefined ? String(c.percent) : '' }); setError(null); }}
                  disabled={saving} title="Editar" aria-label={`Editar ${c.label}`}
                  className="text-amber-500 hover:text-amber-700 disabled:opacity-50">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => remove(c)} disabled={saving} title="Remover" aria-label={`Remover ${c.label}`}
                  className="text-red-400 hover:text-red-600 disabled:opacity-50">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {draft && (
        <div className="mt-2 flex flex-wrap items-end gap-2 bg-white/70 rounded px-2 py-2">
          <label className="text-xs text-gray-600">
            De
            <input type="date" value={draft.from} disabled={saving}
              onChange={e => setDraft({ ...draft, from: e.target.value, to: draft.to || e.target.value })}
              className="block border border-gray-300 rounded px-2 py-0.5 text-sm text-gray-800" />
          </label>
          <label className="text-xs text-gray-600">
            Até (inclusive)
            <input type="date" value={draft.to} min={draft.from || undefined} disabled={saving}
              onChange={e => setDraft({ ...draft, to: e.target.value })}
              className="block border border-gray-300 rounded px-2 py-0.5 text-sm text-gray-800" />
          </label>
          <label className="text-xs text-gray-600 flex-1 min-w-[10rem]">
            Descrição
            <input type="text" value={draft.label} maxLength={60} placeholder="Férias de Natal" disabled={saving}
              onChange={e => setDraft({ ...draft, label: e.target.value })}
              className="block w-full border border-gray-300 rounded px-2 py-0.5 text-sm text-gray-800" />
          </label>
          <label className="text-xs text-gray-600 w-28" title="Percentagem do valor do mês a creditar a cada inscrição com dias neste encerramento. Em branco: crédito proporcional aos dias encerrados.">
            Crédito (% do mês)
            <input type="text" inputMode="decimal" value={draft.percent} placeholder="em branco" disabled={saving}
              onChange={e => setDraft({ ...draft, percent: e.target.value })}
              className="block w-full border border-gray-300 rounded px-2 py-0.5 text-sm text-gray-800" />
          </label>
          <button onClick={submitDraft} disabled={saving}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
            <Check className="w-3.5 h-3.5" /> {draft.id ? 'Guardar alteração' : 'Guardar'}
          </button>
          <button onClick={() => { setDraft(null); setError(null); }} disabled={saving}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-gray-500 hover:text-gray-700 disabled:opacity-50">
            <X className="w-3.5 h-3.5" /> Cancelar
          </button>
        </div>
      )}

      {saving && (
        <p className="text-xs text-amber-800 mt-2" aria-live="polite">
          A aplicar a todas as famílias e a recalcular as faturas em aberto. Pode demorar até um minuto…
        </p>
      )}
      {message && <p className="text-xs text-emerald-700 mt-2" aria-live="polite">{message}</p>}
      {warning && <p className="text-xs text-amber-800 mt-2">{warning}</p>}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
