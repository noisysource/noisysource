import { useCallback, useEffect, useMemo, useState } from 'react';
import { getDoc } from 'firebase/firestore';
import type { AdhocEvent, AdhocEventRegistration, BillingRecord } from '@shared/models';
import { docRef } from '../../../lib/db';
import ReasonPromptModal from '../../../components/ReasonPromptModal';
import MarkPaidModal from '../billing/MarkPaidModal';
import WalkInForm from './WalkInForm';
import { adhocEventService, fmtDay, fmtEur, callableMessage } from '../../../services/adhocEventService';

const STATUS: Record<string, { label: string; cls: string }> = {
  held:      { label: 'A aguardar pagamento', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  confirmed: { label: 'Confirmada',           cls: 'bg-green-50 text-green-800 border-green-200' },
  cancelled: { label: 'Cancelada',            cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  expired:   { label: 'Expirada',             cls: 'bg-gray-100 text-gray-500 border-gray-200' },
};
const BILL_LABEL: Record<string, string> = {
  pending: 'por pagar', processing: 'MB WAY em curso', failed: 'MB WAY falhou', paid: 'pago', invoiced: 'pago e faturado', cancelled: 'anulado',
};
const registrationLink = (r: AdhocEventRegistration) => `${window.location.origin}/eventos/inscricao/${r.id}?t=${encodeURIComponent(r.accessToken)}`;

/** An event's registrations: who's coming, what's paid, and the day's attendance sheet. */
export default function AdhocRegistrationsPanel({ event, onChanged }: { event: AdhocEvent; onChanged: () => void }) {
  const [regs, setRegs] = useState<AdhocEventRegistration[] | null>(null);
  const [bills, setBills] = useState<Record<string, BillingRecord>>({});
  const [showAll, setShowAll] = useState(false);
  const [cancelling, setCancelling] = useState<AdhocEventRegistration | null>(null);
  const [markPaid, setMarkPaid] = useState<BillingRecord | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const [sheetDay, setSheetDay] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const list = await adhocEventService.listRegistrations(event.id);
    setRegs(list);
    const ids = list.map(r => r.billingId).filter((x): x is string => !!x);
    const snaps = await Promise.all(ids.map(id => getDoc(docRef('billing', id))));
    setBills(Object.fromEntries(snaps.filter(s => s.exists()).map(s => [s.id, { id: s.id, ...(s.data() as Omit<BillingRecord, 'id'>) }])));
  }, [event.id]);

  useEffect(() => { setRegs(null); load().catch(err => { console.error(err); setMessage('Não foi possível carregar as inscrições.'); }); }, [load]);

  const refresh = async () => { await load(); onChanged(); };
  const shown = useMemo(() => (regs ?? []).filter(r => showAll || r.status === 'held' || r.status === 'confirmed'), [regs, showAll]);
  const flagged = (regs ?? []).filter(r => r.refundPending || r.overCapacity);

  const doCancel = async (reason: string) => {
    const r = cancelling;
    setCancelling(null);
    if (!r) return;
    try {
      const res = await adhocEventService.cancel(r.id, reason);
      setMessage(res.refundPending ? 'Cancelada. Já estava paga: fica marcada para devolução (fazer à mão, com nota de crédito se já houver fatura).' : 'Cancelada; vagas libertadas.');
      await refresh();
    } catch (err) {
      setMessage(callableMessage(err, 'Não foi possível cancelar.'));
    }
  };

  const copyLink = (r: AdhocEventRegistration) => {
    navigator.clipboard?.writeText(registrationLink(r)).then(() => setMessage('Link copiado. Envie-o à família para pagar ou ver a inscrição.')).catch(() => {});
  };

  if (sheetDay) {
    const list = (regs ?? []).filter(r => r.status === 'confirmed' || r.status === 'held').filter(r => r.days.includes(sheetDay));
    const day = event.days.find(d => d.date === sheetDay);
    return (
      <div>
        <div className="flex items-center justify-between mb-3 print:hidden">
          <button onClick={() => setSheetDay(null)} className="text-sm text-gray-500 hover:text-gray-700">← Inscrições</button>
          <button onClick={() => window.print()} className="text-sm bg-gray-800 text-white px-3 py-1.5 rounded">Imprimir</button>
        </div>
        <h3 className="text-lg font-semibold">{event.name} — {fmtDay(sheetDay)}{day?.startTime ? ` · ${day.startTime}${day.endTime ? `–${day.endTime}` : ''}` : ''}</h3>
        <p className="text-sm text-gray-500 mb-3">{list.reduce((n, r) => n + r.children.length, 0)} crianças{list.some(r => r.status === 'held') ? ' (inclui por pagar, marcadas com *)' : ''}</p>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left border-b border-gray-300">
              <th className="py-1 pr-2">Criança</th><th className="py-1 pr-2">Nasc.</th><th className="py-1 pr-2">Saúde</th>
              <th className="py-1 pr-2">Encarregado</th><th className="py-1 pr-2">Recolha</th><th className="py-1 pr-2">Fotos</th><th className="py-1">✓</th>
            </tr>
          </thead>
          <tbody>
            {list.flatMap(r => r.children.map((c, i) => (
              <tr key={`${r.id}-${i}`} className="border-b border-gray-100 align-top">
                <td className="py-1 pr-2 font-medium">{c.name}{r.status === 'held' ? ' *' : ''}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{c.birthDate ? c.birthDate.split('-').reverse().join('/') : '—'}</td>
                <td className="py-1 pr-2 text-red-700">{c.healthNotes ?? ''}</td>
                <td className="py-1 pr-2">{r.guardian.name}<br /><span className="text-gray-500">{r.guardian.phone}</span></td>
                <td className="py-1 pr-2">{r.pickupNotes ?? ''}</td>
                <td className="py-1 pr-2">{r.photoConsent ? 'Sim' : 'Não'}</td>
                <td className="py-1"><span className="inline-block w-4 h-4 border border-gray-400 rounded-sm" /></td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-gray-800 mr-auto">Inscrições</h3>
        {event.days.map(d => (
          <button key={d.date} onClick={() => setSheetDay(d.date)} className="text-xs border border-gray-300 rounded px-2 py-1 hover:bg-gray-50">📋 Lista {fmtDay(d.date)}</button>
        ))}
        <button onClick={() => setWalkIn(w => !w)} className="text-xs bg-indigo-600 text-white rounded px-2 py-1 hover:bg-indigo-700">+ Inscrição presencial</button>
      </div>

      {walkIn && (
        <div className="border border-indigo-100 bg-indigo-50/40 rounded-lg p-3">
          <WalkInForm event={event} onDone={async (msg) => { setWalkIn(false); setMessage(msg); await refresh(); }} onCancel={() => setWalkIn(false)} />
        </div>
      )}

      {message && <p className="text-sm text-indigo-800 bg-indigo-50 rounded px-3 py-2">{message}</p>}
      {flagged.length > 0 && (
        <div className="text-sm bg-red-50 border border-red-200 text-red-800 rounded px-3 py-2">
          {flagged.map(r => (
            <p key={r.id}>⚠️ {r.guardian.name} ({r.children.map(c => c.name).join(', ')}): {r.refundPending ? 'pago e cancelado — devolver à mão' : ''}{r.refundPending && r.overCapacity ? '; ' : ''}{r.overCapacity ? 'pagou depois da reserva expirar e o dia já estava cheio — acima da capacidade' : ''}</p>
          ))}
        </div>
      )}

      <label className="flex items-center gap-2 text-xs text-gray-500"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Mostrar canceladas e expiradas</label>

      {regs === null ? (
        <p className="text-sm text-gray-400">A carregar...</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-gray-400">Sem inscrições{showAll ? '' : ' ativas'}.</p>
      ) : (
        <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg bg-white">
          {shown.map(r => {
            const bill = r.billingId ? bills[r.billingId] : undefined;
            const st = STATUS[r.status] ?? { label: r.status, cls: 'bg-gray-50 text-gray-600 border-gray-200' };
            return (
              <div key={r.id} className="p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-800">
                      {r.children.map(c => c.name).join(', ')}
                      <span className={`ml-2 inline-block text-xs px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                      <span className="ml-1 inline-block text-xs px-1.5 py-0.5 rounded border border-gray-200 text-gray-500">{r.kind === 'member' ? 'Cliente' : 'Convidado'}{r.adminEntry ? ' · presencial' : ''}</span>
                    </p>
                    <p className="text-gray-500">{r.guardian.name} · {r.guardian.phone} · {r.guardian.email}{r.guardian.nif ? ` · NIF ${r.guardian.nif}` : ''}</p>
                    <p className="text-gray-500">{r.days.map(fmtDay).join(', ')}</p>
                    {r.children.some(c => c.healthNotes) && <p className="text-red-700 text-xs mt-0.5">Saúde: {r.children.filter(c => c.healthNotes).map(c => `${c.name}: ${c.healthNotes}`).join(' · ')}</p>}
                    {r.pickupNotes && <p className="text-gray-500 text-xs">Recolha: {r.pickupNotes}</p>}
                    {r.cancelReason && <p className="text-gray-500 text-xs">Motivo: {r.cancelReason}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-semibold">{fmtEur(r.total)}</p>
                    <p className="text-xs text-gray-500">
                      {r.total === 0 ? 'grátis' : r.payment === 'monthly' ? `mensalidade ${r.billingPeriod ?? ''}` : bill ? `MB WAY · ${BILL_LABEL[bill.status] ?? bill.status}` : 'pagar agora'}
                      {bill?.invoiceNumber ? ` · ${bill.invoiceNumber}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 mt-2 text-xs">
                  {r.status === 'held' && <button onClick={() => copyLink(r)} className="text-indigo-600 hover:underline">Copiar link de pagamento</button>}
                  {r.status === 'confirmed' && <button onClick={() => copyLink(r)} className="text-indigo-600 hover:underline">Copiar link</button>}
                  {bill && (bill.status === 'pending' || bill.status === 'failed') && r.status === 'held' && (
                    <button onClick={() => setMarkPaid(bill)} className="text-green-700 hover:underline">Marcar como pago (transferência)</button>
                  )}
                  {(r.status === 'held' || r.status === 'confirmed') && (
                    <button onClick={() => setCancelling(r)} className="text-red-600 hover:underline">Cancelar</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ReasonPromptModal
        isOpen={!!cancelling}
        title="Cancelar inscrição"
        message={cancelling ? `${cancelling.children.map(c => c.name).join(', ')} — ${cancelling.days.map(fmtDay).join(', ')}. As vagas são libertadas. Se já estiver paga, fica marcada para devolução (feita à mão).` : ''}
        onConfirm={doCancel}
        onCancel={() => setCancelling(null)}
        reasonRequired={false}
      />
      {markPaid && (
        <MarkPaidModal record={markPaid} onClose={() => setMarkPaid(null)} onChanged={async () => { setMarkPaid(null); await refresh(); }} />
      )}
    </div>
  );
}
