import { useEffect, useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { loadGuardEnabled, saveGuardEnabled, type GuardStatus } from '../data/guard';
import { ago } from './HealthChips';

/**
 * The E13 guard in the app: what it is doing, its last action, and its one
 * setting. The guard runs on the Pi (domotics-bridge/src/guard.ts) and switches
 * the heat pump off and on by itself, so the switch asks for a second tap; the
 * bridge picks the change up within two minutes.
 */

interface Props {
  /** From the bridge's state; undefined on a bridge that predates the guard. */
  status?: GuardStatus;
  /** The setting is the owner's alone (firestore.rules): editable only signed in. */
  canEdit: boolean;
}

const STALE_MS = 10 * 60_000;
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

function Pill({ tone, children }: { tone: 'ok' | 'info' | 'idle' | 'warn' | 'bad'; children: ReactNode }) {
  const cls = {
    ok: 'bg-emerald-950/70 text-emerald-300',
    info: 'bg-sky-950/70 text-sky-300',
    idle: 'bg-zinc-800 text-zinc-400',
    warn: 'bg-amber-950/70 text-amber-300',
    bad: 'bg-red-950/70 text-red-300',
  }[tone];
  const dot = { ok: 'bg-emerald-400', info: 'bg-sky-400', idle: 'bg-zinc-500', warn: 'bg-amber-400', bad: 'bg-red-400' }[tone];
  return (
    <span className={`flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md whitespace-nowrap ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />{children}
    </span>
  );
}

export default function GuardCard({ status, canEdit }: Props) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canEdit) return;
    loadGuardEnabled()
      .then(setEnabled)
      .catch(err => setError((err as { code?: string }).code === 'permission-denied'
        ? 'Esta conta não pode alterar a proteção.'
        : 'Não foi possível ler a definição.'));
  }, [canEdit]);

  async function save(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      await saveGuardEnabled(next);
      setEnabled(next);
      setConfirming(false);
    } catch {
      setError('Não foi possível guardar.');
    } finally {
      setSaving(false);
    }
  }

  const age = status ? now - status.evaluatedAt : undefined;
  const stale = age !== undefined && age > STALE_MS;
  const pill = !status ? <Pill tone="idle">Ponte sem proteção</Pill>
    : stale ? <Pill tone="warn">Sem notícias da ponte há {ago(age!)}</Pill>
    : !status.enabled ? <Pill tone="idle">Desligada</Pill>
    : status.mode === 'rest' ? <Pill tone="info">Bomba em descanso</Pill>
    : status.mode === 'lockout' ? <Pill tone="bad">Bomba bloqueada</Pill>
    : <Pill tone="ok">A vigiar</Pill>;
  // What the app has saved can be ahead of what the bridge has picked up.
  const pending = enabled !== null && status && enabled !== status.enabled;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-3.5 flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <ShieldAlert size={16} className="shrink-0 mt-px text-zinc-400" />
        <h2 className="flex-1 min-w-0 text-sm font-semibold text-zinc-100">Proteção E13 da bomba</h2>
        {pill}
      </div>

      <p className="text-xs text-zinc-400 leading-relaxed">
        Desliga a bomba 60 min quando fica parada no setpoint (é aí que o E13 dispara) e 120 min logo a seguir a
        um disparo, para não chegar ao bloqueio. Nunca liga uma bomba desligada por alguém.
      </p>

      {status && status.enabled && !stale && (
        <p className="text-xs text-zinc-200">{status.note}</p>
      )}
      {status?.lastAction && (
        <p className="text-xs text-zinc-500 tabular-nums">
          Última ação: {hhmm(status.lastAction.at)} · {status.lastAction.what === 'on' ? 'ligou' : 'desligou'} — {status.lastAction.reason}
        </p>
      )}
      {!status && (
        <p className="text-xs text-zinc-500 leading-relaxed">
          A ponte (Raspberry Pi) ainda não tem a proteção — precisa de ser atualizada.
        </p>
      )}

      {!canEdit && (
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          Para ligar ou desligar, abra a app com sessão iniciada (kidclub-dev-domotics.web.app).
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {canEdit && enabled !== null && (
        <div className="flex flex-col gap-2 border-t border-zinc-800 pt-2.5">
          {!confirming ? (
            <div className="flex items-center gap-3">
              <span className="flex-1 text-sm text-zinc-200">
                {enabled ? 'Ligada' : 'Desligada'}
                {pending && <span className="text-[11px] text-zinc-500"> · o Pi aplica em até 2 min</span>}
              </span>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
              >
                {enabled ? 'Desligar' : 'Ligar'}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-zinc-300 leading-snug">
                {enabled
                  ? 'Desligar a proteção? Se a bomba estiver em descanso, volta a ligar já.'
                  : 'Ligar a proteção? A ponte passa a desligar e ligar a bomba sozinha.'}
              </p>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setConfirming(false)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400">
                  Cancelar
                </button>
                <button type="button" onClick={() => void save(!enabled)} disabled={saving}
                  className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 font-semibold disabled:opacity-40">
                  {saving ? 'A guardar…' : enabled ? 'Desligar' : 'Ligar'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
