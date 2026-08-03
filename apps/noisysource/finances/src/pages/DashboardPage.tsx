import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { EcContractDoc } from '@shared/models/EcContract';
import type { FinanceEvent, ComputedEvent } from '@shared/models/FinanceEvent';
import type { Account } from '@shared/models/Account';
import { computeEcProjection } from '@shared/lib/ecProjection';
import { generateEcEvents } from '@shared/lib/eventGenerators';
import { formatEUR } from '@shared/lib/money';
import { api } from '../lib/api';
import { Link } from 'react-router-dom';

// ── helpers ───────────────────────────────────────────────────────────────────

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function currentYM(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

function fmtYM(ym: string): string {
  const [y, m] = ym.split('-');
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });
}

function ymBounds(ym: string): [string, string] {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(y, m, 0).getDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}

function fmtBalance(cents: number): string {
  const val = cents / 100;
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 10000) return `${sign}€${Math.round(abs / 1000)}k`;
  if (abs >= 1000) return `${sign}€${(abs / 1000).toFixed(1)}k`;
  return `${sign}€${Math.round(abs)}`;
}

type DayKind = 'working' | 'half' | 'off' | 'weekend' | 'outside';

function dayKind(
  iso: string, start: string | undefined, end: string | undefined,
  nwd: Set<string>, half: Set<string>,
): DayKind {
  const dow = new Date(iso + 'T12:00:00').getDay();
  if (dow === 0 || dow === 6) return 'weekend';
  if ((start && iso < start) || (end && iso > end)) return 'outside';
  if (nwd.has(iso)) return 'off';
  if (half.has(iso)) return 'half';
  return 'working';
}

type AnyEvent = FinanceEvent | ComputedEvent;
type TaggedAccount = Account & { entityId: string };

function isComputed(e: AnyEvent): e is ComputedEvent {
  return (e as ComputedEvent).computed === true;
}

function eventKey(e: AnyEvent): string {
  return isComputed(e) ? e.key : e.id;
}

const ENTITY_LABEL: Record<string, string> = {
  noisysource: 'NS',
  private: 'PRV',
  noisyphocus: 'NP',
};

const EVENT_META: Record<string, { icon: string; bg: string; text: string; label: string }> = {
  ec_ts_submission: { icon: '📝', bg: 'bg-indigo-900/80',  text: 'text-indigo-200',  label: 'TS' },
  ec_payment:       { icon: '💰', bg: 'bg-emerald-900/80', text: 'text-emerald-200', label: 'Pgto' },
  salary_credit:    { icon: '🏦', bg: 'bg-blue-900/80',    text: 'text-blue-200',    label: 'Sal.' },
  income:           { icon: '↑',  bg: 'bg-green-900/80',   text: 'text-green-200',   label: 'Rec.' },
  expense:          { icon: '↓',  bg: 'bg-red-900/80',     text: 'text-red-200',     label: 'Desp.' },
  tax_payment:      { icon: '📋', bg: 'bg-orange-900/80',  text: 'text-orange-200',  label: 'IRS' },
  vacation:         { icon: '🏖', bg: 'bg-amber-900/80',   text: 'text-amber-200',   label: 'Férias' },
  transfer:         { icon: '⇄',  bg: 'bg-zinc-700',       text: 'text-zinc-300',    label: 'Transf.' },
  kidclub_revenue:  { icon: '🎨', bg: 'bg-purple-900/80',  text: 'text-purple-200',  label: 'KC' },
};

