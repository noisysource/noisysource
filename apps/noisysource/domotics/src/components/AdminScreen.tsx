import { useEffect, useState } from 'react';
import {
  ArrowLeft, Activity, ScrollText, RefreshCw, Power, Loader2,
} from 'lucide-react';
import { runAdmin, type AdminAction } from '../lib/admin';

/**
 * Bridge administration, for when the house is not within reach.
 *
 * Deliberately plain: this is a diagnostic tool, not part of controlling the
 * house, and it is used when something is already wrong. Output is shown raw
 * and monospaced rather than parsed into a dashboard — when a thermostat is
 * unreachable from another country, the exact text of the log is worth more
 * than a tidy summary of it.
 */

interface Props {
  onBack: () => void;
  /** When the relayed house state was last published, for the offline hint. */
  bridgeUpdatedAt?: number;
}

const ACTIONS: Array<{
  action: AdminAction;
  label: string;
  icon: typeof Activity;
  confirm?: string;
}> = [
  { action: 'status', label: 'Estado', icon: Activity },
  { action: 'logs', label: 'Registos', icon: ScrollText },
  { action: 'refresh', label: 'Atualizar', icon: RefreshCw },
  {
    action: 'restart',
    label: 'Reiniciar',
    icon: Power,
    confirm: 'Reiniciar a ponte? O controlo da casa fica indisponível durante alguns segundos.',
  },
];

export function AdminScreen({ onBack, bridgeUpdatedAt }: Props) {
  const [busy, setBusy] = useState<AdminAction | null>(null);
  const [output, setOutput] = useState<string>('');
  const [failed, setFailed] = useState(false);
  const [ranAt, setRanAt] = useState<number | null>(null);

  // The most useful thing on this screen before anything is clicked: whether
  // the bridge has published recently. If it has not, every action below will
  // simply time out, and knowing that up front saves 45 seconds of waiting.
  const age = bridgeUpdatedAt ? Math.round((Date.now() - bridgeUpdatedAt) / 1000) : null;
  const stale = age === null || age > 600;

  async function invoke(action: AdminAction, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(action);
    setFailed(false);
    setOutput('');
    try {
      const res = await runAdmin(action, action === 'logs' ? { lines: 80 } : {});
      setOutput(res.output);
      setFailed(!res.ok);
    } catch (err) {
      setOutput((err as Error).message);
      setFailed(true);
    } finally {
      setBusy(null);
      setRanAt(Date.now());
    }
  }

  // Status is what you almost always want first, so do it without being asked.
  useEffect(() => {
    void invoke('status');
    // Intentionally once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col overflow-hidden">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-zinc-900 shrink-0">
        <button
          onClick={onBack}
          className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 transition-colors"
          aria-label="Voltar"
        >
          <ArrowLeft size={18} strokeWidth={2} />
        </button>
        <div className="min-w-0">
          <h1 className="text-sm font-medium tracking-tight">Ponte</h1>
          <p className="text-xs text-zinc-500 truncate">
            {age === null
              ? 'sem estado publicado'
              : stale
                ? `sem sinal há ${Math.round(age / 60)} min — provavelmente offline`
                : `estado publicado há ${age}s`}
          </p>
        </div>
        <span
          className={`ml-auto w-2 h-2 rounded-full shrink-0 ${stale ? 'bg-red-500' : 'bg-emerald-500'}`}
          aria-label={stale ? 'offline' : 'online'}
        />
      </header>

      <div className="flex gap-2 px-4 py-3 overflow-x-auto shrink-0">
        {ACTIONS.map(({ action, label, icon: Icon, confirm }) => (
          <button
            key={action}
            onClick={() => void invoke(action, confirm)}
            disabled={busy !== null}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-40 ${
              action === 'restart'
                ? 'bg-zinc-900 hover:bg-red-950 text-zinc-400 hover:text-red-300'
                : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300'
            }`}
          >
            {busy === action
              ? <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              : <Icon size={14} strokeWidth={2} />}
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 px-4 pb-4">
        <pre
          className={`h-full overflow-auto rounded-xl bg-zinc-900/60 border p-3 text-xs leading-relaxed font-mono whitespace-pre ${
            failed ? 'border-red-900/60 text-red-300' : 'border-zinc-800 text-zinc-300'
          }`}
        >
{busy
  ? `A executar ${busy}…\n\nA ponte responde no próximo ciclo — até 10 segundos.`
  : output || 'Sem resultados.'}
        </pre>
        {ranAt && !busy && (
          <p className="mt-2 text-[11px] text-zinc-600">
            {new Date(ranAt).toLocaleTimeString('pt-PT')}
          </p>
        )}
      </div>
    </div>
  );
}
