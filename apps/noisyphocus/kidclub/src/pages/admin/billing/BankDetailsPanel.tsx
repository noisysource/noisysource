import { useEffect, useState } from 'react';
import { BankTransferConfig, useBankTransferConfig, saveBankTransferConfig, formatIban } from '../../../lib/bankTransfer';

/** The IBAN parents see on Pagamentos when they pay by bank transfer (config/billing). */
export default function BankDetailsPanel() {
  const { config, reload } = useBankTransferConfig();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<BankTransferConfig>({ iban: '', accountHolder: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => { if (config) setForm(config); }, [config]);
  if (!config) return null;

  const missing = !config.iban;
  const save = async () => {
    setSaving(true); setMsg('');
    try { await saveBankTransferConfig(form); reload(); setMsg('Guardado.'); setOpen(false); }
    catch (e: any) { setMsg(e?.message ?? 'Erro ao guardar.'); }
    finally { setSaving(false); }
  };

  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${missing ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200'}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className={missing ? 'text-amber-800' : 'text-gray-600'}>
          🏦 Dados para transferência:{' '}
          {missing
            ? <strong>IBAN por preencher — os encarregados ainda não o veem em Pagamentos.</strong>
            : <span className="font-mono">{formatIban(config.iban)}</span>}
          {!missing && config.accountHolder && <span className="text-gray-400"> · {config.accountHolder}</span>}
        </p>
        <button onClick={() => setOpen(o => !o)} className="text-xs text-indigo-600 hover:underline">{open ? 'Fechar' : 'Editar'}</button>
      </div>
      {open && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto] items-end">
          <label className="block">
            <span className="text-xs text-gray-500">IBAN</span>
            <input value={form.iban} onChange={e => setForm(f => ({ ...f, iban: e.target.value }))} placeholder="PT50 ..."
              className="mt-0.5 w-full border rounded px-2 py-1.5 text-sm font-mono" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500">Titular da conta</span>
            <input value={form.accountHolder} onChange={e => setForm(f => ({ ...f, accountHolder: e.target.value }))}
              className="mt-0.5 w-full border rounded px-2 py-1.5 text-sm" />
          </label>
          <button onClick={save} disabled={saving} className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-700 disabled:opacity-50">
            {saving ? 'A guardar...' : 'Guardar'}
          </button>
        </div>
      )}
      {msg && <p className="mt-1 text-xs text-gray-500">{msg}</p>}
    </div>
  );
}
