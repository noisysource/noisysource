import { useEffect, useMemo, useState } from 'react';
import { useEntity } from '../hooks/EntityContext';
import { api } from '../lib/api';
import { formatEUR } from '@shared/lib/money';
import { Card } from '../components/ui/card';
import type { RecurringEntryDoc } from '@shared/models/RecurringEntry';
import type { EcContractDoc } from '@shared/models/EcContract';
import type { KidclubBillingRecord } from '@shared/lib/eventGenerators';

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

// ── IVA calculation helpers ────────────────────────────────────────────────────

const KIDCLUB_IVA_RATE = 23; // NoisyPhocus charges 23% IVA

function recurringIvaInQuarter(
  entries: RecurringEntryDoc[],
  months: string[],
  type: 'income' | 'expense',
): { description: string; baseCents: number; ivaCents: number }[] {
  const result: { description: string; baseCents: number; ivaCents: number }[] = [];
  for (const e of entries) {
    if (e.type !== type) continue;
    if (!e.active) continue;
    const rate = e.ivaRatePct;
    if (!rate) continue;

    let baseCents = 0;
    for (const ym of months) {
      if (e.startYearMonth && ym < e.startYearMonth) continue;
      if (e.endYearMonth   && ym > e.endYearMonth)   continue;
      if (e.frequency === 'monthly')  { baseCents += e.amountCents; continue; }
      if (e.frequency === 'once' && e.onceYearMonth === ym) { baseCents += e.amountCents; continue; }
      if (e.frequency === 'quarterly') {
        // fires on month 1, 4, 7, 10 by default, or whichever quarter month matches dayOfMonth
        const [, m] = ym.split('-').map(Number);
        if ((m - 1) % 3 === 0) baseCents += e.amountCents;
        continue;
      }
      if (e.frequency === 'annual' && e.monthOfYear) {
        const [, m] = ym.split('-').map(Number);
        if (m === e.monthOfYear) baseCents += e.amountCents;
      }
    }
    if (!baseCents) continue;
    result.push({
      description: e.description,
      baseCents,
      ivaCents: Math.round(baseCents * rate / 100),
    });
  }
  return result;
}

function ecIvaInQuarter(
  contracts: EcContractDoc[],
  months: string[],
): { description: string; baseCents: number; ivaCents: number }[] {
  return contracts
    .filter(c => c.active && (c.ivaRatePct ?? 0) > 0)
    .map(c => {
      const rate = c.ivaRatePct!;
      let baseCents = 0;
      for (const ym of months) {
        const start = c.startDate ? new Date(c.startDate as any).toISOString().slice(0, 7) : null;
        const end   = c.endDate   ? new Date(c.endDate   as any).toISOString().slice(0, 7) : null;
        if (start && ym < start) continue;
        if (end   && ym > end)   continue;
        baseCents += c.dailyRateCents * c.expectedDaysPerMonth;
      }
      return {
        description: `${c.clientName}${c.projectName ? ` — ${c.projectName}` : ''}`,
        baseCents,
        ivaCents: Math.round(baseCents * rate / 100),
      };
    })
    .filter(r => r.baseCents > 0);
}

function kidclubIvaInQuarter(
  billing: KidclubBillingRecord[],
  months: string[],
): { description: string; baseCents: number; ivaCents: number }[] {
  const paid = billing.filter(r => {
    if (!['paid', 'invoiced'].includes(r.status)) return false;
    const date = (r.paidAt ?? r.dueDate).toDate();
    const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    return months.includes(ym);
  });

  const totalCents = Math.round(paid.reduce((s, r) => s + r.total, 0) * 100);
  if (!totalCents) return [];

  const ivaCents = Math.round(totalCents * KIDCLUB_IVA_RATE / (100 + KIDCLUB_IVA_RATE));
  const baseCents = totalCents - ivaCents;
  return [{ description: `KidClub — subscrições (${paid.length} registos)`, baseCents, ivaCents }];
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function IvaTable({
  title, color, rows,
}: {
  title: string;
  color: 'red' | 'green';
  rows: { description: string; baseCents: number; ivaCents: number }[];
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
            <span className="text-zinc-400 flex-1 truncate pr-3">{r.description}</span>
            <span className="text-zinc-500 tabular-nums mr-3">{formatEUR(r.baseCents / 100)}</span>
            <span className={`tabular-nums font-medium ${color === 'green' ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatEUR(r.ivaCents / 100)}
            </span>
          </div>
        ))}
        <div className="flex justify-between text-xs font-semibold pt-1">
          <span className="text-zinc-300">Total IVA</span>
          <span className={color === 'green' ? 'text-emerald-300' : 'text-red-300'}>
            {formatEUR(totalIva / 100)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function VatPage() {
  const { selectedEntity } = useEntity();
  const entityId = selectedEntity.id;

  const [recurring, setRecurring]   = useState<RecurringEntryDoc[]>([]);
  const [ecContracts, setEcContracts] = useState<EcContractDoc[]>([]);
  const [billing, setBilling]       = useState<KidclubBillingRecord[]>([]);
  const [loading, setLoading]       = useState(true);

  const quarters = useMemo(() => lastQuarters(5), []);
  const [selQ, setSelQ] = useState<{ year: number; q: number }>(quarters[0]);

  useEffect(() => {
    setLoading(true);
    api.setEntity(entityId);
    const loaders: Promise<any>[] = [
      api.recurring.list().then(setRecurring),
    ];
    if (entityId === 'noisysource') {
      loaders.push(api.ecContracts.list().then(setEcContracts));
    }
    if (entityId === 'noisyphocus') {
      loaders.push(api.kidclub.listBilling().then(setBilling));
    }
    Promise.all(loaders).finally(() => setLoading(false));
  }, [entityId]);

  const months = useMemo(() => quarterMonths(selQ.year, selQ.q), [selQ]);

  const collectedRows = useMemo(() => {
    const rows = recurringIvaInQuarter(recurring, months, 'income');
    if (entityId === 'noisysource') rows.push(...ecIvaInQuarter(ecContracts, months));
    if (entityId === 'noisyphocus') rows.push(...kidclubIvaInQuarter(billing, months));
    return rows;
  }, [recurring, ecContracts, billing, months, entityId]);

  const deductibleRows = useMemo(() =>
    recurringIvaInQuarter(recurring, months, 'expense'),
    [recurring, months]
  );

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
          {/* Net summary */}
          <Card className="p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-xs text-zinc-400 mb-1">IVA liquidado</div>
                <div className="text-lg font-bold text-emerald-400">{formatEUR(totalCollected / 100)}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">IVA dedutível</div>
                <div className="text-lg font-bold text-red-400">{formatEUR(totalDeductible / 100)}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">{net >= 0 ? 'A pagar AT' : 'A recuperar'}</div>
                <div className={`text-lg font-bold ${net >= 0 ? 'text-amber-400' : 'text-blue-400'}`}>
                  {formatEUR(Math.abs(net) / 100)}
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
          </Card>

          {collectedRows.length === 0 && deductibleRows.length === 0 && (
            <div className="text-center text-zinc-500 text-sm py-6">
              <div>Nenhuma entrada tem taxa de IVA configurada.</div>
              <div className="text-xs mt-1">
                Edita as entradas em Recorrentes ou em Contratos EC para adicionar a taxa de IVA.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
