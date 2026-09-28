import { useState } from 'react';
import { deleteDoc } from 'firebase/firestore';
import { docRef } from '../../../lib/db';
import { FamilyGroup, ChildDoc, subCollection } from './model';

// Paid, invoiced or mid-payment bills are records of real money (and, once
// invoiced, of a document already issued in Vendus). They are kept.
const KEEP_BILL = new Set(['paid', 'invoiced', 'processing']);

const SERVICE = { study: 'Sala de Estudo', transport: 'Transporte' } as const;
const STATUS = { pending: 'pendente', active: 'ativa', cancelled: 'cancelada' } as const;

/**
 * Deleting a family, with the full list of what goes first.
 *
 * Order: the family document first, so a billing trigger fired by the
 * subscription deletes finds no family and creates nothing; then
 * subscriptions (their events trigger voids the future calendar events),
 * unpaid bills, and the family's children — including children retired by a
 * duplicate merge, which would otherwise be left pointing at nothing.
 */
export default function DeleteFamilyModal({ group, allChildren, onDeleted, onClose }: {
  group: FamilyGroup;
  /** Every children/ doc, merged ones included. */
  allChildren: Map<string, ChildDoc>;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const familyId = group.familyId!;
  const items = group.children.flatMap(c => c.items);
  const childIds = new Set(group.children.map(c => c.childId).filter(Boolean) as string[]);
  for (const c of allChildren.values()) if (c.familyId === familyId) childIds.add(c.id);
  const children = [...childIds].map(id => allChildren.get(id)).filter(Boolean) as ChildDoc[];
  const billsDeleted = group.bills.filter(b => !KEEP_BILL.has(b.status));
  const billsKept = group.bills.filter(b => KEEP_BILL.has(b.status));

  const run = async () => {
    setDeleting(true);
    setError(null);
    const failed: string[] = [];
    const del = async (label: string, ref: ReturnType<typeof docRef>) => {
      try { await deleteDoc(ref); } catch (err: any) { console.error(`Failed to delete ${label}:`, err); failed.push(label); }
    };
    await del(`families/${familyId}`, docRef('families', familyId));
    for (const i of items) await del(`${subCollection(i)}/${i.id}`, docRef(subCollection(i), i.id));
    for (const b of billsDeleted) await del(`billing/${b.id}`, docRef('billing', b.id));
    for (const c of children) await del(`children/${c.id}`, docRef('children', c.id));
    setDeleting(false);
    if (failed.length) {
      setError(`Não foi possível eliminar ${failed.length} documento(s): ${failed.join(', ')}. Recarregue a página e veja o que ficou.`);
      return;
    }
    onDeleted();
  };

  const li = 'flex justify-between gap-3 text-sm py-1';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={deleting ? undefined : onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-100">
          <h2 className="font-bold text-gray-900">Eliminar a família {group.label}?</h2>
          <p className="text-xs text-red-600 mt-1">Não pode ser revertido.</p>
        </div>
        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          <Section title="Vai ser eliminado">
            <div className={li}><span>Registo da família</span><span className="text-gray-400">families/{familyId}</span></div>
            {items.map(i => (
              <div key={i.id} className={li}>
                <span>Inscrição · {i.childName} · {SERVICE[i._type]}</span>
                <span className="text-gray-400">{STATUS[i.status]}</span>
              </div>
            ))}
            {children.map(c => (
              <div key={c.id} className={li}>
                <span>Criança · {`${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || c.id}</span>
                {c.status === 'merged' && <span className="text-gray-400">duplicado fundido</span>}
              </div>
            ))}
            {billsDeleted.map(b => (
              <div key={b.id} className={li}>
                <span>Cobrança · {b.periodLabel}</span>
                <span className="text-gray-400">€{b.total.toFixed(2)} · {b.status}</span>
              </div>
            ))}
            <p className="text-xs text-gray-500 pt-1">
              Os eventos futuros do calendário destas inscrições são anulados automaticamente.
            </p>
          </Section>
          <Section title="Fica guardado">
            {billsKept.map(b => (
              <div key={b.id} className={li}>
                <span>Cobrança · {b.periodLabel}</span>
                <span className="text-gray-400">€{b.total.toFixed(2)} · {b.status}{b.invoiceNumber ? ` · ${b.invoiceNumber}` : ''}</span>
              </div>
            ))}
            {billsKept.length > 0 && (
              <p className="text-xs text-gray-500">Pagas, faturadas ou com pagamento em curso: são registo de dinheiro real e de faturas emitidas.</p>
            )}
            <p className="text-xs text-gray-500">
              Também ficam: a conta de login do encarregado, o cliente no Vendus e os eventos passados do calendário.
            </p>
          </Section>
          {error && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        </div>
        <div className="p-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} disabled={deleting} className="text-sm px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 disabled:opacity-60">Cancelar</button>
          <button onClick={run} disabled={deleting}
            className="text-sm px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 font-medium">
            {deleting ? 'A eliminar…' : 'Eliminar definitivamente'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{title}</h3>
      <div className="divide-y divide-gray-50">{children}</div>
    </div>
  );
}
