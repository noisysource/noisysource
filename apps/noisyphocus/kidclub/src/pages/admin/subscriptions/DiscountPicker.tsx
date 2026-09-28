import { DiscountRule, AppliedDiscount, DiscountScope } from '@shared/models/Discount';
import { applyDiscounts } from '../../../services/discountService';

// ─── Discount picker (shared by ManualEnrollForm and EditForm) ────────────────
// Single source of truth for the fee math: applyDiscounts() here is the exact
// same function the list view's toggleManualDiscount/computeGross use, so
// whatever total is shown on screen is exactly what gets persisted.
export default function DiscountPicker({ rules, scope, selected, onToggle, gross }: {
  rules: DiscountRule[];
  scope: DiscountScope;
  selected: AppliedDiscount[];
  onToggle: (rule: DiscountRule) => void;
  gross: number;
}) {
  const applicable = rules.filter(r => r.active && r.appliesTo.includes(scope));
  const net = applyDiscounts(gross, selected);
  if (applicable.length === 0 && selected.length === 0) return null;
  return (
    <div className="space-y-2 bg-gray-50 rounded-lg p-3 border border-gray-100">
      <p className="text-xs font-semibold text-gray-600">Descontos</p>
      <div className="flex flex-wrap gap-2">
        {applicable.map(rule => {
          const isSelected = selected.some(d => d.ruleId === rule.id);
          return (
            <label key={rule.id}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border cursor-pointer transition-colors ${isSelected ? 'bg-blue-50 border-blue-300 text-blue-800' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-400'}`}>
              <input type="checkbox" checked={isSelected} onChange={() => onToggle(rule)} className="accent-blue-600" />
              {rule.name} -{(rule.percentage * 100).toFixed(0)}%
            </label>
          );
        })}
        {applicable.length === 0 && <p className="text-xs text-gray-400">Sem regras de desconto para este serviço.</p>}
      </div>
      <div className="flex items-baseline gap-2 text-sm pt-1">
        {net < gross - 0.01 && <span className="text-gray-400 line-through">€{gross.toFixed(2)}</span>}
        <span className="font-semibold text-gray-800">€{net.toFixed(2)}/mês</span>
      </div>
    </div>
  );
}
