import { useState } from 'react';
import { CURRENCY_OPTIONS, type CurrencyCode } from '../types/finance';
import { useTreasury } from '../contexts/TreasuryContext';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function OnboardingModal() {
  const { completeOnboarding } = useTreasury();
  const [currencyCode, setCurrencyCode] = useState<CurrencyCode>('EUR');
  const [fiscalStartMonth, setFiscalStartMonth] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);

  const handleInit = async (loadSampleData: boolean) => {
    setSubmitting(true);
    try {
      await completeOnboarding({ currencyCode, fiscalStartMonth, loadSampleData });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100 flex items-center justify-center p-6">
      <div className="max-w-xl w-full bg-[#0F172A] border border-slate-800 rounded-xl p-8 space-y-6">
        <div className="space-y-2">
          <p className="text-xs font-medium text-blue-400">Workspace Setup</p>
          <h1 className="text-2xl font-semibold text-slate-50">Configure your financial baseline</h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            Select your fixed reporting currency across all personal and company accounts. You can start with a sample multi-entity portfolio or begin with a clean ledger.
          </p>
        </div>

        <div className="space-y-4 pt-2">
          <div>
            <label htmlFor="currency-select" className="block text-xs font-medium text-slate-300 mb-1.5">
              Fixed Workspace Currency
            </label>
            <select
              id="currency-select"
              value={currencyCode}
              onChange={(e) => setCurrencyCode(e.target.value as CurrencyCode)}
              className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
            >
              {CURRENCY_OPTIONS.map((opt) => (
                <option key={opt.code} value={opt.code}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="fiscal-month" className="block text-xs font-medium text-slate-300 mb-1.5">
              Fiscal Year Start Month
            </label>
            <select
              id="fiscal-month"
              value={fiscalStartMonth}
              onChange={(e) => setFiscalStartMonth(Number(e.target.value))}
              className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
            >
              {MONTHS.map((m, idx) => (
                <option key={m} value={idx + 1}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => handleInit(true)}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            {submitting ? 'Initializing...' : 'Load Sample Portfolio'}
          </button>
          <button
            onClick={() => handleInit(false)}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 disabled:opacity-60 text-slate-200 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            Start Blank Workspace
          </button>
        </div>
      </div>
    </div>
  );
}
