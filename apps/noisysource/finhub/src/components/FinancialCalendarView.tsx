import React, { useMemo, useState } from 'react';
import { CalendarDays, Pencil, Plane, Plus, Trash2, X } from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import { formatMoney } from '../utils/financeMath';
import { addDays, isoDay } from '../utils/clientContracts';
import { financialCalendar, perDiemOf, type CalendarItem, type CalendarKind, type Trip, type TripCost, type TripCostKind, type TripStatus } from '../utils/financialCalendar';
import { deleteTrip, newId, saveTrip, useClientContracts } from '../lib/clientContracts';

interface FinancialCalendarViewProps {
  createModalOpen: boolean;
  onOpenCreateModal: () => void;
  onCloseCreateModal: () => void;
}

const KIND: Record<CalendarKind, { label: string; dot: string }> = {
  day_off: { label: 'Days off', dot: 'bg-sky-400' },
  trip: { label: 'Trips', dot: 'bg-violet-400' },
  per_diem: { label: 'Per diem', dot: 'bg-violet-300' },
  payment_in: { label: 'Client payments', dot: 'bg-emerald-400' },
  payslip: { label: 'Salaries', dot: 'bg-amber-400' },
  tax: { label: 'Taxes', dot: 'bg-rose-400' },
  subscription: { label: 'Subscriptions', dot: 'bg-slate-400' },
  loan: { label: 'Loans', dot: 'bg-orange-400' },
};
const card = 'bg-[#0F172A] border border-slate-800 rounded-xl';
const input = 'w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500';
const label = 'block text-xs text-slate-400 mb-1';
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const COST_KINDS: TripCostKind[] = ['flight', 'hotel', 'transport', 'other'];
const STATUSES: TripStatus[] = ['planned', 'booked', 'done', 'cancelled'];

const daysBetween = (a: string, b: string) => Math.max(1, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1);

