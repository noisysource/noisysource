import { useState } from 'react';
import { getDoc, updateDoc } from 'firebase/firestore';
import { docRef } from '../../../lib/db';
import { SubItem, FamilyGroup } from './model';

// ─── Family contact form ──────────────────────────────────────────────────────
// Guardian details, edited once for the whole family. Writes
// families/{id}.primaryContact (the canonical record every page now reads),
// then mirrors onto the family's children and subscriptions — the children
// copy because the Firestore rules let a parent claim an admin-created child
// by matching children/{id}.contactEmail against their auth token, the
// subscription copy because notifications.ts sends to sub.contactEmail.
export default function FamilyContactForm({ group, onSaved, onCancel }: {
  group: FamilyGroup;
  onSaved: (patch: Partial<SubItem>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(group.contactName ?? '');
  const [email, setEmail] = useState(group.contactEmail ?? '');
  const [phone, setPhone] = useState(group.contactPhone ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim()) { setSaveError('Email do encarregado é obrigatório.'); return; }
    setSaving(true);
    setSaveError(null);
    try {
      if (group.familyId) {
        const famSnap = await getDoc(docRef('families', group.familyId));
        const prev = famSnap.exists() ? (famSnap.data().primaryContact ?? {}) : {};
        await updateDoc(docRef('families', group.familyId), {
          // Merge: blanking an optional field here must not wipe what the
          // family already has.
          primaryContact: {
            ...prev,
            ...(name.trim() ? { name: name.trim() } : {}),
            email: email.trim(),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
          },
          updatedAt: new Date(),
        });
      }

      const childIds = new Set(group.children.map(c => c.childId).filter(Boolean) as string[]);
      for (const childId of childIds) {
        try {
          await updateDoc(docRef('children', childId), {
            contactEmail: email.trim(),
            ...(phone.trim() ? { contactPhone: phone.trim() } : {}),
            updatedAt: new Date(),
          });
        } catch (err) {
          console.error(`Failed to mirror contact onto children/${childId}:`, err);
        }
      }

      const failures: string[] = [];
      for (const item of group.children.flatMap(c => c.items)) {
        const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
        const patch: Record<string, any> = {
          contactName: name.trim() || null,
          contactEmail: email.trim(),
          updatedAt: new Date(),
        };
        // transport spells it contactMobile, study spells it contactPhone
        if (item._type === 'transport') patch.contactMobile = phone.trim() || null;
        else patch.contactPhone = phone.trim() || null;
        try {
          await updateDoc(docRef(colName, item.id), patch);
        } catch (err: any) {
          console.error(`Failed to mirror contact onto ${colName}/${item.id}:`, err);
          failures.push(item.id);
        }
      }
      if (failures.length) {
        setSaveError(`Contactos guardados, mas ${failures.length} inscrição(ões) não ficaram sincronizadas. Recarregue e tente novamente.`);
        return;
      }

      onSaved({
        contactName: name.trim() || undefined,
        contactEmail: email.trim(),
        contactPhone: phone.trim() || undefined,
      });
    } catch (err: any) {
      console.error('Failed to save family contact:', err);
      setSaveError(`Falha ao guardar os contactos: ${err?.message ?? 'erro desconhecido'}`);
    } finally { setSaving(false); }
  };

  const fieldCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300';

  return (
    <div className="bg-white rounded-lg border border-gray-300 p-4 mb-2 space-y-3">
      <p className="text-sm font-semibold text-gray-700">Contactos do encarregado</p>
      <p className="text-xs text-gray-400">
        Aplica-se a toda a família ({group.count} inscrição{group.count !== 1 ? 'ões' : ''}).
      </p>
      {!group.familyId && (
        <p className="text-xs text-amber-600">
          Sem conta vinculada — os contactos ficam guardados nas próprias inscrições até o encarregado reclamar a conta.
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Nome do encarregado</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} className={fieldCls} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Email do encarregado *</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={fieldCls} />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-gray-500 mb-1">Telefone</label>
          <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} className={fieldCls} />
        </div>
      </div>
      {saveError && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">{saveError}</p>
      )}
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60 font-medium">
          {saving ? 'A guardar…' : 'Guardar'}
        </button>
        <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200">Cancelar</button>
      </div>
    </div>
  );
}
