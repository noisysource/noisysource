import { useEffect, useMemo, useState } from "react";
import type { KidclubBillingRecord } from "@shared/lib/eventGenerators";
import { formatEUR } from "@shared/lib/money";
import { api } from "../lib/api";

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function ymLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return `${months[parseInt(m) - 1]} ${y}`;
}
function recDate(rec: KidclubBillingRecord): Date {
  if ((rec.status === 'paid' || rec.status === 'invoiced') && rec.paidAt) return rec.paidAt.toDate();
  return rec.dueDate.toDate();
}
function recYM(rec: KidclubBillingRecord): string {
  const d = recDate(rec);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const STATUS_LABEL: Record<string, string> = {
  paid: 'Pago', invoiced: 'Faturado', pending: 'Pendente',
  processing: 'Em processamento', failed: 'Falhou', cancelled: 'Cancelado', 'dry-run': 'Teste',
};
const STATUS_COLOR: Record<string, string> = {
  paid: 'text-emerald-400 bg-emerald-950/40 border-emerald-800/60',
  invoiced: 'text-blue-400 bg-blue-950/40 border-blue-800/60',
  pending: 'text-amber-400 bg-amber-950/40 border-amber-800/60',
  processing: 'text-purple-400 bg-purple-950/40 border-purple-800/60',
  failed: 'text-red-400 bg-red-950/40 border-red-800/60',
  cancelled: 'text-zinc-500 bg-zinc-900 border-zinc-700',
  'dry-run': 'text-zinc-500 bg-zinc-900 border-zinc-700',
};

interface MonthAggregate {
  ym: string;
  confirmedCents: number;  // paid + invoiced
  pendingCents: number;    // pending + processing
  totalCents: number;
  count: number;
}

export default function NoisyPhocusRevenuePage() {
  const [records, setRecords] = useState<KidclubBillingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedYM, setSelectedYM] = useState<string | null>(null);

  useEffect(() => {
    api.kidclub.listBilling()
      .then(setRecords)
      .finally(() => setLoading(false));
  }, []);

  const months = useMemo((): MonthAggregate[] => {
    const map = new Map<string, MonthAggregate>();
    for (const rec of records) {
      if (rec.status === 'cancelled' || rec.status === 'failed' || rec.status === 'dry-run') continue;
      const ym = recYM(rec);
      if (!map.has(ym)) map.set(ym, { ym, confirmedCents: 0, pendingCents: 0, totalCents: 0, count: 0 });
      const agg = map.get(ym)!;
      const cents = Math.round(rec.total * 100);
      if (rec.status === 'paid' || rec.status === 'invoiced') agg.confirmedCents += cents;
      else agg.pendingCents += cents;
      agg.totalCents += cents;
      agg.count++;
    }
    return [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([, v]) => v);
  }, [records]);

  const now = currentYM();
  const ytdConfirmed = useMemo(() =>
    months.filter(m => m.ym.startsWith(now.split('-')[0]) && m.ym <= now)
      .reduce((s, m) => s + m.confirmedCents, 0),
    [months, now],
  );
  const currentMonthPending = useMemo(() =>
    months.find(m => m.ym === now)?.pendingCents ?? 0,
    [months, now],
  );
  const allTimePaid = useMemo(() =>
    months.reduce((s, m) => s + m.confirmedCents, 0),
    [months],
  );

  const maxBar = Math.max(...months.map(m => m.totalCents), 1);

  const selectedRecords = useMemo(() => {
    if (!selectedYM) return [];
    return records
      .filter(r => recYM(r) === selectedYM && r.status !== 'cancelled' && r.status !== 'dry-run')
      .sort((a, b) => recDate(b).getTime() - recDate(a).getTime());
  }, [records, selectedYM]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Receitas KidClub</h2>
        <p className="text-sm text-zinc-400 mt-0.5">NoisyPhocus · leitura apenas · dados em direto do KidClub</p>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: `YTD ${now.split('-')[0]} (recebido)`, value: formatEUR(ytdConfirmed), color: 'text-emerald-400' },
          { label: `${ymLabel(now)} pendente`, value: formatEUR(currentMonthPending), color: 'text-amber-400' },
          { label: 'Total histórico recebido', value: formatEUR(allTimePaid), color: 'text-zinc-200' },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{s.label}</div>
            <div className={`text-lg font-bold tabular-nums ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>

      {loading && (
        <div className="text-sm text-zinc-500 text-center py-10">A carregar…</div>
      )}

      {!loading && months.length === 0 && (
        <div className="text-sm text-zinc-500 text-center py-10">Nenhum registo de faturação encontrado.</div>
      )}

      {/* Monthly chart */}
      {months.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Por mês</div>
          <div className="space-y-1.5">
            {months.map(m => {
              const confirmedPct = (m.confirmedCents / maxBar) * 100;
              const pendingPct   = (m.pendingCents / maxBar) * 100;
              const isSelected   = selectedYM === m.ym;
              const isCurrent    = m.ym === now;
              return (
                <button
                  key={m.ym}
                  onClick={() => setSelectedYM(isSelected ? null : m.ym)}
                  className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 border text-left transition-colors ${
                    isSelected ? 'border-emerald-700 bg-emerald-950/20'
                      : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
                  }`}
                >
                  <div className="w-20 shrink-0">
                    <div className="text-sm font-medium text-zinc-200">{ymLabel(m.ym)}</div>
                    {isCurrent && <div className="text-[10px] text-zinc-500">este mês</div>}
                  </div>
                  <div className="flex-1 flex flex-col gap-0.5">
                    {m.confirmedCents > 0 && (
                      <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${confirmedPct}%` }} />
                      </div>
                    )}
                    {m.pendingCents > 0 && (
                      <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                        <div className="h-full rounded-full bg-amber-500/70" style={{ width: `${pendingPct}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0 w-28">
                    {m.confirmedCents > 0 && (
                      <div className="text-sm font-semibold tabular-nums text-emerald-400">{formatEUR(m.confirmedCents)}</div>
                    )}
                    {m.pendingCents > 0 && (
                      <div className="text-xs tabular-nums text-amber-400">{formatEUR(m.pendingCents)} pendente</div>
                    )}
                  </div>
                  <div className="text-xs text-zinc-600 shrink-0 w-16 text-right">{m.count} reg.</div>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-4 text-xs text-zinc-500 px-1 pt-1">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" /> Recebido</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500/70 inline-block" /> Pendente</span>
          </div>
        </div>
      )}

      {/* Month detail */}
      {selectedYM && selectedRecords.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">
            {ymLabel(selectedYM)} — {selectedRecords.length} registos
          </div>
          <div className="space-y-1.5">
            {selectedRecords.map(rec => (
              <div key={rec.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{rec.periodLabel ?? rec.id}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {rec.status === 'paid' || rec.status === 'invoiced'
                      ? `Pago em ${recDate(rec).toLocaleDateString('pt-PT')}`
                      : `Vence em ${rec.dueDate.toDate().toLocaleDateString('pt-PT')}`}
                  </div>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${STATUS_COLOR[rec.status] ?? STATUS_COLOR['cancelled']}`}>
                  {STATUS_LABEL[rec.status] ?? rec.status}
                </span>
                <span className={`text-sm font-semibold tabular-nums shrink-0 ${
                  rec.status === 'paid' || rec.status === 'invoiced' ? 'text-emerald-400' : 'text-amber-400'
                }`}>
                  {formatEUR(Math.round(rec.total * 100))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
