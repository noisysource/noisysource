import React, { useMemo, useState } from 'react';
import { AlertTriangle, CalendarOff, Handshake, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import { formatMoney } from '../utils/financeMath';
import { addDays, endDateOf, handoverOf, isoDay, projectContract, rateAt, type ClientContract, type ContractAmendment, type DayOff, type DayOffKind } from '../utils/clientContracts';
import { deleteContract, deleteDayOff, deleteHandover, newId, saveContract, saveDayOff, saveHandover, useClientContracts } from '../lib/clientContracts';

interface ClientContractsViewProps {
  createModalOpen: boolean;
  onOpenCreateModal: () => void;
  onCloseCreateModal: () => void;
}

const KIND_LABEL: Record<DayOffKind, string> = { vacation: 'Vacation', day_off: 'Day off', client_closure: 'Client closure', public_holiday: 'Public holiday' };
const card = 'bg-[#0F172A] border border-slate-800 rounded-xl';
const input = 'w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500';
const label = 'block text-xs text-slate-400 mb-1';
const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

const blankContract = (entityId: string): ClientContract => ({
  id: newId('cc'),
  userId: '',
  entityId,
  clientName: '',
  reference: '',
  startDate: isoDay(new Date()),
  endDate: '',
  daysAllowed: 0,
  dailyRate: 0,
  vatRate: 23,
  paymentTermsDays: 10,
  warnMonths: 3,
  amendments: [],
  active: true,
  notes: '',
});

export const ClientContractsView: React.FC<ClientContractsViewProps> = ({ createModalOpen, onOpenCreateModal, onCloseCreateModal }) => {
  const { entities, currencyCode, pushToast } = useTreasury();
  const { contracts, handovers, daysOff, error } = useClientContracts();
  const [editing, setEditing] = useState<{ contract: ClientContract; isNew: boolean } | null>(null);
  const today = isoDay(new Date());
  const money = (n: number) => formatMoney(n, currencyCode);
  const fail = (what: string) => (e: unknown) => pushToast(`Couldn't ${what}`, e instanceof Error ? e.message : String(e), 'error');

  const open = createModalOpen ? { contract: blankContract(entities[0]?.id ?? ''), isNew: true } : editing;
  const close = () => {
    setEditing(null);
    onCloseCreateModal();
  };

  const projections = useMemo(() => new Map(contracts.map((c) => [c.id, projectContract(c, handovers, daysOff, today)])), [contracts, handovers, daysOff, today]);
  const upcomingOff = daysOff.filter((d) => d.date >= today && d.date <= addDays(today, 400));

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-rose-300">Couldn't read the contracts: {error}</p>}
      {contracts.length === 0 && (
        <div className={`${card} p-8 text-center`}>
          <Handshake className="w-8 h-8 text-slate-500 mx-auto" />
          <p className="text-slate-200 mt-3">No client contracts yet.</p>
          <p className="text-sm text-slate-400 mt-1">A contract is a pot of days at a daily rate over a period; the calendar decides how fast it empties.</p>
          <button onClick={onOpenCreateModal} className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm text-white">
            <Plus className="w-4 h-4" /> Add a client contract
          </button>
        </div>
      )}

      {contracts.map((c) => {
        const p = projections.get(c.id);
        if (!p) return null;
        const mine = handovers.filter((h) => h.contractId === c.id);
        const entity = entities.find((e) => e.id === c.entityId)?.name ?? '';
        return (
          <section key={c.id} className={`${card} p-6 space-y-5`}>
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-50">{c.clientName}{c.reference ? <span className="text-slate-400 font-normal"> · {c.reference}</span> : null}</h2>
                <p className="text-xs text-slate-400 mt-1">
                  {entity} · {money(rateAt(c, today.slice(0, 7)))}/day · VAT {c.vatRate}% · paid {c.paymentTermsDays} days after the handover · {c.startDate} → {endDateOf(c)}
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setEditing({ contract: c, isNew: false })} className="p-2 rounded-lg hover:bg-slate-800 text-slate-300" title="Edit"><Pencil className="w-4 h-4" /></button>
                <button
                  onClick={() => window.confirm(`Delete the ${c.clientName} contract? Its handovers stay.`) && deleteContract(c.id).catch(fail('delete it'))}
                  className="p-2 rounded-lg hover:bg-slate-800 text-slate-400"
                  title="Delete"
                ><Trash2 className="w-4 h-4" /></button>
              </div>
            </header>

            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <Kpi title="Days left" value={`${p.remaining}`} note={`${p.handedOver} of ${p.allowed} handed over`} />
              <Kpi
                title={p.endsBy === 'days' ? 'Days run out on' : 'Period ends first'}
                value={p.projectedEnd ? longDate(p.projectedEnd) : longDate(endDateOf(c))}
                note={p.endsBy === 'days' ? 'at this pace, with your days off and the closures' : `${p.unusedAtEnd} days would be left unused`}
                tone={p.warn ? 'amber' : undefined}
              />
              <Kpi title="Still to invoice" value={money(p.toInvoice)} note={`without VAT · ${money(p.toInvoice * (1 + c.vatRate / 100))} with`} />
              <Kpi title="Last handover" value={mine[0] ? monthName(mine[0].month) : 'none yet'} note={mine[0] ? `${mine[0].days} days · ${money(mine[0].amount)} · paid by ${mine[0].expectedPayDate}` : 'add one below'} />
            </div>
            {p.warn && (
              <p className="flex items-center gap-2 text-sm text-amber-300">
                <AlertTriangle className="w-4 h-4" /> Within {c.warnMonths} months of the end: time to renegotiate or extend.
              </p>
            )}

            <div className="grid xl:grid-cols-2 gap-6">
              <div>
                <h3 className="text-sm font-medium text-slate-200 mb-2">The months ahead</h3>
                <table className="w-full text-sm">
                  <thead><tr className="text-xs text-slate-400 text-left"><th className="py-1">Month</th><th className="text-right">Working</th><th className="text-right">Off</th><th className="text-right">Days</th><th className="text-right">Amount</th></tr></thead>
                  <tbody className="font-mono tabular-nums">
                    {p.months.filter((m) => m.workingDays + m.daysOff > 0).slice(0, 18).map((m) => (
                      <tr key={m.month} className="border-t border-slate-800 text-slate-300">
                        <td className="py-1.5 font-sans">{monthName(m.month)}</td>
                        <td className="text-right">{m.workingDays}</td>
                        <td className="text-right text-slate-400">{m.daysOff || ''}</td>
                        <td className="text-right text-slate-100">{m.plannedDays}</td>
                        <td className="text-right">{money(m.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Handovers contract={c} rows={mine} money={money} fail={fail} />
            </div>
          </section>
        );
      })}

      <DaysOff days={upcomingOff} fail={fail} />
      {open && <ContractModal key={open.contract.id} initial={open.contract} isNew={open.isNew} entities={entities} onClose={close} fail={fail} />}
    </div>
  );
};

const Kpi: React.FC<{ title: string; value: string; note: string; tone?: 'amber' }> = ({ title, value, note, tone }) => (
  <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4">
    <p className="text-xs text-slate-400">{title}</p>
    <p className={`text-lg font-semibold font-mono tabular-nums mt-1 ${tone === 'amber' ? 'text-amber-300' : 'text-slate-50'}`}>{value}</p>
    <p className="text-xs text-slate-400 mt-1">{note}</p>
  </div>
);

const Handovers: React.FC<{ contract: ClientContract; rows: ReturnType<typeof useClientContracts>['handovers']; money: (n: number) => string; fail: (w: string) => (e: unknown) => void }> = ({ contract, rows, money, fail }) => {
  const last = rows[0]?.month;
  // The month after the last handover, or this one.
  const [month, setMonth] = useState(() => {
    if (!last) return isoDay(new Date()).slice(0, 7);
    const [y, m] = last.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  });
  const [days, setDays] = useState('');
  const [handedOverAt, setHandedOverAt] = useState(isoDay(new Date()));
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const n = Number(days.replace(',', '.'));
  const preview = n > 0 ? handoverOf(contract, month, n, handedOverAt) : undefined;
  const add = () => {
    if (!preview) return;
    void saveHandover({ id: newId('ho'), userId: '', contractId: contract.id, month, days: n, ...preview, handedOverAt, invoiceNumber: invoiceNumber.trim() })
      .then(() => {
        setDays('');
        setInvoiceNumber('');
      })
      .catch(fail('save the handover'));
  };
  return (
    <div>
      <h3 className="text-sm font-medium text-slate-200 mb-2">Handovers</h3>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
        <div><label className={label}>Month worked</label><input type="month" className={input} value={month} onChange={(e) => setMonth(e.target.value)} /></div>
        <div><label className={label}>Days</label><input inputMode="decimal" className={input} value={days} onChange={(e) => setDays(e.target.value)} placeholder="18.5" /></div>
        <div><label className={label}>Handed over</label><input type="date" className={input} value={handedOverAt} onChange={(e) => setHandedOverAt(e.target.value)} /></div>
        <div><label className={label}>Invoice no.</label><input className={input} value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} /></div>
        <button onClick={add} disabled={!preview} className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-sm text-white">Add</button>
      </div>
      {preview && <p className="text-xs text-slate-400 mt-2">{n} days × {money(preview.dailyRate)} = {money(preview.amount)} without VAT, paid by {preview.expectedPayDate}.</p>}
      <table className="w-full text-sm mt-3">
        <tbody className="font-mono tabular-nums">
          {rows.map((h) => (
            <tr key={h.id} className="border-t border-slate-800 text-slate-300">
              <td className="py-1.5 font-sans">{monthName(h.month)}</td>
              <td className="text-right">{h.days} days</td>
              <td className="text-right">{money(h.amount)}</td>
              <td className="text-right text-slate-400">paid by {h.expectedPayDate}</td>
              <td className="text-right text-slate-400">{h.invoiceNumber}</td>
              <td className="text-right w-8"><button onClick={() => deleteHandover(h.id).catch(fail('delete it'))} className="p-1 text-slate-500 hover:text-rose-300" title="Delete"><X className="w-3.5 h-3.5" /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const DaysOff: React.FC<{ days: DayOff[]; fail: (w: string) => (e: unknown) => void }> = ({ days, fail }) => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<DayOffKind>('vacation');
  const [text, setText] = useState('');
  const add = async () => {
    if (!from) return;
    const last = to && to >= from ? to : from;
    for (let d = from, i = 0; d <= last && i < 60; d = addDays(d, 1), i += 1) await saveDayOff({ id: `manual_${d}_${kind}`, userId: '', date: d, kind, label: text.trim(), source: 'manual' });
    setFrom('');
    setTo('');
    setText('');
  };
  return (
    <section className={`${card} p-6`}>
      <h2 className="flex items-center gap-2 text-base font-semibold text-slate-50"><CalendarOff className="w-4 h-4" /> Days off ahead</h2>
      <p className="text-xs text-slate-400 mt-1">Your vacations and days off, and the client's closures (once a year, from their published list). FinHub is the master: Atlas shows them beside your other calendars.</p>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end mt-4">
        <div><label className={label}>From</label><input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className={label}>To (optional)</label><input type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div>
          <label className={label}>Kind</label>
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value as DayOffKind)}>
            {(Object.keys(KIND_LABEL) as DayOffKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </div>
        <div><label className={label}>Label</label><input className={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Christmas closure" /></div>
        <button onClick={() => void add().catch(fail('save the day off'))} disabled={!from} className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-sm text-white">Add</button>
      </div>
      <ul className="mt-4 divide-y divide-slate-800 text-sm">
        {days.length === 0 && <li className="py-2 text-slate-400">No days off ahead yet.</li>}
        {days.map((d) => (
          <li key={d.id} className="py-1.5 flex items-center gap-3 text-slate-300">
            <span className="font-mono tabular-nums w-36">{longDate(d.date)}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">{KIND_LABEL[d.kind]}</span>
            <span className="flex-1 truncate">{d.label}</span>
            <button onClick={() => deleteDayOff(d.id).catch(fail('delete it'))} className="p-1 text-slate-500 hover:text-rose-300" title="Delete"><X className="w-3.5 h-3.5" /></button>
          </li>
        ))}
      </ul>
    </section>
  );
};

const ContractModal: React.FC<{ initial: ClientContract; isNew: boolean; entities: { id: string; name: string }[]; onClose: () => void; fail: (w: string) => (e: unknown) => void }> = ({ initial, isNew, entities, onClose, fail }) => {
  const [c, setC] = useState<ClientContract>(initial);
  const set = <K extends keyof ClientContract>(k: K, v: ClientContract[K]) => setC((x) => ({ ...x, [k]: v }));
  const num = (v: string) => Number(v.replace(',', '.')) || 0;
  const setAmendment = (i: number, a: Partial<ContractAmendment>) => set('amendments', c.amendments.map((x, j) => (j === i ? { ...x, ...a } : x)));
  const valid = c.clientName.trim() && c.entityId && c.startDate && c.endDate && c.endDate >= c.startDate && c.daysAllowed > 0 && c.dailyRate > 0;
  const submit = () => {
    if (!valid) return;
    void saveContract({ ...c, clientName: c.clientName.trim(), reference: c.reference.trim() }, isNew).then(onClose).catch(fail('save the contract'));
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className={`${card} w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4`}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-50">{isNew ? 'New client contract' : `Edit ${initial.clientName}`}</h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-100"><X className="w-5 h-5" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={label}>Client</label><input className={input} value={c.clientName} onChange={(e) => set('clientName', e.target.value)} placeholder="Malt" /></div>
          <div><label className={label}>Reference</label><input className={input} value={c.reference} onChange={(e) => set('reference', e.target.value)} placeholder="Contract or project" /></div>
          <div>
            <label className={label}>Invoiced by</label>
            <select className={input} value={c.entityId} onChange={(e) => set('entityId', e.target.value)}>
              {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div><label className={label}>Daily rate (without VAT)</label><input inputMode="decimal" className={input} value={c.dailyRate || ''} onChange={(e) => set('dailyRate', num(e.target.value))} /></div>
          <div><label className={label}>Start</label><input type="date" className={input} value={c.startDate} onChange={(e) => set('startDate', e.target.value)} /></div>
          <div><label className={label}>End</label><input type="date" className={input} value={c.endDate} onChange={(e) => set('endDate', e.target.value)} /></div>
          <div><label className={label}>Days allowed</label><input inputMode="decimal" className={input} value={c.daysAllowed || ''} onChange={(e) => set('daysAllowed', num(e.target.value))} /></div>
          <div><label className={label}>VAT %</label><input inputMode="decimal" className={input} value={c.vatRate} onChange={(e) => set('vatRate', num(e.target.value))} /></div>
          <div><label className={label}>Paid days after the handover</label><input inputMode="numeric" className={input} value={c.paymentTermsDays} onChange={(e) => set('paymentTermsDays', num(e.target.value))} /></div>
          <div><label className={label}>Warn months before the end</label><input inputMode="numeric" className={input} value={c.warnMonths} onChange={(e) => set('warnMonths', num(e.target.value))} /></div>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-200">Renegotiations</h3>
            <button onClick={() => set('amendments', [...c.amendments, { from: isoDay(new Date()).slice(0, 7), dailyRate: null, addDays: 0, newEndDate: '', note: '' }])} className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add</button>
          </div>
          <p className="text-xs text-slate-400 mt-1">From a month on: a new rate, more days, a later end. The history stays.</p>
          {c.amendments.map((a, i) => (
            <div key={i} className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end mt-2">
              <div><label className={label}>From month</label><input type="month" className={input} value={a.from} onChange={(e) => setAmendment(i, { from: e.target.value })} /></div>
              <div><label className={label}>New rate</label><input inputMode="decimal" className={input} value={a.dailyRate ?? ''} onChange={(e) => setAmendment(i, { dailyRate: e.target.value ? num(e.target.value) : null })} /></div>
              <div><label className={label}>More days</label><input inputMode="decimal" className={input} value={a.addDays || ''} onChange={(e) => setAmendment(i, { addDays: num(e.target.value) })} /></div>
              <div><label className={label}>New end</label><input type="date" className={input} value={a.newEndDate} onChange={(e) => setAmendment(i, { newEndDate: e.target.value })} /></div>
              <button onClick={() => set('amendments', c.amendments.filter((_, j) => j !== i))} className="px-3 py-2 text-xs text-slate-400 hover:text-rose-300">Remove</button>
            </div>
          ))}
        </div>
        <div><label className={label}>Notes</label><textarea className={input} rows={2} value={c.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
          <button onClick={submit} disabled={!valid} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-sm text-white">Save</button>
        </div>
      </div>
    </div>
  );
};
