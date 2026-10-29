import { useEffect, useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { loadGuardSettings, saveGuardSetting, type GuardSettings, type GuardStatus } from '../data/guard';
import { ago } from './HealthChips';

/**
 * The E13 guard in the app: what it is doing, its last action, and its two
 * settings (the guard, and its early warning). The guard runs on the Pi
 * (domotics-bridge/src/guard.ts) and switches the heat pump off and on by
 * itself, so each switch asks for a second tap; the bridge picks the change up
 * within two minutes.
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

  const [settings, setSettings] = useState<GuardSettings | null>(null);
  const [confirming, setConfirming] = useState<keyof GuardSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canEdit) return;
    loadGuardSettings()
      .then(setSettings)
      .catch(err => setError((err as { code?: string }).code === 'permission-denied'
        ? 'Esta conta não pode alterar a proteção.'
        : 'Não foi possível ler a definição.'));
  }, [canEdit]);

  async function save(key: keyof GuardSettings, next: boolean) {
    setSaving(true);
    setError(null);
    try {
      await saveGuardSetting({ [key]: next });
      setSettings(s => (s ? { ...s, [key]: next } : s));
      setConfirming(null);
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
    : status.reonAt ? <Pill tone="info">Liga às {hhmm(status.reonAt)}</Pill>
    : <Pill tone="ok">A vigiar</Pill>;
  const enabled = settings?.enabled ?? null;
  // What the app has saved can be ahead of what the bridge has picked up.
  const pending = enabled !== null && status && enabled !== status.enabled;
  const pre = status?.preempt;
  const prePending = !!settings && !!pre && settings.enabled && status?.enabled === true && settings.preempt !== pre.enabled;
  // Stopped for two trips anyway: that's in the note already.
  const preLine = !status || !status.enabled || stale ? null
    : !pre ? 'A ponte ainda não antecipa o E13 — precisa de ser atualizada.'
    : pre.offUntil ? null
    : `${pre.note}${pre.active && pre.stopsToday > 0 && pre.lastStop ? ` (a última às ${hhmm(pre.lastStop.at)})` : ''}`;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-3.5 flex flex-col gap-2.5">
      <div className="flex items-start gap-2">
        <ShieldAlert size={16} className="shrink-0 mt-px text-zinc-400" />
        <h2 className="flex-1 min-w-0 text-sm font-semibold text-zinc-100">Proteção E13 da bomba</h2>
        {pill}
      </div>

      <p className="text-xs text-zinc-400 leading-relaxed">
        Desliga a bomba 60 min quando fica parada no setpoint (é aí que o E13 dispara) e 120 min logo a seguir a
        um disparo, para não chegar ao bloqueio. Com «Antecipar o E13», desliga-a também 5 min quando a descarga sobe de
        repente — o sinal que, desde 26/10, vem 1–2 min antes de cada disparo. Isto vem sempre primeiro: a automação não
        a liga durante um descanso.
      </p>
      <p className="text-xs text-zinc-400 leading-relaxed">
        {status?.automationOwns
          ? 'Desligada de fora (painel, SmartLife, temporizador): com a automação ligada, é ela que decide quando volta a ligar.'
          : 'Desligada de fora (painel, SmartLife, temporizador): com a automação desligada ou só a simular, volta a ligá-la 5 min depois; se a voltarem a desligar na hora seguinte, deixa-a desligada. Desligar pela app é respeitado.'}
        {' '}Em pausa (botão Pausar da automação), não liga a bomba de forma nenhuma até a pausa acabar.
      </p>

      {status && status.enabled && !stale && (
        <p className="text-xs text-zinc-200">{status.note}</p>
      )}
      {preLine && <p className="text-xs text-zinc-300">{preLine}</p>}
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
      {canEdit && settings && (
        <div className="flex flex-col gap-2 border-t border-zinc-800 pt-2.5">
          <Setting
            label={`Proteção ${settings.enabled ? 'ligada' : 'desligada'}`}
            pending={!!pending}
            action={settings.enabled ? 'Desligar' : 'Ligar'}
            confirm={settings.enabled
              ? 'Desligar a proteção? Se a bomba estiver em descanso, volta a ligar já.'
              : 'Ligar a proteção? A ponte passa a desligar e ligar a bomba sozinha.'}
            confirming={confirming === 'enabled'}
            saving={saving}
            onAsk={() => setConfirming('enabled')}
            onCancel={() => setConfirming(null)}
            onSave={() => void save('enabled', !settings.enabled)}
          />
          {settings.enabled && (
            <Setting
              label={`Antecipar o E13: ${settings.preempt ? 'sim' : 'não'}`}
              pending={prePending}
              action={settings.preempt ? 'Desligar' : 'Ligar'}
              confirm={settings.preempt
                ? 'Deixar de antecipar o E13? A bomba trabalha até disparar, como antes; depois de um disparo continua a descansar 120 min.'
                : 'Antecipar o E13? A ponte desliga a bomba 5 min quando a descarga sobe de repente, 1–2 min antes do disparo, e volta a ligá-la.'}
              confirming={confirming === 'preempt'}
              saving={saving}
              onAsk={() => setConfirming('preempt')}
              onCancel={() => setConfirming(null)}
              onSave={() => void save('preempt', !settings.preempt)}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** One setting: what it is, a button, and the second tap. */
function Setting(p: {
  label: string;
  pending: boolean;
  action: string;
  confirm: string;
  confirming: boolean;
  saving: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (!p.confirming) {
    return (
      <div className="flex items-center gap-3">
        <span className="flex-1 text-sm text-zinc-200">
          {p.label}
          {p.pending && <span className="text-[11px] text-zinc-500"> · o Pi aplica em até 2 min</span>}
        </span>
        <button
          type="button"
          onClick={p.onAsk}
          className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
        >
          {p.action}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-zinc-300 leading-snug">{p.confirm}</p>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={p.onCancel}
          className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400">
          Cancelar
        </button>
        <button type="button" onClick={p.onSave} disabled={p.saving}
          className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 font-semibold disabled:opacity-40">
          {p.saving ? 'A guardar…' : p.action}
        </button>
      </div>
    </div>
  );
}
