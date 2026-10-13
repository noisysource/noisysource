import { SubItem, isUnlinked, needsAdminReview, toDate } from './model';
import { FamilyInfo } from './listModel';
import { StatusBadge, CLIENT_ACTION_BADGE } from './badges';

const tag = 'text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap';

/** Family-level state: billing problems, a bad NIF, a failed Vendus sync, a duplicate account. */
export function FamilyTags({ fam }: { fam: FamilyInfo }) {
  const overdueTotal = fam.overdue.reduce((s, b) => s + b.total, 0);
  const noAccount = !fam.familyId && !fam.key.startsWith('child:');
  const syncError = fam.family?.vendusSyncError;
  if (!fam.invoiceErrors.length && !fam.nifInvalid && !syncError && !fam.overdue.length && !fam.duplicate && !noAccount) return null;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {fam.invoiceErrors.length > 0 && (
        <span className={`${tag} bg-red-100 text-red-800`} title={fam.invoiceErrors.map(b => `${b.periodLabel}: ${b.invoiceError}`).join('\n')}>
          🧾 erro de fatura{fam.invoiceErrors.length > 1 ? ` (${fam.invoiceErrors.length})` : ''}
        </span>
      )}
      {fam.nifInvalid && <span className={`${tag} bg-red-100 text-red-800`}>NIF inválido</span>}
      {syncError && (
        <span className={`${tag} bg-red-100 text-red-800`}
          title={`${syncError.at ? `${toDate(syncError.at).toLocaleString('pt-PT')}: ` : ''}${syncError.message ?? ''}`}>
          Vendus: sincronização falhou
        </span>
      )}
      {fam.overdue.length > 0 && (
        <span className={`${tag} bg-red-50 text-red-700 border border-red-200`}
          title={fam.overdue.map(b => `${b.periodLabel}: €${b.total.toFixed(2)}`).join('\n')}>
          ⏰ €{overdueTotal.toFixed(2)} em atraso{fam.overdue.length > 1 ? ` (${fam.overdue.length} meses)` : ''}
        </span>
      )}
      {fam.duplicate && <span className={`${tag} bg-orange-100 text-orange-700`}>⚠ possível duplicado</span>}
      {noAccount && <span className={`${tag} bg-orange-50 text-orange-700 border border-orange-200`}>sem conta</span>}
    </span>
  );
}

/** Subscription-level state, read-only — acting on it happens in the panel. */
export function SubscriptionTags({ item }: { item: SubItem }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      <StatusBadge status={item.status} cancelRequested={item.cancelRequested} />
      {needsAdminReview(item) && (
        <span className={`${tag} ${item.lastClientAction ? CLIENT_ACTION_BADGE[item.lastClientAction].cls : 'bg-pink-100 text-pink-800'}`}>
          {item.lastClientAction ? CLIENT_ACTION_BADGE[item.lastClientAction].label : '🔔 alteração do cliente'}
        </span>
      )}
      {item.clientReviewPending && <span className={`${tag} bg-purple-100 text-purple-800`}>⏳ aguarda encarregado</span>}
      {isUnlinked(item) && <span className={`${tag} bg-orange-100 text-orange-700`}>não vinculado</span>}
      {item.feeReviewRequired && <span className={`${tag} bg-amber-100 text-amber-800`}>⚠ rever mensalidade</span>}
      {item._type === 'transport' && item.status !== 'cancelled' && !item.routeAssigned && (
        <span className={`${tag} bg-gray-50 text-gray-400 border border-gray-200`}>🗺 sem rota</span>
      )}
    </span>
  );
}
