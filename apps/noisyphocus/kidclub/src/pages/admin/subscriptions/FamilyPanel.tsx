import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useImpersonation } from '../../../contexts/ImpersonationContext';
import { FamilyGroup, SubItem, FamilyDoc } from './model';
import { FamilyInfo } from './listModel';
import { AdminData } from './useAdminData';
import { SubscriptionActions } from './useSubscriptionActions';
import FamilyContactForm from './FamilyContactForm';
import ChildDetailsForm from './ChildDetailsForm';
import SubscriptionCard from './SubscriptionCard';
import FamilyBills from './FamilyBills';
import VersionHistoryModal from './VersionHistoryModal';
import DeleteFamilyModal from './DeleteFamilyModal';
import { FamilyTags } from './tags';
import { indexLinesBySub, standardLine } from '../../../lib/billingLines';

const PAYMENT_LABEL: Record<string, string> = {
  mbway: 'MB WAY', multibanco: 'Multibanco', card: 'Cartão', subscription: 'Débito', bank_transfer: 'Transferência',
};

/**
 * One family, everything about it, editable in place: guardian and billing
 * details, bills, and each child with their subscriptions. Opened from any row
 * of the list; the family key lives in the URL (?family=) so it can be linked.
 */
export default function FamilyPanel({ group, fam, data, actions, highlightId, onClose, onFamilyKeyChange }: {
  group: FamilyGroup;
  fam: FamilyInfo;
  data: AdminData;
  actions: SubscriptionActions;
  highlightId?: string | null;
  onClose: () => void;
  /** A subscription got linked to an account, so this family now has a new key. */
  onFamilyKeyChange: (familyKey: string) => void;
}) {
  const navigate = useNavigate();
  const { startImpersonation } = useImpersonation();
  const [editingFamily, setEditingFamily] = useState(false);
  const [editChildKey, setEditChildKey] = useState<string | null>(null);
  const [historyItem, setHistoryItem] = useState<SubItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const linesBySub = useMemo(() => indexLinesBySub(group.bills), [group.bills]);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // A different family: close whatever form was open for the previous one.
  useEffect(() => {
    setEditingFamily(false);
    setEditChildKey(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [group.key]);

  useEffect(() => {
    if (!highlightId) return;
    const t = setTimeout(() => highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
    return () => clearTimeout(t);
  }, [highlightId, group.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !historyItem && !confirmDelete) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, historyItem, confirmDelete]);

  const family = group.family;
  const address = family?.billingAddress;

  const impersonate = () => {
    if (!group.familyId) return;
    startImpersonation({ familyId: group.familyId, contactName: group.contactName || 'Família' });
    navigate('/client');
  };

  const applyFamilyPatch = (itemPatch: Partial<SubItem>, familyPatch: Partial<FamilyDoc>) => {
    const ids = new Set(group.children.flatMap(c => c.items).map(i => i.id));
    if (Object.keys(itemPatch).length) {
      data.setItems(prev => prev.map(i => ids.has(i.id) ? { ...i, ...itemPatch } : i));
    }
    if (group.familyId && Object.keys(familyPatch).length) {
      const id = group.familyId;
      data.setFamilies(prev => {
        const next = new Map(prev);
        const cur = next.get(id);
        if (cur) next.set(id, { ...cur, ...familyPatch });
        return next;
      });
    }
    setEditingFamily(false);
  };

  return (
    <>
      {/* Small screens: the panel covers the list, tap outside to close. */}
      <div className="fixed inset-0 bg-black/30 z-30 md:hidden" onClick={onClose} />
      <aside className="fixed top-0 right-0 h-full w-full md:w-[44rem] max-w-full bg-gray-50 border-l border-gray-200 shadow-2xl z-40 flex flex-col">
        <header className="bg-white border-b border-gray-200 px-5 py-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-gray-900 truncate">{group.label}</h2>
            <p className="text-xs text-gray-500 truncate">
              {[group.contactEmail, group.contactPhone].filter(Boolean).join(' · ') || '—'}
            </p>
            <div className="mt-1.5"><FamilyTags fam={fam} /></div>
          </div>
          {group.familyId && (
            <button onClick={impersonate}
              className="shrink-0 px-3 py-1.5 text-sm text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-50"
              title="Abrir a área de cliente como esta família">
              👁 Ver como cliente
            </button>
          )}
          <button onClick={onClose} className="shrink-0 text-gray-400 hover:text-gray-700 text-xl leading-none px-1" title="Fechar (Esc)">✕</button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {/* Family */}
          <section className="space-y-2">
            <div className="flex items-center">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex-1">Família</h3>
              {!editingFamily && (
                <button onClick={() => setEditingFamily(true)} className="text-xs text-blue-600 hover:underline">✏️ Editar</button>
              )}
            </div>
            {editingFamily ? (
              <FamilyContactForm group={group} onSaved={applyFamilyPatch} onCancel={() => setEditingFamily(false)} />
            ) : (
              <div className="bg-white border border-gray-200 rounded-lg p-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <Field label="Encarregado" value={group.contactName} />
                <Field label="Email" value={group.contactEmail} />
                <Field label="Telefone" value={group.contactPhone} />
                {group.familyId ? (
                  <>
                    <Field label="NIF" value={family?.nif || (family?.nifOptOut ? 'Não pretende (Consumidor final)' : 'Sem NIF (Consumidor final)')}
                      warn={fam.nifInvalid ? 'inválido' : undefined} />
                    <Field label="Morada de faturação" wide
                      value={address ? [address.street, [address.postalCode, address.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') : undefined} />
                    <Field label="Pagamento" value={(() => { const m = family?.paymentMethod ?? family?.defaultPaymentMethod; return m ? PAYMENT_LABEL[m] ?? m : undefined; })()} />
                    <Field label="Perfil completo" value={family?.profileComplete ? 'Sim' : 'Não'} />
                  </>
                ) : (
                  <p className="col-span-full text-xs text-amber-700">
                    Sem conta vinculada: o encarregado ainda não reclamou estas inscrições.
                  </p>
                )}
                {family?.notes && <p className="col-span-full text-xs text-gray-500 italic">{family.notes}</p>}
              </div>
            )}
          </section>

          {/* Bills */}
          {group.familyId && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Cobranças</h3>
              <FamilyBills bills={group.bills} onChanged={data.reload} />
            </section>
          )}

          {/* Children and their subscriptions */}
          <section className="space-y-4">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Crianças ({group.children.length}) · Inscrições ({group.count})
            </h3>
            {group.children.length === 0 && <p className="text-sm text-gray-400">Nenhuma criança registada.</p>}
            {group.children.map(kid => (
              <div key={kid.key} className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-gray-900">{kid.childName}</span>
                  {(kid.schoolName || kid.schoolYear) && (
                    <span className="text-xs text-gray-500">{[kid.schoolName, kid.schoolYear].filter(Boolean).join(' · ')}</span>
                  )}
                  <button
                    onClick={() => setEditChildKey(editChildKey === kid.key ? null : kid.key)}
                    className="ml-auto text-xs text-blue-600 hover:underline"
                    title="Editar dados da criança (aplica-se a todas as suas inscrições)">✏️ Dados da criança</button>
                </div>
                {editChildKey === kid.key && (
                  <ChildDetailsForm
                    group={kid}
                    onSaved={(patch, newChildId) => {
                      const ids = new Set(kid.items.map(i => i.id));
                      data.setItems(prev => prev.map(i => ids.has(i.id)
                        ? { ...i, ...patch, ...(newChildId ? { childId: newChildId } : {}) }
                        : i));
                      setEditChildKey(null);
                    }}
                    onCancel={() => setEditChildKey(null)}
                  />
                )}
                {kid.items.length === 0 && <p className="text-xs text-gray-400 pl-1">Sem inscrições.</p>}
                {kid.items.map(item => (
                  <SubscriptionCard
                    key={`${item._type}-${item.id}`}
                    ref={item.id === highlightId ? highlightRef : undefined}
                    highlighted={item.id === highlightId}
                    item={item}
                    billLine={standardLine(linesBySub.get(item.id))}
                    actions={actions}
                    transportConfig={data.transportConfig}
                    studyConfig={data.studyConfig}
                    discountRules={data.discountRules}
                    onShowHistory={setHistoryItem}
                    onLinked={familyId => { if (familyId !== group.key) onFamilyKeyChange(familyId); }}
                  />
                ))}
              </div>
            ))}
          </section>

          {group.familyId && (
            <div className="flex items-center justify-between pt-4 border-t border-gray-200">
              <p className="text-[11px] text-gray-300">families/{group.familyId}</p>
              <button onClick={() => setConfirmDelete(true)}
                className="px-3 py-1.5 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50">
                Eliminar família…
              </button>
            </div>
          )}
        </div>
      </aside>

      {historyItem && (
        <VersionHistoryModal item={historyItem} onClose={() => setHistoryItem(null)} />
      )}
      {confirmDelete && group.familyId && (
        <DeleteFamilyModal
          group={group}
          allChildren={data.children}
          onClose={() => setConfirmDelete(false)}
          onDeleted={() => { setConfirmDelete(false); onClose(); data.reload(); }}
        />
      )}
    </>
  );
}

function Field({ label, value, warn, wide }: { label: string; value?: string | null; warn?: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`break-words ${warn ? 'text-red-700 font-medium' : 'text-gray-800'}`}>
        {value || '—'}
        {warn && <span className="ml-1.5 text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">{warn}</span>}
      </p>
    </div>
  );
}