export const FinancialCalendarView: React.FC<FinancialCalendarViewProps> = ({ createModalOpen, onOpenCreateModal, onCloseCreateModal }) => {
  const { entities, currencyCode, pushToast, payslips, recurringExpenses, creditFacilities } = useTreasury();
  const { contracts, handovers, daysOff, trips, error } = useClientContracts();
  const [span, setSpan] = useState(60);
  const [hidden, setHidden] = useState<Set<CalendarKind>>(new Set());
  const [editing, setEditing] = useState<Trip | null>(null);
  const today = isoDay(new Date());
  const money = (n: number) => formatMoney(n, currencyCode);
  const fail = (what: string) => (e: unknown) => pushToast(`Couldn't ${what}`, e instanceof Error ? e.message : String(e), 'error');

  const items = useMemo(
    () =>
      financialCalendar({
        from: today,
        to: addDays(today, span),
        today,
        daysOff,
        trips,
        contracts,
        handovers,
        payslips,
        subscriptions: recurringExpenses,
        loans: creditFacilities,
      }),
    [today, span, daysOff, trips, contracts, handovers, payslips, recurringExpenses, creditFacilities],
  );
  const shown = items.filter((i) => !hidden.has(i.kind));
  const byDay = new Map<string, CalendarItem[]>();
  for (const i of shown) {
    const d = i.date < today ? today : i.date;
    byDay.set(d, [...(byDay.get(d) ?? []), i]);
  }
  const inflow = shown.reduce((n, i) => n + (i.amount && i.amount > 0 ? i.amount : 0), 0);
  const outflow = shown.reduce((n, i) => n + (i.amount && i.amount < 0 ? -i.amount : 0), 0);
  const toggle = (k: CalendarKind) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  });

  const blankTrip = (): Trip => ({ id: newId('trip'), userId: '', entityId: entities[0]?.id ?? '', title: '', destination: '', startDate: today, endDate: today, traveller: '', status: 'planned', perDiemDaily: 0, perDiemDays: 1, costs: [], notes: '' });
  const open = createModalOpen ? { trip: blankTrip(), isNew: true } : editing ? { trip: editing, isNew: false } : null;
  const close = () => {
    setEditing(null);
    onCloseCreateModal();
  };

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-rose-300">Couldn't read the calendar: {error}</p>}
      <div className={`${card} p-5 flex flex-wrap items-center gap-3`}>
        <CalendarDays className="w-5 h-5 text-slate-400" />
        <p className="text-sm text-slate-300 flex-1">
          The dates that involve money. FinHub is their master: Atlas puts your days off and trips in a "FinHub" Google calendar and shows all of this beside your other calendars.
        </p>
        <select className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100" value={span} onChange={(e) => setSpan(Number(e.target.value))}>
          <option value={30}>Next 30 days</option>
          <option value={60}>Next 60 days</option>
          <option value={120}>Next 4 months</option>
          <option value={365}>Next year</option>
        </select>
      </div>

      <div className="flex flex-wrap gap-2">
        {(Object.keys(KIND) as CalendarKind[]).map((k) => (
          <button key={k} onClick={() => toggle(k)} className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border ${hidden.has(k) ? 'border-slate-800 text-slate-500' : 'border-slate-700 text-slate-200 bg-slate-800/60'}`}>
            <span className={`w-2 h-2 rounded-full ${KIND[k].dot}`} /> {KIND[k].label}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-400 font-mono tabular-nums self-center">in {money(inflow)} · out {money(outflow)}</span>
      </div>

      <div className="grid xl:grid-cols-3 gap-6">
        <section className={`${card} p-5 xl:col-span-2`}>
          {byDay.size === 0 && <p className="text-sm text-slate-400">Nothing in this window.</p>}
          {[...byDay.entries()].map(([day, list]) => (
            <div key={day} className="flex gap-4 py-2 border-t border-slate-800 first:border-t-0">
              <p className="w-28 shrink-0 text-xs text-slate-400 font-mono tabular-nums pt-0.5">{day === today ? 'Today' : dayLabel(day)}</p>
              <ul className="flex-1 space-y-1">
                {list.map((i) => (
                  <li key={i.key} className="flex items-center gap-2 text-sm">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${KIND[i.kind].dot}`} />
                    <span className={`flex-1 truncate ${i.projected ? 'text-slate-400 italic' : 'text-slate-200'}`}>
                      {i.title}
                      {i.endDate && i.endDate !== i.date ? <span className="text-slate-500"> · until {dayLabel(i.endDate)}</span> : null}
                    </span>
                    {typeof i.amount === 'number' && (
                      <span className={`font-mono tabular-nums text-xs ${i.amount > 0 ? 'text-emerald-400' : 'text-slate-300'}`}>{i.amount > 0 ? '+' : ''}{money(i.amount)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        <section className={`${card} p-5`}>
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-50"><Plane className="w-4 h-4" /> Trips</h2>
            <button onClick={onOpenCreateModal} className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Plan a trip</button>
          </div>
          <p className="text-xs text-slate-400 mt-1">What a trip should bring: flights and hotel invoices, and the per diem in the next salary.</p>
          <ul className="mt-3 space-y-3">
            {trips.length === 0 && <li className="text-sm text-slate-400">No trips planned.</li>}
            {trips.filter((t) => t.endDate >= addDays(today, -60)).map((t) => {
              const costs = t.costs.reduce((n, c) => n + c.amount, 0);
              return (
                <li key={t.id} className="border border-slate-800 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <p className="text-sm text-slate-100">{t.title}{t.destination ? <span className="text-slate-400"> · {t.destination}</span> : null}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{dayLabel(t.startDate)} → {dayLabel(t.endDate)} · {t.traveller || 'no traveller'} · {t.status}</p>
                      <p className="text-xs text-slate-300 mt-1 font-mono tabular-nums">expected {money(costs)} · per diem {money(perDiemOf(t))}</p>
                    </div>
                    <button onClick={() => setEditing(t)} className="p-1 text-slate-400 hover:text-slate-100" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => window.confirm(`Delete the trip ${t.title}?`) && deleteTrip(t.id).catch(fail('delete it'))} className="p-1 text-slate-500 hover:text-rose-300" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {open && <TripModal key={open.trip.id} initial={open.trip} isNew={open.isNew} entities={entities} onClose={close} fail={fail} />}
    </div>
  );
};

const TripModal: React.FC<{ initial: Trip; isNew: boolean; entities: { id: string; name: string }[]; onClose: () => void; fail: (w: string) => (e: unknown) => void }> = ({ initial, isNew, entities, onClose, fail }) => {
  const [t, setT] = useState<Trip>(initial);
  const set = <K extends keyof Trip>(k: K, v: Trip[K]) => setT((x) => ({ ...x, [k]: v }));
  const num = (v: string) => Number(v.replace(',', '.')) || 0;
  const setCost = (i: number, c: Partial<TripCost>) => set('costs', t.costs.map((x, j) => (j === i ? { ...x, ...c } : x)));
  const valid = t.title.trim() && t.entityId && t.startDate && t.endDate && t.endDate >= t.startDate;
  const setDates = (startDate: string, endDate: string) => setT((x) => ({ ...x, startDate, endDate, perDiemDays: endDate >= startDate ? daysBetween(startDate, endDate) : x.perDiemDays }));
  const submit = () => {
    if (!valid) return;
    void saveTrip({ ...t, title: t.title.trim(), costs: t.costs.filter((c) => c.label.trim() || c.amount) }, isNew).then(onClose).catch(fail('save the trip'));
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className={`${card} w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4`}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-50">{isNew ? 'Plan a trip' : `Edit ${initial.title}`}</h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-100"><X className="w-5 h-5" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={label}>Trip</label><input className={input} value={t.title} onChange={(e) => set('title', e.target.value)} placeholder="Brussels workshop" /></div>
          <div><label className={label}>Destination</label><input className={input} value={t.destination} onChange={(e) => set('destination', e.target.value)} placeholder="Brussels" /></div>
          <div><label className={label}>From</label><input type="date" className={input} value={t.startDate} onChange={(e) => setDates(e.target.value, t.endDate < e.target.value ? e.target.value : t.endDate)} /></div>
          <div><label className={label}>To</label><input type="date" className={input} value={t.endDate} onChange={(e) => setDates(t.startDate, e.target.value)} /></div>
          <div>
            <label className={label}>Paid by</label>
            <select className={input} value={t.entityId} onChange={(e) => set('entityId', e.target.value)}>
              {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div><label className={label}>Traveller</label><input className={input} value={t.traveller} onChange={(e) => set('traveller', e.target.value)} placeholder="Renato Lopes" /></div>
          <div><label className={label}>Per diem a day</label><input inputMode="decimal" className={input} value={t.perDiemDaily || ''} onChange={(e) => set('perDiemDaily', num(e.target.value))} placeholder="175.42" /></div>
          <div><label className={label}>Per diem days</label><input inputMode="decimal" className={input} value={t.perDiemDays || ''} onChange={(e) => set('perDiemDays', num(e.target.value))} /></div>
          <div>
            <label className={label}>Status</label>
            <select className={input} value={t.status} onChange={(e) => set('status', e.target.value as TripStatus)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-200">Expected costs</h3>
            <button onClick={() => set('costs', [...t.costs, { kind: 'flight', label: '', amount: 0 }])} className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add</button>
          </div>
          {t.costs.map((c, i) => (
            <div key={i} className="grid grid-cols-4 gap-2 items-end mt-2">
              <div>
                <label className={label}>Kind</label>
                <select className={input} value={c.kind} onChange={(e) => setCost(i, { kind: e.target.value as TripCostKind })}>
                  {COST_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </div>
              <div><label className={label}>What</label><input className={input} value={c.label} onChange={(e) => setCost(i, { label: e.target.value })} placeholder="TAP OPO–BRU" /></div>
              <div><label className={label}>Amount</label><input inputMode="decimal" className={input} value={c.amount || ''} onChange={(e) => setCost(i, { amount: num(e.target.value) })} /></div>
              <button onClick={() => set('costs', t.costs.filter((_, j) => j !== i))} className="px-3 py-2 text-xs text-slate-400 hover:text-rose-300">Remove</button>
            </div>
          ))}
        </div>
        <div><label className={label}>Notes</label><textarea className={input} rows={2} value={t.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
          <button onClick={submit} disabled={!valid} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-sm text-white">Save</button>
        </div>
      </div>
    </div>
  );
};
