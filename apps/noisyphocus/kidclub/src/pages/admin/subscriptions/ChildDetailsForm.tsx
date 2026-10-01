import { useState, useEffect } from 'react';
import { updateDoc, addDoc } from 'firebase/firestore';
import { col, docRef } from '../../../lib/db';
import EnrollmentDetailsForm, { EnrollmentDetailsValue, EMPTY_ENROLLMENT_DETAILS, EMPTY_ENROLLMENT_ADDRESS, validateEnrollmentDetails } from '../../../components/EnrollmentDetailsForm';
import { familyService } from '../../../services/familyService';
import { calculateAge } from '../../../lib/utils';
import { SubItem, ChildGroup } from './model';

// ─── Child details form ───────────────────────────────────────────────────────
// Writes the canonical children/{childId} record, then mirrors the handful of
// fields functions/src/kidclub still reads off the subscription onto EVERY one
// of this child's subscriptions at once — which is the point: one edit, one
// value, no way for two subscriptions of the same child to disagree.
export default function ChildDetailsForm({ group, onSaved, onCancel }: {
  group: ChildGroup;
  onSaved: (patch: Partial<SubItem>, newChildId?: string) => void;
  onCancel: () => void;
}) {
  const [details, setDetails] = useState<EnrollmentDetailsValue>(() => {
    const parts = group.childName.trim().split(' ');
    return {
      ...EMPTY_ENROLLMENT_DETAILS,
      firstName: parts[0] ?? '', lastName: parts.slice(1).join(' '),
      schoolName: group.schoolName ?? '', schoolYear: group.schoolYear ?? '',
    };
  });
  const [errors, setErrors] = useState<Partial<Record<keyof EnrollmentDetailsValue, string>>>({});
  const [loading, setLoading] = useState(!!group.childId);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const originalSchool = group.schoolName ?? '';

  // dateOfBirth and homeAddress only exist on the children doc.
  useEffect(() => {
    if (!group.childId) return;
    familyService.getChild(group.childId).then(c => {
      if (!c) { setLoadFailed(true); return; }
      setDetails(prev => ({
        ...prev,
        firstName: c.firstName ?? prev.firstName,
        lastName: c.lastName ?? prev.lastName,
        dateOfBirth: c.dateOfBirth && !isNaN(c.dateOfBirth.getTime()) ? c.dateOfBirth.toISOString().split('T')[0] : '',
        schoolName: c.schoolName ?? prev.schoolName,
        schoolYear: c.schoolYear ?? prev.schoolYear,
        homeAddress: c.homeAddress
          ? { street: c.homeAddress.street ?? '', city: c.homeAddress.city ?? '', postalCode: c.homeAddress.postalCode ?? '', country: c.homeAddress.country ?? '' }
          : EMPTY_ENROLLMENT_ADDRESS,
      }));
    }).catch(() => setLoadFailed(true)).finally(() => setLoading(false));
  }, [group.childId]);

  const submit = async () => {
    const errs = validateEnrollmentDetails(details);
    // Guardian contact is edited at the family level, not here.
    delete errs.contactEmail;
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setSaving(true);
    setSaveError(null);
    try {
      const fullName = `${details.firstName.trim()} ${details.lastName.trim()}`;
      const dob = new Date(details.dateOfBirth + 'T12:00:00');
      const childDoc = {
        firstName: details.firstName.trim(), lastName: details.lastName.trim(),
        dateOfBirth: dob, age: calculateAge(dob),
        schoolName: details.schoolName.trim() || null,
        schoolYear: details.schoolYear.trim() || null,
        homeAddress: {
          street: details.homeAddress.street.trim(), city: details.homeAddress.city.trim(),
          postalCode: details.homeAddress.postalCode.trim(), country: details.homeAddress.country.trim() || null,
        },
        updatedAt: new Date(),
      };

      let childId = group.childId;
      if (childId) {
        await updateDoc(docRef('children', childId), childDoc);
      } else {
        // Legacy gap: a subscription predating automatic child creation. Same
        // familyId: '' placeholder ManualEnrollForm uses for an admin-created
        // child awaiting claim — the claim flow links to it rather than
        // duplicating it (see PendingChild.existingChild).
        // userId from the family owner, or the parent never sees this child
        // (portal queries and rules match on userId, not familyId).
        const ownerUid = group.familyId ? await familyService.getFamilyOwnerUid(group.familyId) : '';
        const ref = await addDoc(col('children'), {
          ...childDoc, familyId: group.familyId ?? '', ...(ownerUid ? { userId: ownerUid } : {}),
          status: 'active', createdAt: new Date(),
        });
        childId = ref.id;
      }

      // Mirror onto every subscription this child holds. These copies are not
      // read by any page any more, but functions/src/kidclub still reads them:
      // sub.childName (billing line-item titles, notification emails) and
      // sub.schoolName (discountRecalc's auto_school rule — the 20% Colégio
      // Bissaya Barreto transport discount).
      const failures: string[] = [];
      for (const item of group.items) {
        const colName = item._type === 'study' ? 'studyroom' : 'transportationSubscriptions';
        const patch: Record<string, any> = {
          childName: fullName,
          schoolName: details.schoolName.trim() || null,
          updatedAt: new Date(),
        };
        if (item._type === 'study') patch.schoolYear = details.schoolYear.trim() || null;
        if (!item.childId && childId) patch.childId = childId;
        // The parent should see a change the team made to their child's record.
        if (item.familyId) patch.clientReviewPending = true;
        try {
          await updateDoc(docRef(colName, item.id), patch);
        } catch (err: any) {
          console.error(`Failed to mirror child details onto ${colName}/${item.id}:`, err);
          failures.push(item.id);
        }
      }
      if (failures.length) {
        setSaveError(`Dados da criança guardados, mas ${failures.length} inscrição(ões) não ficaram sincronizadas. Recarregue e tente novamente.`);
        return;
      }

      onSaved({
        childName: fullName,
        schoolName: details.schoolName.trim() || undefined,
        schoolYear: details.schoolYear.trim() || undefined,
      }, group.childId ? undefined : childId);
    } catch (err: any) {
      console.error('Failed to save child details:', err);
      setSaveError(`Falha ao guardar os dados da criança: ${err?.message ?? 'erro desconhecido'}`);
    } finally { setSaving(false); }
  };

  const schoolChanged = details.schoolName.trim() !== originalSchool.trim();

  return (
    <div className="bg-white rounded-lg border border-blue-200 p-4 mb-2 space-y-3">
      <p className="text-sm font-semibold text-gray-700">Dados da criança</p>
      <p className="text-xs text-gray-400">
        Aplica-se a todas as inscrições desta criança ({group.items.length}).
      </p>
      {!group.childId && (
        <p className="text-xs text-amber-600">
          Esta criança ainda não tem registo próprio — ao guardar, cria-se um e as inscrições ficam associadas a ele.
        </p>
      )}
      {loadFailed && (
        <p className="text-xs text-amber-600">Não foi possível carregar o registo da criança — data de nascimento e morada podem estar em branco.</p>
      )}
      {loading ? (
        <p className="text-xs text-gray-400">A carregar dados da criança…</p>
      ) : (
        <EnrollmentDetailsForm value={details} onChange={setDetails} showContactFields={false} errors={errors} />
      )}
      {schoolChanged && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          Mudar a escola pode alterar a mensalidade de transporte — o desconto de escola é
          resolvido a partir deste campo.
        </p>
      )}
      {saveError && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">{saveError}</p>
      )}
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || loading}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60 font-medium">
          {saving ? 'A guardar…' : 'Guardar'}
        </button>
        <button onClick={onCancel} className="text-sm px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200">Cancelar</button>
      </div>
    </div>
  );
}
