import { useState, forwardRef } from 'react';
import { TransportationConfig } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { DiscountRule } from '@shared/models/Discount';
import { grossFromAppliedDiscounts } from '../../../services/discountService';
import { SubStatus } from '../../../lib/utils';
import { SubItem, isUnlinked, needsAdminReview, isLegacyPricing } from './model';
import { BillLine, lineNet } from '../../../lib/billingLines';
import { StatusBadge, CLIENT_ACTION_BADGE } from './badges';
import { SubscriptionActions, statusChangeEffects } from './useSubscriptionActions';
import EditForm from './EditForm';
import MiniWeekCalendar from './MiniWeekCalendar';

const STATUS_OPTIONS: { key: SubStatus; label: string }[] = [
  { key: 'pending', label: 'Pendente' },
  { key: 'active', label: 'Ativo' },
  { key: 'cancelled', label: 'Cancelado' },
];

/**
 * One subscription inside the family panel: status, tags, price and
 * discounts, and the per-subscription edit form. Who the child is and how to
 * reach the guardian are edited on the child / family level above it.
 */
const SubscriptionCard = forwardRef<HTMLDivElement, {
  item: SubItem;
  /** This subscription's line on its current (or next) bill, if it has one. */
  billLine?: BillLine;
  highlighted?: boolean;
  actions: SubscriptionActions;
  transportConfig: TransportationConfig | null;
  studyConfig: StudyCenterConfig | null;
  discountRules: DiscountRule[];
  onShowHistory: (item: SubItem) => void;
  onLinked: (familyId: string) => void;
}>(function SubscriptionCard({ item, billLine, highlighted, actions, transportConfig, studyConfig, discountRules, onShowHistory, onLinked }, ref) {
  const [editing, setEditing] = useState(false);
  const busy = actions.processing === item.id;

  return (
    <div ref={ref}
      className={`bg-white rounded-lg border p-4 transition-colors ${highlighted ? 'border-blue-400 ring-2 ring-blue-200' : 'border-gray-200'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-3 flex-1 min-w-0">
          <div className="text-2xl mt-0.5 shrink-0">{item._type === 'study' ? '📚' : '🚌'}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-gray-700">{item._type === 'study' ? 'Sala de Estudo' : 'Transporte'}</span>
              <StatusBadge status={item.status} cancelRequested={item.cancelRequested} />
              {isUnlinked(item) && (
                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">não vinculado</span>
              )}
              {item.feeReviewRequired && (
                <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium">⚠ rever mensalidade</span>
              )}
              {needsAdminReview(item) && (
                <button onClick={() => actions.resolveClientAction(item)} disabled={busy}
                  className={`text-xs px-2 py-0.5 rounded-full font-medium disabled:opacity-60 ${item.lastClientAction ? CLIENT_ACTION_BADGE[item.lastClientAction].cls : 'bg-pink-100 text-pink-800 hover:bg-pink-200'}`}
                  title={item.lastClientAction === 'confirmed' ? 'Clique para ativar a inscrição' : 'Clique para marcar como revisto'}>
                  {item.lastClientAction ? CLIENT_ACTION_BADGE[item.lastClientAction].label : '🔔 alteração do cliente'}
                </button>
              )}
              {item.adminReviewPending && !needsAdminReview(item) && (
                <button onClick={() => actions.resolveClientAction(item)} disabled={busy}
                  className="text-xs px-2 py-0.5 rounded-full font-medium bg-gray-50 text-gray-500 border border-gray-200 hover:border-gray-400 disabled:opacity-60"
                  title="O encarregado aceitou a última alteração. Nada a fazer — clique para limpar.">
                  ✓ encarregado confirmou
                </button>
              )}
              {item.clientReviewPending && (
                <span className="text-xs bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full font-medium"
                  title="O encarregado ainda não viu/confirmou esta alteração">
                  ⏳ aguarda encarregado
                </span>
              )}
              {item._type === 'transport' && item.status !== 'cancelled' && (
                <button onClick={() => actions.toggleRouteAssigned(item)} disabled={busy}
                  className={`text-xs px-2 py-0.5 rounded-full font-medium disabled:opacity-60 ${item.routeAssigned ? 'bg-teal-100 text-teal-800 hover:bg-teal-50' : 'bg-gray-50 text-gray-400 border border-gray-200 hover:border-gray-400'}`}
                  title="Rota atribuída (apenas controlo operacional interno)">
                  {item.routeAssigned ? '🗺 rota atribuída' : '🗺 sem rota'}
                </button>
              )}
            </div>

            <MiniWeekCalendar item={item} />
            <DiscountRow item={item} billLine={billLine} discountRules={discountRules} actions={actions} busy={busy} />

            {item.note && <p className="text-xs text-gray-500 mt-1 italic">"{item.note}"</p>}
            {item.statusReason && item.status === 'cancelled' && <p className="text-xs text-red-600 mt-1">Motivo: {item.statusReason}</p>}
            <p className="text-xs text-gray-400 mt-1.5 flex flex-wrap items-center gap-2">
              <span>Criada a {item.createdAt.toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
              <button onClick={() => actions.toggleLegacyPricing(item)} disabled={busy}
                className={`px-2 py-0.5 rounded-full font-medium disabled:opacity-60 ${isLegacyPricing(item) ? 'bg-amber-100 text-amber-800 hover:bg-amber-50' : 'bg-gray-50 text-gray-500 border border-gray-200 hover:border-gray-400'}`}
                title="Tarifário antigo: a fatura cobra o valor deste cartão (descontos somados) até ao fim do ano letivo. Tarifário novo: multi-viagem e irmão aplicados por viagem/criança.">
                {isLegacyPricing(item) ? '🔒 Tarifário antigo' : 'Tarifário novo'}
              </button>
            </p>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {/* Direct status control — any direction, but each click spells out
              what it sets off (emails, events, billing) before writing. */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
            {STATUS_OPTIONS.map(({ key, label }, idx) => {
              const effects = statusChangeEffects(item.status, key);
              return (
                <button key={key} onClick={() => actions.setStatus(item, key)} disabled={busy}
                  title={item.status === key ? 'Estado atual' : effects.join('\n') || undefined}
                  className={`px-2.5 py-1.5 whitespace-nowrap disabled:opacity-60 ${idx > 0 ? 'border-l border-gray-200' : ''} ${item.status === key
                    ? (key === 'active' ? 'bg-green-600 text-white' : key === 'cancelled' ? 'bg-gray-600 text-white' : 'bg-yellow-500 text-white')
                    : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
                  {label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1">
            {isUnlinked(item) && (
              <>
                <button
                  onClick={async () => { const fid = await actions.linkToFamily(item); if (fid) onLinked(fid); }}
                  disabled={busy}
                  className="bg-orange-50 text-orange-700 border border-orange-200 text-xs px-2.5 py-1 rounded-lg hover:bg-orange-100 disabled:opacity-60 whitespace-nowrap"
                  title={item.familyId ? 'Vincular criança pelo nome' : `Vincular família pelo email ${item.contactEmail}`}>
                  {busy ? '…' : '🔗 Vincular'}
                </button>
                <button onClick={() => actions.hardDelete(item)} disabled={busy}
                  className="text-red-400 hover:text-red-600 text-sm px-2 py-1 disabled:opacity-60"
                  title="Eliminar">🗑</button>
              </>
            )}
            {item.status !== 'cancelled' && (
              <button onClick={() => setEditing(v => !v)}
                className={`text-sm px-2 py-1 ${editing ? 'text-blue-600' : 'text-gray-400 hover:text-blue-600'}`}
                title="Editar horário, descontos e nota">✏️</button>
            )}
            <button onClick={() => onShowHistory(item)}
              className="text-gray-400 hover:text-indigo-600 text-sm px-2 py-1"
              title="Histórico de alterações">🕐</button>
          </div>
          {item.feeReviewRequired && (
            <button onClick={() => actions.clearFeeReview(item)} disabled={busy}
              className="bg-amber-50 text-amber-800 border border-amber-300 text-xs px-2.5 py-1.5 rounded-lg hover:bg-amber-100 disabled:opacity-60 whitespace-nowrap font-medium">
              {busy ? '…' : '✓ Mensalidade revista'}
            </button>
          )}
        </div>
      </div>

      {editing && (
        <EditForm
          item={item}
          transportConfig={transportConfig}
          studyConfig={studyConfig}
          discountRules={discountRules}
          onSave={updated => { actions.patchItem(item.id, updated); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
});

export default SubscriptionCard;

function DiscountRow({ item, billLine, discountRules, actions, busy }: {
  item: SubItem;
  billLine?: BillLine;
  discountRules: DiscountRule[];
  actions: SubscriptionActions;
  busy: boolean;
}) {
  const storedFee = item._type === 'transport' ? (item.monthlyFee ?? 0) : (item.monthlyPrice ?? 0);
  // New pricing bills multi-trip/sibling per trip/child, so the stored fee
  // (the flat model) can differ from what the bill charges — show the bill's
  // amount (net of discounts, before absences). Old pricing bills the stored
  // fee, so the card keeps it.
  const billed = billLine && !isLegacyPricing(item) ? lineNet(billLine) : undefined;
  const fee = billed ?? storedFee;
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const applied = item.appliedDiscounts ?? [];
  const autoApplied = applied.filter(d => d.appliedBy === 'auto');
  const adminApplied = applied.filter(d => d.appliedBy === 'admin');

  // Any active rule for this scope not yet applied — not just
  // trigger:'manual' ones, so an auto rule that didn't
  // auto-match can still be turned on by hand from the row.
  const availableRules = discountRules.filter(r =>
    r.active &&
    r.appliesTo.includes(item._type) &&
    !applied.some(d => d.ruleId === r.id)
  );

  if (fee === 0 && applied.length === 0 && availableRules.length === 0) return null;

  const gross = billed != null
    ? billLine!.grossAmount
    : item._type === 'study'
      ? (item.basePrice != null && item.basePrice > fee + 0.01 ? item.basePrice : null)
      : grossFromAppliedDiscounts(fee, applied);
  const hasDiscount = gross != null && gross > fee + 0.01;

  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex items-baseline gap-1.5">
        {hasDiscount && <span className="text-xs text-gray-400 line-through">€{gross!.toFixed(2)}</span>}
        <span className={`text-xs font-semibold ${hasDiscount ? 'text-green-700' : 'text-gray-800'}`}
          title={billed != null ? 'Valor da fatura (tarifário novo), antes de faltas' : undefined}>€{fee.toFixed(2)}/mês</span>
        {billed != null && Math.abs(billed - storedFee) > 0.005 && (
          <span className="text-[11px] text-gray-400" title="Valor guardado na inscrição (modelo antigo); a fatura usa o tarifário novo">
            (inscrição: €{storedFee.toFixed(2)})
          </span>
        )}
      </div>

      {/* Applied auto discounts — clickable to override off */}
      {autoApplied.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Auto</span>
          {autoApplied.map(d => {
            const rule = discountRules.find(r => r.id === d.ruleId);
            if (!rule) return (
              <span key={d.ruleId} className="text-xs px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 font-medium">
                {d.name} -{pct(d.percentage)}
              </span>
            );
            return (
              <button key={d.ruleId}
                onClick={() => actions.toggleManualDiscount(item, rule)}
                disabled={busy}
                className="text-xs px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 font-medium hover:bg-blue-100 disabled:opacity-50"
                title="Clique para desativar (substitui a deteção automática)">
                {d.name} -{pct(d.percentage)}
              </button>
            );
          })}
        </div>
      )}

      {/* Applied admin discounts — clickable to remove */}
      {adminApplied.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Manual</span>
          {adminApplied.map(d => {
            const rule = discountRules.find(r => r.id === d.ruleId);
            if (!rule) return (
              <span key={d.ruleId} className="text-xs px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-800 font-medium">
                {d.name} -{pct(d.percentage)}
              </span>
            );
            return (
              <button key={d.ruleId}
                onClick={() => actions.toggleManualDiscount(item, rule)}
                disabled={busy}
                className="text-xs px-2 py-0.5 rounded-full border border-amber-300 bg-amber-100 text-amber-800 font-medium hover:bg-amber-50 disabled:opacity-50"
                title="Clique para remover">
                ★ {d.name} -{pct(d.percentage)}
              </button>
            );
          })}
        </div>
      )}

      {/* Overrides present — offer a way back to automatic */}
      {Object.keys(item.discountOverrides ?? {}).length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Ajustado</span>
          <button
            onClick={() => actions.resetDiscountsToAuto(item)}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded-full border border-purple-300 bg-purple-50 text-purple-700 font-medium hover:bg-purple-100 disabled:opacity-50"
            title="Remove os ajustes manuais e volta a calcular os descontos automaticamente">
            ↺ Repor automático
          </button>
        </div>
      )}

      {/* Any other active rule for this scope — click to apply */}
      {item.status !== 'cancelled' && availableRules.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">Adicionar</span>
          {availableRules.map(r => (
            <button key={r.id}
              onClick={() => actions.toggleManualDiscount(item, r)}
              disabled={busy}
              className="text-xs px-2 py-0.5 rounded-full border border-gray-200 bg-white text-gray-400 font-medium hover:border-gray-400 hover:text-gray-600 disabled:opacity-50"
              title="Clique para aplicar">
              ☆ {r.name} -{pct(r.percentage)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
