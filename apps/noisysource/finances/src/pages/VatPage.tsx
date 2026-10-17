import { useEffect, useMemo, useState } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useEntity } from '../hooks/EntityContext';
import { api } from '../lib/api';
import { formatEUR } from '@shared/lib/money';
import { Card } from '../components/ui/card';
import type { RecurringEntryDoc } from '@shared/models/RecurringEntry';
import { recurringVatInMonths, type RecurringVatRow } from '../lib/recurringSchedule';
import { vatCodeLabel } from '@shared/lib/vat';

// ── Quarter helpers ────────────────────────────────────────────────────────────

function currentQuarter(): { year: number; q: number } {
  const now = new Date();
  return { year: now.getFullYear(), q: Math.floor(now.getMonth() / 3) + 1 };
}

function quarterMonths(year: number, q: number): string[] {
  const start = (q - 1) * 3 + 1;
  return [start, start + 1, start + 2].map(m => `${year}-${String(m).padStart(2, '0')}`);
}

function quarterDueDate(year: number, q: number): string {
  const dueMonth = [5, 8, 11, 2][q - 1];
  const dueYear  = q === 4 ? year + 1 : year;
  return `${dueYear}-${String(dueMonth).padStart(2, '0')}-15`;
}

function formatDue(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'long', year: 'numeric' });
}

function lastQuarters(n = 5): { year: number; q: number }[] {
  let { year, q } = currentQuarter();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ year, q });
    q--;
    if (q < 1) { q = 4; year--; }
  }
  return out;
}

// ── Vendus VAT summary types ───────────────────────────────────────────────────

interface VatByRate {
  [rate: number]: { baseCents: number; ivaCents: number };
}

