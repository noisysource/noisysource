import React from "react";
import type { BenefitConfig } from "@shared/models/Employment";

type Account = {
  id: string;
  name: string;
  code?: string;
  type?: string;
  ownerType?: string;
  ownerId?: string;
};

export function BenefitsEditor({
  benefits,
  accountsForPerson,
  onChange,
}: {
  benefits: BenefitConfig[];
  accountsForPerson: Account[];
  onChange: (v: BenefitConfig[]) => void;
}) {
  const isMealLike = (t?: string) => {
    const k = (t || "").toUpperCase();
    return k === "MEAL" || k === "MEAL_CARD" || k === "MEAL_VOUCHER";
  };

  // small helpers
  const toEUR = (cents?: number | null) =>
    Number.isFinite(cents as number) ? ((cents as number) / 100).toFixed(2) : "";

  const parseEURToCents = (s: string): number | undefined => {
    if (!s.trim()) return undefined;
    const n = Number(s.replace(",", "."));
    if (!Number.isFinite(n)) return undefined;
    return Math.round(n * 100);
  };

  const setAt = (idx: number, patch: Partial<BenefitConfig>) => {
    const next = [...benefits];
    next[idx] = { ...(next[idx] || {}), ...patch };
    onChange(next);
  };

  const addBenefit = () => {
    onChange([
      ...benefits,
      {
        type: "",
        perMonthCents: undefined,
        perDayCents: undefined,
        daysPerMonth: undefined,
        subjectToIRS: false,
        subjectToSS: false,
        benefitAccountId: "",
        expenseCategoryId: "",
        payableCategoryId: "",
      } as BenefitConfig,
    ]);
  };

  const removeBenefit = (idx: number) => {
    const next = [...benefits];
    next.splice(idx, 1);
    onChange(next);
  };

  const onTypeChange = (idx: number, nextType: string) => {
    const b = benefits[idx] || {};
    const goingMeal = isMealLike(nextType);
    const wasMeal = isMealLike(b.type);

    // try to preserve value while switching modes
    let perMonthCents = b.perMonthCents;
    let perDayCents = b.perDayCents;
    let daysPerMonth =
      typeof b.daysPerMonth === "number" && b.daysPerMonth > 0
        ? b.daysPerMonth
        : 22;

    if (goingMeal && !wasMeal) {
      // moving to meal-like → prefer daily; convert monthly → daily (divide by days)
      if (!perDayCents && perMonthCents && daysPerMonth > 0) {
        perDayCents = Math.round(perMonthCents / daysPerMonth);
      }
      perMonthCents = undefined;
      // ensure default 22
      if (!b.daysPerMonth) daysPerMonth = 22;
    } else if (!goingMeal && wasMeal) {
      // moving away from meal → prefer monthly; convert daily → monthly (multiply by days)
      if (!perMonthCents && perDayCents && daysPerMonth > 0) {
        perMonthCents = perDayCents * daysPerMonth;
      }
      perDayCents = undefined;
      // daysPerMonth becomes irrelevant; keep it but doesn’t affect UI
    }

    setAt(idx, { type: nextType, perMonthCents, perDayCents, daysPerMonth });
  };

  const mealDaysDefault = 22;

  return (
    <div className="space-y-3">
      {benefits.map((b, i) => {
        const meal = isMealLike(b.type);
        const dailyEUR = toEUR(b.perDayCents);
        const monthlyEUR = toEUR(b.perMonthCents);
        const days =
          typeof b.daysPerMonth === "number" && b.daysPerMonth > 0
            ? b.daysPerMonth
            : meal
            ? mealDaysDefault
            : undefined;

        return (
          <div key={i} className="p-3 rounded border border-zinc-800 space-y-2">
            <div className="grid sm:grid-cols-3 gap-2">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Type</div>
                <select
                  value={b.type || ""}
                  onChange={(e) => onTypeChange(i, e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                >
                  <option value="">— pick —</option>
                  <option value="MEAL">Meal voucher</option>
                  <option value="MEAL_CARD">Meal card</option>
                  <option value="MEAL_VOUCHER">Meal voucher (generic)</option>
                  <option value="CHILDCARE">Childcare voucher</option>
                  <option value="INFANCIA">Infância voucher</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>

              {/* Amount field switches: daily for meal, monthly otherwise */}
              {meal ? (
                <>
                  <div>
                    <div className="text-xs text-zinc-400 mb-1">Daily amount (EUR)</div>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={dailyEUR}
                      onChange={(e) =>
                        setAt(i, {
                          perDayCents: parseEURToCents(e.target.value),
                          perMonthCents: undefined, // keep only per-day for meal
                        })
                      }
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                      placeholder="e.g. 8.32"
                    />
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400 mb-1">Days / month</div>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={days ?? mealDaysDefault}
                      onChange={(e) =>
                        setAt(i, { daysPerMonth: Math.max(1, Math.min(31, Number(e.target.value) || mealDaysDefault)) })
                      }
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <div className="text-xs text-zinc-400 mb-1">Monthly amount (EUR)</div>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={monthlyEUR}
                      onChange={(e) =>
                        setAt(i, {
                          perMonthCents: parseEURToCents(e.target.value),
                          perDayCents: undefined, // keep only per-month for non-meal
                        })
                      }
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                      placeholder="e.g. 120.00"
                    />
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400 mb-1">Days / month (opt.)</div>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={b.daysPerMonth ?? ""}
                      onChange={(e) =>
                        setAt(i, {
                          daysPerMonth: e.target.value ? Math.max(1, Math.min(31, Number(e.target.value) || 0)) : undefined,
                        })
                      }
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                      placeholder="—"
                    />
                  </div>
                </>
              )}

              <div>
                <div className="text-xs text-zinc-400 mb-1">Benefit account</div>
                <select
                  value={(b as any).benefitAccountId || ""}
                  onChange={(e) => setAt(i, { benefitAccountId: e.target.value })}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                >
                  <option value="">— pick —</option>
                  {accountsForPerson.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}{a.code ? ` — ${a.code}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-xs flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!b.subjectToIRS}
                  onChange={(e) => setAt(i, { subjectToIRS: e.target.checked })}
                />
                Subject to IRS
              </label>
              <label className="text-xs flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!b.subjectToSS}
                  onChange={(e) => setAt(i, { subjectToSS: e.target.checked })}
                />
                Subject to SS
              </label>

              <button
                type="button"
                onClick={() => removeBenefit(i)}
                className="text-red-400 text-xs underline"
              >
                Remove
              </button>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={addBenefit}
        className="text-sm px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
      >
        + Add benefit
      </button>
    </div>
  );
}