// ── component ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [contract, setContract] = useState<EcContractDoc | null>(null);
  const [storedEvents, setStoredEvents] = useState<FinanceEvent[]>([]);
  const [accounts, setAccounts] = useState<TaggedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [viewMonth, setViewMonth] = useState(currentYM());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showBalance, setShowBalance] = useState(false);

  const [nwd, setNwd] = useState<string[]>([]);
  const [half, setHalf] = useState<string[]>([]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestNwd = useRef<string[]>([]);
  const latestHalf = useRef<string[]>([]);
  const contractRef = useRef<EcContractDoc | null>(null);
  const contractEntityRef = useRef<string>('noisysource');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        // Find active EC contract across all entities
        let active: EcContractDoc | null = null;
        let contractEntity = 'noisysource';
        for (const entityId of ['noisysource', 'private', 'noisyphocus']) {
          api.setEntity(entityId);
          const list = await api.ecContracts.list();
          const found = list.find(c => c.active);
          if (found) { active = found; contractEntity = entityId; break; }
        }
        contractEntityRef.current = contractEntity;

        const events = await api.financeEvents.listAll();

        // Load accounts from all entities
        const allAccounts: TaggedAccount[] = [];
        for (const entityId of ['noisysource', 'private', 'noisyphocus']) {
          api.setEntity(entityId);
          const accs = await api.accounts.list();
          for (const a of accs) allAccounts.push({ ...a, entityId });
        }

        // Restore entity to the one holding the contract
        api.setEntity(contractEntity);

        setContract(active);
        contractRef.current = active;
        setAccounts(allAccounts);
        const n = active?.nonWorkingDays ?? [];
        const h = active?.halfDays ?? [];
        setNwd(n); latestNwd.current = n;
        setHalf(h); latestHalf.current = h;
        setStoredEvents(events.filter(e => e.status !== 'cancelled' && e.status !== 'corrected'));
      } catch (e) {
        console.error('[Dashboard] load failed:', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const nwdSet = useMemo(() => new Set(nwd), [nwd]);
  const halfSet = useMemo(() => new Set(half), [half]);
  const contractStart = contract?.startDate ? localIso(contract.startDate) : undefined;

  const projection = useMemo(() => {
    if (!contract?.startDate || !contract.totalDays || !contract.dailyRateCents) return null;
    try {
      return computeEcProjection(
        { startDate: localIso(contract.startDate), dailyRateCents: contract.dailyRateCents, totalDays: contract.totalDays },
        nwd, new Date(), half,
      );
    } catch { return null; }
  }, [contract, nwd, half]);

  const contractEnd = projection?.contractEndDate;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const computedEvents = useMemo(() => contract ? generateEcEvents(contract, new Date()) : [], [contract, nwd, half]);

  const [monthStart, monthEnd] = useMemo(() => ymBounds(viewMonth), [viewMonth]);

  const visibleEvents = useMemo((): AnyEvent[] => {
    const computed = computedEvents.filter(e => e.date >= monthStart && e.date <= monthEnd);
    const stored = storedEvents.filter(e => e.date >= monthStart && e.date <= monthEnd);
    return [...computed, ...stored].sort((a, b) => a.date.localeCompare(b.date));
  }, [computedEvents, storedEvents, monthStart, monthEnd]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, AnyEvent[]>();
    for (const e of visibleEvents) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date)!.push(e);
    }
    return map;
  }, [visibleEvents]);

  // Calendar grid
  const [viewYear, viewMonthIdx] = viewMonth.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(viewYear, viewMonthIdx, 0).getDate();
  let startDow = new Date(viewYear, viewMonthIdx - 1, 1).getDay();
  startDow = startDow === 0 ? 6 : startDow - 1;
  const cells: (string | null)[] = Array(startDow).fill(null);
  for (let d = 1; d <= daysInMonth; d++)
    cells.push(`${viewYear}-${String(viewMonthIdx).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7 !== 0) cells.push(null);

  const monthBreakdown = useMemo(
    () => projection?.monthBreakdown.find(mb => mb.yearMonth === viewMonth) ?? null,
    [projection, viewMonth],
  );

  const tsDay = useMemo(
    () => computedEvents.find(e => e.type === 'ec_ts_submission' && e.date >= monthStart && e.date <= monthEnd)?.date ?? null,
    [computedEvents, monthStart, monthEnd],
  );
  const paymentDay = useMemo(
    () => computedEvents.find(e => e.type === 'ec_payment' && e.date >= monthStart && e.date <= monthEnd)?.date ?? null,
    [computedEvents, monthStart, monthEnd],
  );

  const today = localIso(new Date());

  const confirmedSourceIds = useMemo(
    () => new Set(storedEvents.filter(e => e.status === 'confirmed').map(e => e.sourceId).filter(Boolean)),
    [storedEvents],
  );

  // ── balance timeline ───────────────────────────────────────────────────────

  const totalBaselineCents = useMemo(
    () => accounts.reduce((s, a) => s + (a.balanceCents ?? 0), 0),
    [accounts],
  );

  // Running projected balance for every day in the viewed month (confirmed + unconfirmed planned)
  const dailyBalances = useMemo((): Map<string, number> => {
    if (!showBalance) return new Map();
    const map = new Map<string, number>();
    for (const iso of cells.filter(Boolean) as string[]) {
      const confirmed = storedEvents.filter(e => e.date <= iso).reduce((s, e) => s + e.amountCents, 0);
      const planned = computedEvents
        .filter(e => e.date <= iso && !confirmedSourceIds.has(e.key))
        .reduce((s, e) => s + e.amountCents, 0);
      map.set(iso, totalBaselineCents + confirmed + planned);
    }
    return map;
  // cells is derived from viewMonth; viewMonth in deps is sufficient
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBalance, viewMonth, storedEvents, computedEvents, confirmedSourceIds, totalBaselineCents]);

  // Per-account breakdown for the selected day (for day-detail panel)
  const accountBalancesOnDay = useMemo(() => {
    if (!selectedDay || !accounts.length) return [];
    return accounts.map(a => {
      const confirmed = storedEvents
        .filter(e => e.date <= selectedDay && e.accountId === a.id)
        .reduce((s, e) => s + e.amountCents, 0);
      const planned = computedEvents
        .filter(e => e.date <= selectedDay && (e as any).accountId === a.id && !confirmedSourceIds.has(e.key))
        .reduce((s, e) => s + e.amountCents, 0);
      return { account: a, balance: (a.balanceCents ?? 0) + confirmed + planned };
    });
  }, [selectedDay, accounts, storedEvents, computedEvents, confirmedSourceIds]);

  // ── handlers ──────────────────────────────────────────────────────────────

  const triggerSave = useCallback((newNwd: string[], newHalf: string[]) => {
    latestNwd.current = newNwd;
    latestHalf.current = newHalf;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaving(true);
    saveTimer.current = setTimeout(async () => {
      const c = contractRef.current;
      if (!c) { setSaving(false); return; }
      try {
        api.setEntity(contractEntityRef.current);
        await api.ecContracts.save({
          id: c.id, clientName: c.clientName, projectName: c.projectName,
          dailyRateCents: c.dailyRateCents, totalDays: c.totalDays,
          expectedDaysPerMonth: c.expectedDaysPerMonth, startDate: c.startDate,
          active: c.active, daysToPayment: c.daysToPayment,
          nonWorkingDays: latestNwd.current.length ? latestNwd.current : undefined,
          halfDays: latestHalf.current.length ? latestHalf.current : undefined,
        });
      } catch (e) {
        console.error('[Dashboard] save failed:', e);
      } finally { setSaving(false); }
    }, 1200);
  }, []);

  const handleDayClick = useCallback((iso: string) => {
    setSelectedDay(iso);
  }, []);

  const handleDayStateChange = useCallback((iso: string, newKind: 'working' | 'half' | 'off') => {
    let newNwd = latestNwd.current.filter(d => d !== iso);
    let newHalf = latestHalf.current.filter(d => d !== iso);
    if (newKind === 'off') newNwd = [...newNwd, iso].sort();
    else if (newKind === 'half') newHalf = [...newHalf, iso].sort();
    setNwd(newNwd); setHalf(newHalf);
    triggerSave(newNwd, newHalf);
  }, [triggerSave]);

  const confirmPayment = useCallback(async (event: ComputedEvent) => {
    if (confirming) return;
    setConfirming(true);
    try {
      await api.financeEvents.save({
        entityId: event.entityId,
        type: event.type,
        date: event.date,
        amountCents: event.amountCents,
        status: 'confirmed',
        description: event.description,
        accountId: event.accountId,
        sourceType: event.sourceType,
        sourceId: event.key,
        metadata: event.metadata,
      });
      const events = await api.financeEvents.listAll();
      setStoredEvents(events.filter(e => e.status !== 'cancelled' && e.status !== 'corrected'));
    } catch (e) {
      console.error('[Dashboard] confirmPayment failed:', e);
    } finally {
      setConfirming(false);
    }
  }, [confirming]);

  const prevMonth = () => setViewMonth(m => {
    const [y, mo] = m.split('-').map(Number) as [number, number];
    return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  });
  const nextMonth = () => setViewMonth(m => {
    const [y, mo] = m.split('-').map(Number) as [number, number];
    return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  });

  // ── render ────────────────────────────────────────────────────────────────

  if (loading) return <div className="text-zinc-500 p-8">A carregar...</div>;

  if (!contract) return (
    <div className="text-zinc-400 p-8">
      Sem contrato EC ativo.{' '}
      <Link to="/noisysource/ec-contracts" className="text-blue-400 underline">Criar contrato</Link>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold capitalize">{fmtYM(viewMonth)}</h1>
          <p className="text-sm text-zinc-400 mt-0.5">
            {contract.clientName}{contract.projectName ? ` · ${contract.projectName}` : ''}
            {saving && <span className="ml-2 text-zinc-500">a guardar…</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowBalance(v => !v)}
            className={`text-xs px-3 py-1.5 rounded transition-colors border ${showBalance ? 'bg-emerald-900/40 border-emerald-700 text-emerald-300' : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-zinc-400'}`}
          >
            💰 Saldo
          </button>
          <button onClick={prevMonth} className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-300">‹</button>
          <button onClick={() => setViewMonth(currentYM())} className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">Hoje</button>
          <button onClick={nextMonth} className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-300">›</button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_260px] gap-5">
        {/* Calendar */}
        <div className="bg-zinc-900 rounded-xl p-4 select-none">
          <div className="grid grid-cols-7 mb-1">
            {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map(d => (
              <div key={d} className="text-center text-xs text-zinc-500 pb-2">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((iso, i) => {
              if (!iso) return <div key={i} className={showBalance ? 'min-h-[76px]' : 'min-h-[64px]'} />;
              const kind = dayKind(iso, contractStart, contractEnd, nwdSet, halfSet);
              const isToday = iso === today;
              const isSelected = iso === selectedDay;
              const clickable = kind !== 'weekend' && kind !== 'outside';
              const dayEvents = eventsByDate.get(iso) ?? [];
              const dayBalance = dailyBalances.get(iso);

              const bg =
                kind === 'off'     ? 'bg-red-900/40' :
                kind === 'half'    ? 'bg-amber-900/40' :
                kind === 'working' ? 'bg-zinc-800/40' : '';
              const numColor =
                kind === 'off'     ? 'text-red-300' :
                kind === 'half'    ? 'text-amber-300' :
                kind === 'working' ? 'text-zinc-200' : 'text-zinc-700';

              return (
                <button
                  key={iso} type="button" disabled={!clickable}
                  onClick={() => handleDayClick(iso)}
                  className={[
                    showBalance ? 'min-h-[76px]' : 'min-h-[64px]',
                    'flex flex-col items-center pt-2 pb-1 px-0.5 rounded-lg transition-colors',
                    bg,
                    clickable ? 'hover:brightness-125 cursor-pointer' : 'cursor-default',
                    isToday    ? 'ring-1 ring-blue-500' : '',
                    isSelected ? 'ring-2 ring-white/40'  : '',
                  ].join(' ')}
                >
                  <span className={`text-sm font-semibold leading-none w-full text-center ${numColor} ${isToday ? '!text-blue-400' : ''}`}>
                    {kind === 'half' ? `½${parseInt(iso.slice(-2), 10)}` : parseInt(iso.slice(-2), 10)}
                  </span>

                  {dayEvents.length > 0 && (
                    <div className="flex flex-col gap-0.5 mt-1 w-full">
                      {dayEvents.slice(0, 2).map(e => {
                        const meta = EVENT_META[e.type] ?? EVENT_META.income;
                        return (
                          <span key={eventKey(e)} className={`text-[9px] leading-tight rounded px-0.5 py-px w-full text-center truncate ${meta.bg} ${meta.text} ${isComputed(e) ? 'opacity-75' : ''}`}>
                            {meta.icon} {meta.label}
                          </span>
                        );
                      })}
                      {dayEvents.length > 2 && (
                        <span className="text-[9px] text-zinc-500 text-center">+{dayEvents.length - 2}</span>
                      )}
                    </div>
                  )}

                  {dayBalance !== undefined && (
                    <span className={`text-[9px] font-semibold mt-auto pt-0.5 leading-none ${dayBalance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmtBalance(dayBalance)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[10px] text-zinc-500 border-t border-zinc-800 pt-3">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-zinc-800/40 border border-zinc-700" /> dia útil</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-900/40" /> ½ dia</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-900/40" /> folga</span>
            <span>📝 TS &nbsp;💰 pgto</span>
            {showBalance && <span className="text-emerald-600">💰 saldo projetado</span>}
            <span className="ml-auto text-zinc-600">clique para ver detalhes</span>
          </div>
        </div>

        {/* Right panel */}
        <div className="space-y-4">
          {selectedDay ? (
            /* ── Day detail ─────────────────────────────────────────── */
            <>
              <div className="bg-zinc-900 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-zinc-100 capitalize">
                    {new Date(selectedDay + 'T12:00:00').toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' })}
                  </h3>
                  <button onClick={() => setSelectedDay(null)}
                    className="text-zinc-500 hover:text-zinc-300 text-xl leading-none w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-800">×</button>
                </div>
                {(() => {
                  const kind = dayKind(selectedDay, contractStart, contractEnd, nwdSet, halfSet);
                  if (kind === 'weekend' || kind === 'outside') return (
                    <p className="text-xs text-zinc-600">{kind === 'weekend' ? 'Fim de semana' : 'Fora do contrato'}</p>
                  );
                  return (
                    <div className="flex gap-2">
                      {([
                        { k: 'working', label: '💼 Dia útil' },
                        { k: 'half',    label: '½ Meio dia' },
                        { k: 'off',     label: '🔴 Folga' },
                      ] as const).map(({ k, label }) => (
                        <button key={k} onClick={() => handleDayStateChange(selectedDay, k)}
                          className={`text-xs px-2 py-1.5 rounded flex-1 transition-colors ${kind === k ? 'bg-zinc-600 text-zinc-100' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>

              {/* Events */}
              {(() => {
                const dayEvts = eventsByDate.get(selectedDay) ?? [];
                if (!dayEvts.length) return (
                  <div className="bg-zinc-900 rounded-xl p-4 text-sm text-zinc-600 text-center">Sem eventos neste dia</div>
                );
                return (
                  <div className="bg-zinc-900 rounded-xl p-4 space-y-3">
                    <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Eventos</div>
                    {dayEvts.map(e => {
                      const meta = EVENT_META[e.type] ?? EVENT_META.income;
                      const computed = isComputed(e);
                      const isPayment = e.type === 'ec_payment' && computed;
                      const isConfirmed = isPayment && confirmedSourceIds.has((e as ComputedEvent).key);
                      return (
                        <div key={eventKey(e)} className="space-y-2">
                          <div className="flex items-center justify-between text-sm gap-2">
                            <span className="flex items-center gap-1.5 text-zinc-300 min-w-0">
                              <span>{meta.icon}</span>
                              <span className="truncate">{e.description ?? meta.label}</span>
                              {computed && <span className="text-[9px] text-zinc-500 bg-zinc-800 px-1 py-px rounded shrink-0">estimado</span>}
                            </span>
                            {e.amountCents > 0 && (
                              <span className="text-emerald-400 font-medium shrink-0">{formatEUR(e.amountCents)}</span>
                            )}
                          </div>
                          {isPayment && (
                            <div className="flex justify-end">
                              {isConfirmed
                                ? <span className="text-xs text-emerald-500 font-medium">✓ recebido</span>
                                : <button onClick={() => confirmPayment(e as ComputedEvent)} disabled={confirming}
                                    className="text-xs px-3 py-1 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-200 disabled:opacity-50"
                                  >
                                    Confirmar recebimento
                                  </button>
                              }
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* Account balances on selected day */}
              {accountBalancesOnDay.length > 0 && (
                <div className="bg-zinc-900 rounded-xl p-4 space-y-2.5">
                  <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Saldos</div>
                  {accountBalancesOnDay.map(({ account, balance }) => (
                    <div key={account.id} className="flex items-center justify-between text-sm gap-2">
                      <span className="flex items-center gap-1.5 text-zinc-300 min-w-0">
                        <span className="text-[9px] text-zinc-500 bg-zinc-800 px-1 py-px rounded shrink-0 font-mono">
                          {ENTITY_LABEL[account.entityId] ?? account.entityId}
                        </span>
                        <span className="truncate">{account.name}</span>
                      </span>
                      <span className={`font-medium shrink-0 ${balance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {formatEUR(balance)}
                      </span>
                    </div>
                  ))}
                  {accountBalancesOnDay.length > 1 && (() => {
                    const total = accountBalancesOnDay.reduce((s, x) => s + x.balance, 0);
                    return (
                      <div className="border-t border-zinc-800 pt-2 flex items-center justify-between text-sm font-semibold">
                        <span className="text-zinc-400">Total</span>
                        <span className={total >= 0 ? 'text-emerald-300' : 'text-red-300'}>{formatEUR(total)}</span>
                      </div>
                    );
                  })()}
                </div>
              )}

              <button disabled className="w-full text-xs px-3 py-2 rounded-lg border border-zinc-800 text-zinc-700 cursor-not-allowed">
                + Novo lançamento (em breve)
              </button>
            </>
          ) : (
            /* ── Month summary ──────────────────────────────────────── */
            <>
              <div className="bg-zinc-900 rounded-xl p-4 space-y-2.5">
                <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Este mês</div>
                {monthBreakdown ? (
                  <>
                    <Row label="Dias úteis" value={`${monthBreakdown.workingDays}d`} />
                    <Row label="Rendimento" value={formatEUR(monthBreakdown.incomeCents)} accent />
                    {tsDay && <Row label="📝 Submeter TS" value={new Date(tsDay + 'T12:00:00').toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' })} color="text-indigo-300" />}
                    {paymentDay && (() => {
                      const payEvent = computedEvents.find(e => e.type === 'ec_payment' && e.date === paymentDay);
                      const isConfirmed = payEvent && confirmedSourceIds.has(payEvent.key);
                      return (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-zinc-400">💰 Pagamento</span>
                          <div className="flex items-center gap-2">
                            <span className="text-emerald-300">{new Date(paymentDay + 'T12:00:00').toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' })}</span>
                            {payEvent && (
                              isConfirmed
                                ? <span className="text-xs text-emerald-500 font-medium">✓ recebido</span>
                                : <button onClick={() => confirmPayment(payEvent)} disabled={confirming}
                                    className="text-xs px-2 py-0.5 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-200 disabled:opacity-50"
                                  >
                                    Confirmar
                                  </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                ) : (
                  <p className="text-sm text-zinc-600">Fora do período do contrato</p>
                )}
              </div>

              {storedEvents.filter(e => e.date >= monthStart && e.date <= monthEnd).length > 0 && (
                <div className="bg-zinc-900 rounded-xl p-4 space-y-2">
                  <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Lançamentos</div>
                  {storedEvents.filter(e => e.date >= monthStart && e.date <= monthEnd).map(e => {
                    const meta = EVENT_META[e.type] ?? EVENT_META.income;
                    return (
                      <div key={e.id} className="flex items-center justify-between text-sm">
                        <span className="text-zinc-300 flex items-center gap-1.5 truncate">
                          <span>{meta.icon}</span>
                          <span className="truncate">{e.description ?? meta.label}</span>
                        </span>
                        <span className={e.amountCents >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                          {formatEUR(e.amountCents)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {projection && (
                <div className="bg-zinc-900 rounded-xl p-4 space-y-2.5">
                  <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Contrato</div>
                  <Row label="Trabalhados" value={`${projection.workedDays}d`} />
                  <Row label="Restantes" value={`${projection.remainingDays}d`} />
                  <Row label="Ganhos" value={formatEUR(projection.earnedCents)} accent />
                  <Row label="Total previsto" value={formatEUR(projection.projectedTotalCents)} />
                  <Row label="Fim previsto" value={new Date(projection.contractEndDate + 'T12:00:00').toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' })} />
                </div>
              )}

              <Link to="/noisysource/ec-contracts" className="block text-center text-xs text-zinc-500 hover:text-zinc-300 transition-colors py-2">
                Editar contrato →
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, accent, color }: { label: string; value: string | number; accent?: boolean; color?: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-zinc-400">{label}</span>
      <span className={accent ? 'text-emerald-400 font-semibold' : color ?? 'text-zinc-200'}>{value}</span>
    </div>
  );
}
