import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import { DEFAULT_TARIFF, parseTariff, type Tariff } from '@shared/lib/energyBill';
import { saveTariff } from '../../data/energyHistory';

/**
 * "Tarifário": the prices the Energia page bills with, saved to
 * `domotics_config/tariff` (owner only). Prices without VAT, as the supplier's
 * price list and the bill's detail show them. Saving is what turns the page's
 * figures from estimates into the real thing.
 */

interface Props {
  tariff: Tariff;
  canSave: boolean;
  onSaved: (t: Tariff) => void;
  onClose: () => void;
}

type NumKey = { [K in keyof Tariff]: Tariff[K] extends number ? K : never }[keyof Tariff];

const input = 'w-full rounded-lg bg-zinc-950 border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-100 tabular-nums focus:outline-none focus:border-zinc-400';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-300">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-zinc-500 leading-snug">{hint}</span>}
    </label>
  );
}

export default function TariffEditor({ tariff, canSave, onSaved, onClose }: Props) {
  const [t, setT] = useState<Tariff>(tariff);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const num = (key: NumKey, step: string, unit?: string) => (
    <div className="flex items-center gap-1.5">
      <input
        type="number" inputMode="decimal" step={step} min={0} className={input}
        value={Number.isFinite(t[key]) ? t[key] : ''}
        onChange={e => setT(prev => ({ ...prev, [key]: e.target.value === '' ? NaN : Number(e.target.value) }))}
      />
      {unit && <span className="text-xs text-zinc-500 whitespace-nowrap">{unit}</span>}
    </div>
  );
  const dflt = (key: NumKey) => `Por omissão: ${String(DEFAULT_TARIFF[key]).replace('.', ',')}`;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveTariff(t));
    } catch (err) {
      setError((err as { code?: string }).code === 'permission-denied'
        ? 'Esta conta não pode alterar o tarifário.'
        : 'Não foi possível guardar. Tente de novo.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" role="dialog" aria-modal="true" aria-label="Tarifário">
      <div className="w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-zinc-800 bg-zinc-900 p-4 flex flex-col gap-4"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-base font-semibold text-zinc-100">Tarifário</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400" aria-label="Fechar">
            <X size={15} />
          </button>
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Preços <b className="text-zinc-200">sem IVA</b>, como aparecem no tarifário do comercializador ou no detalhe da fatura.
          O IVA e as taxas são calculados aqui.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <Field label="Comercializador">
              <input className={input} value={t.supplier} placeholder="ex.: EDP Comercial"
                onChange={e => setT(prev => ({ ...prev, supplier: e.target.value }))} />
            </Field>
          </div>
          <Field label="Fora de vazio" hint={dflt('priceForaVazio')}>{num('priceForaVazio', '0.0001', '€/kWh')}</Field>
          <Field label="Vazio" hint={dflt('priceVazio')}>{num('priceVazio', '0.0001', '€/kWh')}</Field>
          <Field label="Vazio de">
            <input type="time" className={input} value={t.vazioFrom} onChange={e => setT(prev => ({ ...prev, vazioFrom: e.target.value }))} />
          </Field>
          <Field label="até" hint="Bi-horário, ciclo diário: 22:00–08:00">
            <input type="time" className={input} value={t.vazioTo} onChange={e => setT(prev => ({ ...prev, vazioTo: e.target.value }))} />
          </Field>
          <Field label="Potência contratada">{num('powerKva', '0.01', 'kVA')}</Field>
          <Field label="Termo de potência" hint={dflt('powerPerDay')}>{num('powerPerDay', '0.0001', '€/dia')}</Field>
          <Field label="A fatura começa no dia" hint="Dia do mês em que começa cada período de faturação">
            <input type="number" min={1} max={28} step={1} className={input} value={t.billingDay}
              onChange={e => setT(prev => ({ ...prev, billingDay: Number(e.target.value) }))} />
          </Field>
        </div>

        <button onClick={() => setAdvanced(v => !v)} className="self-start flex items-center gap-1.5 text-xs text-zinc-300 hover:text-zinc-100">
          Taxas e IVA {advanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {advanced && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Imposto especial de consumo" hint={dflt('iecPerKwh')}>{num('iecPerKwh', '0.0001', '€/kWh')}</Field>
            <Field label="Contribuição audiovisual" hint={dflt('cavPerMonth')}>{num('cavPerMonth', '0.01', '€/mês')}</Field>
            <Field label="Taxa DGEG" hint={dflt('dgegPerMonth')}>{num('dgegPerMonth', '0.01', '€/mês')}</Field>
            <Field label="IVA normal">{num('vatStandard', '1', '%')}</Field>
            <Field label="IVA reduzido">{num('vatReduced', '1', '%')}</Field>
            <Field label="kWh com IVA reduzido" hint="Por cada 30 dias; só até 6,9 kVA. 0 se não se aplica.">{num('vatReducedKwh', '1', 'kWh')}</Field>
            <Field label="IVA da potência" hint="6 % até 3,45 kVA, 23 % acima">{num('vatPower', '1', '%')}</Field>
            <Field label="IVA da contribuição audiovisual">{num('vatCav', '1', '%')}</Field>
            <div className="col-span-2">
              <Field label="Pagamento do excedente enviado à rede"
                hint="0 = não vende: o que vai para a rede é oferecido (é o caso desta casa). Só para um contrato de venda (UPAC).">
                {num('exportPrice', '0.0001', '€/kWh')}
              </Field>
            </div>
          </div>
        )}

        {!canSave && <p className="text-xs text-amber-300">Sem sessão iniciada não é possível guardar. Os valores ficam só neste ecrã.</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="h-9 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-300">Cancelar</button>
          <button
            onClick={canSave ? save : () => onSaved(parseTariff({ ...t, confirmed: false }))}
            disabled={saving}
            className="h-9 px-4 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 text-sm font-semibold disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving && <Loader2 size={14} className="animate-spin" />} {canSave ? 'Guardar' : 'Aplicar'}
          </button>
        </div>
      </div>
    </div>
  );
}