interface KidclubVatResult {
  year: number;
  quarter: number;
  docCount: number;
  byRate: VatByRate;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function IvaTable({
  title, color, rows,
}: {
  title: string;
  color: 'red' | 'green';
  rows: RecurringVatRow[];
}) {
  const totalIva = rows.reduce((s, r) => s + r.ivaCents, 0);
  if (!rows.length) return (
    <div>
      <div className={`text-xs font-semibold mb-1 ${color === 'green' ? 'text-emerald-400' : 'text-red-400'}`}>{title}</div>
      <div className="text-xs text-zinc-600 italic">— sem entradas com IVA neste período —</div>
    </div>
  );

  return (
    <div>
      <div className={`text-xs font-semibold mb-2 ${color === 'green' ? 'text-emerald-400' : 'text-red-400'}`}>{title}</div>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-zinc-800/50">
            <span className="text-zinc-400 flex-1 truncate pr-3">
              {r.description}
              {r.vatCode !== undefined && <span className="text-zinc-600 ml-1.5">{vatCodeLabel(r.vatCode)}</span>}
            </span>
            <span className="text-zinc-500 tabular-nums mr-3">{formatEUR(r.baseCents)}</span>
            <span className={`tabular-nums font-medium ${color === 'green' ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatEUR(r.ivaCents)}
            </span>
          </div>
        ))}
        <div className="flex justify-between text-xs font-semibold pt-1">
          <span className="text-zinc-300">Total IVA</span>
          <span className={color === 'green' ? 'text-emerald-300' : 'text-red-300'}>
            {formatEUR(totalIva)}
          </span>
        </div>
      </div>
    </div>
  );
}

function UnconfirmedTable({ rows }: { rows: { description: string; amountCents: number; kind: string }[] }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="text-xs font-semibold mb-1 text-amber-400">IVA por confirmar — fora dos totais</div>
      <div className="text-[11px] text-zinc-500 mb-2">
        Guardadas antes da regra do IVA (ou sem taxa): não se sabe se o valor inclui IVA.
        Abre cada uma em Recorrentes, escolhe a taxa e guarda.
      </div>
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-zinc-800/50">
            <span className="text-zinc-400 flex-1 truncate pr-3">{r.description}</span>
            <span className="text-zinc-600 mr-3">{r.kind}</span>
            <span className="text-zinc-500 tabular-nums">{formatEUR(r.amountCents)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function VatPage() {
  const { selectedEntity } = useEntity();
  const entityId = selectedEntity.id;

  const [recurring, setRecurring] = useState<RecurringEntryDoc[]>([]);
  const [kidclubVat, setKidclubVat] = useState<KidclubVatResult | null>(null);
  const [kidclubLoading, setKidclubLoading] = useState(false);
  const [kidclubError, setKidclubError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Per-month KidClub processed-billing volume, only fetched for noisyphocus
  // when a commission-model recurring entry (e.g. EasyPay) actually needs it.
  const [volumeCentsByMonth, setVolumeCentsByMonth] = useState<Record<string, number>>({});

  const quarters = useMemo(() => lastQuarters(5), []);
  const [selQ, setSelQ] = useState<{ year: number; q: number }>(quarters[0]);

  useEffect(() => {
    setLoading(true);
    api.setEntity(entityId);
    api.recurring.list().then(setRecurring).finally(() => setLoading(false));
  }, [entityId]);

  // Fetch KidClub VAT from Vendus when quarter changes (noisyphocus only)
  useEffect(() => {
    if (entityId !== 'noisyphocus') return;
    setKidclubLoading(true);
    setKidclubError(null);
    setKidclubVat(null);
    const fn = httpsCallable<{ year: number; quarter: number }, KidclubVatResult>(
      getFunctions(undefined, 'europe-west3'),
      'getKidclubVatSummary',
    );
    fn({ year: selQ.year, quarter: selQ.q })
      .then(r => setKidclubVat(r.data))
      .catch(e => setKidclubError(e?.message ?? 'Erro ao obter dados do Vendus'))
      .finally(() => setKidclubLoading(false));
  }, [entityId, selQ.year, selQ.q]);

  const months = useMemo(() => quarterMonths(selQ.year, selQ.q), [selQ]);

  // Fetch KidClub processed-billing volume for each month of the quarter,
  // only when noisyphocus has at least one commission-model recurring entry
  // (avoids an unnecessary cross-app read otherwise).
  useEffect(() => {
    if (entityId !== 'noisyphocus') { setVolumeCentsByMonth({}); return; }
    const needsVolume = recurring.some(e => e.costModel === 'commission');
    if (!needsVolume) { setVolumeCentsByMonth({}); return; }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        months.map(async ym => [ym, await api.kidclub.monthlyProcessedVolumeCents(ym)] as const),
      );
      if (!cancelled) setVolumeCentsByMonth(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [entityId, recurring, months]);

  const incomeVat = useMemo(
    () => recurringVatInMonths(recurring, months, 'income', volumeCentsByMonth),
    [recurring, months, volumeCentsByMonth],
  );
  const expenseVat = useMemo(
    () => recurringVatInMonths(recurring, months, 'expense', volumeCentsByMonth),
    [recurring, months, volumeCentsByMonth],
  );

  // IVA liquidado rows
  const collectedRows = useMemo(() => {
    const rows: RecurringVatRow[] = [...incomeVat.rows];

    // NoisyPhocus: add KidClub rows from Vendus (one row per VAT rate)
    if (entityId === 'noisyphocus' && kidclubVat) {
      const RATE_LABELS: Record<number, string> = { 23: 'NOR 23%', 6: 'RED 6%', 0: 'ISE 0%' };
      for (const [rateStr, amounts] of Object.entries(kidclubVat.byRate)) {
        const rate = Number(rateStr);
        if (amounts.ivaCents === 0) continue;
        rows.push({
          description: `KidClub — ${RATE_LABELS[rate] ?? `${rate}%`} (${kidclubVat.docCount} faturas)`,
          baseCents: amounts.baseCents,
          ivaCents: amounts.ivaCents,
        });
      }
    }

    return rows;
  }, [incomeVat, entityId, kidclubVat]);

  const deductibleRows = expenseVat.rows;
  const unconfirmedRows = useMemo(() => [
    ...incomeVat.unconfirmed.map(r => ({ ...r, kind: 'rendimento' })),
    ...expenseVat.unconfirmed.map(r => ({ ...r, kind: 'despesa' })),
  ], [incomeVat, expenseVat]);

  const totalCollected  = collectedRows.reduce((s, r)  => s + r.ivaCents, 0);
  const totalDeductible = deductibleRows.reduce((s, r) => s + r.ivaCents, 0);
  const net = totalCollected - totalDeductible;

  const dueDate = quarterDueDate(selQ.year, selQ.q);

  if (entityId === 'private') {
    return (
      <div className="max-w-xl mx-auto pt-12 text-center text-zinc-500">
        <div className="text-3xl mb-3">🧾</div>
        <div>IVA não aplicável à entidade Privado.</div>
        <div className="text-sm mt-1">Seleciona NoisySource ou NoisyPhocus.</div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold">IVA</h1>
        <p className="text-xs text-zinc-500 mt-0.5">{selectedEntity.name} — posição trimestral</p>
      </div>

      {/* Quarter tabs */}
      <div className="flex gap-1 flex-wrap">
        {quarters.map(q => {
          const active = q.year === selQ.year && q.q === selQ.q;
          return (
            <button key={`${q.year}-${q.q}`}
              onClick={() => setSelQ(q)}
              className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                active
                  ? 'border-blue-500 bg-blue-900/40 text-blue-200'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
              }`}>
              T{q.q} {q.year}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="text-zinc-500 text-sm">A carregar...</div>
      ) : (
        <>
          {kidclubLoading && (
            <div className="text-zinc-500 text-xs flex items-center gap-2">
              <span className="animate-spin">⟳</span> A consultar Vendus…
            </div>
          )}
          {kidclubError && (
            <div className="text-red-400 text-xs bg-red-950/30 px-3 py-2 rounded">
              Erro Vendus: {kidclubError}
            </div>
          )}

          {/* Net summary */}
          <Card className="p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-xs text-zinc-400 mb-1">IVA liquidado</div>
                <div className="text-lg font-bold text-emerald-400">{formatEUR(totalCollected)}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">IVA dedutível</div>
                <div className="text-lg font-bold text-red-400">{formatEUR(totalDeductible)}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">{net >= 0 ? 'A pagar AT' : 'A recuperar'}</div>
                <div className={`text-lg font-bold ${net >= 0 ? 'text-amber-400' : 'text-blue-400'}`}>
                  {formatEUR(Math.abs(net))}
                </div>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-zinc-800 text-center text-xs text-zinc-500">
              Prazo de entrega: <span className="text-zinc-300">{formatDue(dueDate)}</span>
            </div>
          </Card>

          <Card className="p-4 space-y-5">
            <IvaTable title="IVA liquidado (cobrado)" color="green" rows={collectedRows} />
            <IvaTable title="IVA dedutível (pago em despesas)" color="red" rows={deductibleRows} />
            <UnconfirmedTable rows={unconfirmedRows} />
          </Card>

          {collectedRows.length === 0 && deductibleRows.length === 0 && unconfirmedRows.length === 0 && !kidclubLoading && (
            <div className="text-center text-zinc-500 text-sm py-6">
              <div>Nenhuma entrada tem taxa de IVA configurada.</div>
              {entityId === 'noisysource' && (
                <div className="text-xs mt-1">
                  Edita as entradas em Recorrentes para adicionar a taxa de IVA.
                  Contratos EC são isentos de IVA.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
