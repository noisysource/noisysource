import { useState } from 'react';
import { updateDoc, deleteField } from 'firebase/firestore';
import { docRef } from '../../../lib/db';
import { normalizeEmail } from '../../../lib/utils';
import { isValidNif, normalizeNif } from '../../../lib/nif';
import { SubItem, FamilyGroup, FamilyDoc, subCollection } from './model';

// ─── Family details form ──────────────────────────────────────────────────────
// Guardian contact, NIF and billing address, edited once for the whole family.
//
// Contact writes families/{id}.primaryContact (the canonical record every page
// now reads), then mirrors onto the family's children and subscriptions — the
// children copy because the Firestore rules let a parent claim an admin-created
// child by matching children/{id}.contactEmail against their auth token, the
// subscription copy because notifications.ts sends to sub.contactEmail.
//
// Only what actually changed is written. Every subscription write fires three
// backend triggers, and every families/ write fires syncVendusClient, which
// upserts the client in the LIVE Vendus account (prod only — it skips dev). So
// changing only the NIF is one families/ write and zero subscription writes.
export default function FamilyContactForm({ group, onSaved, onCancel }: {
  group: FamilyGroup;
  onSaved: (patch: Partial<SubItem>, familyPatch: Partial<FamilyDoc>) => void;
  onCancel: () => void;
}) {
  const fam = group.family;
  const initial = {
    name: group.contactName ?? '',
    email: group.contactEmail ?? '',
    phone: group.contactPhone ?? '',
    nif: fam?.nif ?? '',
    street: fam?.billingAddress?.street ?? '',
    city: fam?.billingAddress?.city ?? '',
    postalCode: fam?.billingAddress?.postalCode ?? '',
  };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }));

  const t = (k: keyof typeof form) => form[k].trim();
  const contactChanged = t('name') !== initial.name.trim()
    || normalizeEmail(t('email')) !== normalizeEmail(initial.email.trim())
    || t('phone') !== initial.phone.trim();
  const nifChanged = normalizeNif(form.nif) !== normalizeNif(initial.nif);
  const addressChanged = t('street') !== initial.street.trim() || t('city') !== initial.city.trim()
    || t('postalCode') !== initial.postalCode.trim();
  const nifError = form.nif.trim() && !isValidNif(form.nif) ? 'NIF inválido (falha o dígito de controlo).' : null;
  // Opening the form on a family whose stored NIF is already bad is the usual
  // way in here — say so up front rather than only on save.
  const storedNifInvalid = !!initial.nif && !isValidNif(initial.nif);

  const submit = async () => {
    if (!t('email')) { setSaveError('Email do encarregado é obrigatório.'); return; }
    if (nifError) { setSaveError(nifError); return; }
    const anyAddress = t('street') || t('city') || t('postalCode');
    if (anyAddress && !(t('street') && t('city') && t('postalCode'))) {
      setSaveError('Morada de faturação incompleta: rua, localidade e código postal.'); return;
    }
    if (!contactChanged && !nifChanged && !addressChanged) { onCancel(); return; }

    setSaving(true);
    setSaveError(null);
    const email = normalizeEmail(t('email'));
    try {
      const familyPatch: Partial<FamilyDoc> = {};
      if (group.familyId) {
        const update: Record<string, any> = { updatedAt: new Date() };
        if (contactChanged) {
          // Merge: blanking an optional field here must not wipe what the
          // family already has.
          const primaryContact = {
            ...(fam?.primaryContact ?? {}),
            ...(t('name') ? { name: t('name') } : {}),
            email,
            ...(t('phone') ? { phone: t('phone') } : {}),
          };
          update.primaryContact = primaryContact;
          familyPatch.primaryContact = primaryContact;
        }
        if (nifChanged) {
          const nif = normalizeNif(form.nif);
          update.nif = nif || deleteField();
          familyPatch.nif = nif || undefined;
        }
        if (addressChanged) {
          const billingAddress = anyAddress
            ? { street: t('street'), city: t('city'), postalCode: t('postalCode'), country: fam?.billingAddress?.country || 'PT' }
            : undefined;
          update.billingAddress = billingAddress ?? deleteField();
          familyPatch.billingAddress = billingAddress;
        }
        await updateDoc(docRef('families', group.familyId), update);
      }

      if (contactChanged) {
        const childIds = new Set(group.children.map(c => c.childId).filter(Boolean) as string[]);
        for (const childId of childIds) {
          try {
            await updateDoc(docRef('children', childId), {
              contactEmail: email,
              ...(t('phone') ? { contactPhone: t('phone') } : {}),
              updatedAt: new Date(),
            });
          } catch (err) {
            console.error(`Failed to mirror contact onto children/${childId}:`, err);
          }
        }

        const failures: string[] = [];
        for (const item of group.children.flatMap(c => c.items)) {
          const patch: Record<string, any> = {
            contactName: t('name') || null,
            contactEmail: email,
            updatedAt: new Date(),
          };
          // transport spells it contactMobile, study spells it contactPhone
          if (item._type === 'transport') patch.contactMobile = t('phone') || null;
          else patch.contactPhone = t('phone') || null;
          try {
            await updateDoc(docRef(subCollection(item), item.id), patch);
          } catch (err: any) {
            console.error(`Failed to mirror contact onto ${subCollection(item)}/${item.id}:`, err);
            failures.push(item.id);
          }
        }
        if (failures.length) {
          setSaveError(`Contactos guardados, mas ${failures.length} inscrição(ões) não ficaram sincronizadas. Recarregue e tente novamente.`);
          return;
        }
      }

      onSaved(
        contactChanged ? { contactName: t('name') || undefined, contactEmail: email, contactPhone: t('phone') || undefined } : {},
        familyPatch,
      );
    } catch (err: any) {
      console.error('Failed to save family details:', err);
      setSaveError(`Falha ao guardar os dados da família: ${err?.message ?? 'erro desconhecido'}`);
    } finally { setSaving(false); }
  };

  const fieldCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300';

  return (
    <div className="bg-white rounded-lg border border-blue-200 p-4 space-y-3">
      <p className="text-sm font-semibold text-gray-700">Dados da família</p>
      {!group.familyId && (
        <p className="text-xs text-amber-600">
          Sem conta vinculada — os contactos ficam guardados nas próprias inscrições até o encarregado reclamar a conta.
          NIF e morada de faturação só existem numa conta.
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Nome do encarregado</label>
          <input type="text" value={form.name} onChange={set('name')} className={fieldCls} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Email do encarregado *</label>
          <input type="email" value={form.email} onChange={set('email')} className={fieldCls} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Telefone</label>
          <input type="tel" value={form.phone} onChange={set('phone')} className={fieldCls} />
        </div>
        {group.familyId && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">NIF</label>
            <input type="text" inputMode="numeric" value={form.nif} onChange={set('nif')}
              className={`${fieldCls} ${nifError ? 'border-red-400 focus:ring-red-200' : ''}`} />
            {nifError
              ? <p className="text-xs text-red-600 mt-1">{nifError}</p>
              : storedNifInvalid && !nifChanged && <p className="text-xs text-red-600 mt-1">O NIF guardado é inválido — o Vendus recusa as faturas.</p>}
          </div>
        )}
      </div>
      {group.familyId && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">Morada de faturação</p>
          <input type="text" placeholder="Rua" value={form.street} onChange={set('street')} className={fieldCls} />
          <div className="grid grid-cols-2 gap-3">
            <input type="text" placeholder="Código postal" value={form.postalCode} onChange={set('postalCode')} className={fieldCls} />
            <input type="text" placeholder="Localidade" value={form.city} onChange={set('city')} className={fieldCls} />
          </div>
        </div>
      )}
      {contactChanged && group.count > 0 && (
        <p className="text-xs text-gray-500">
          Os contactos novos são copiados para as {group.count} inscrição{group.count !== 1 ? 'ões' : ''} desta família.
        </p>
      )}
      {group.familyId && fam?.profileComplete && (contactChanged || nifChanged || addressChanged) && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          Ao guardar, o cliente é atualizado no Vendus (conta real, em produção).
        </p>
      )}
      {saveError && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">{saveError}</p>
      )}
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !!nifError}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60 font-medium">
          {saving ? 'A guardar…' : 'Guardar'}
        </button>
        <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200">Cancelar</button>
      </div>
    </div>
  );
}
