import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Minus, Plus, Bot, AlarmClock } from 'lucide-react';
import {
  DEFAULT_AUTOMATION, clearWarmBy, loadAutomationConfig, saveAutomationConfig, setWarmBy,
  type AutomationConfig, type AutomationStatus, type WarmByStatus, type WarmupModel,
} from '../data/automation';
import { ago } from './HealthChips';

/**
 * The heating automation in the app: whether it is running, what it decided
 * and why, what it did lately — and its settings. The automation itself runs
 * on the Pi (domotics-bridge/src/automation.ts); this only reads its status
 * and edits `domotics_config/automation`, which the bridge picks up within
 * two minutes.
 */

interface Props {
  /** From the bridge's state; undefined on a bridge that predates the automation. */
  status?: AutomationStatus;
  /** Settings are the owner's alone (firestore.rules): editable only signed in. */
  canEdit: boolean;
}

/** Past this, the status shown is older than the bridge would ever leave it. */
const STALE_MS = 10 * 60_000;

const label = 'text-[10px] uppercase tracking-widest text-zinc-500';

function Pill({ tone, children }: { tone: 'ok' | 'info' | 'idle' | 'warn'; children: ReactNode }) {
  const cls = {
    ok: 'bg-emerald-950/70 text-emerald-300',
    info: 'bg-sky-950/70 text-sky-300',
    idle: 'bg-zinc-800 text-zinc-400',
    warn: 'bg-amber-950/70 text-amber-300',
  }[tone];
  const dot = { ok: 'bg-emerald-400 animate-pulse', info: 'bg-sky-400', idle: 'bg-zinc-500', warn: 'bg-amber-400' }[tone];
  return (
    <span className={`flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md whitespace-nowrap ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />{children}
    </span>
  );
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
/** "07:00 amanhã" — the requests are at most a day ahead. */
function whenLabel(ms: number, now: number) {
  const d = new Date(ms);
  const tomorrow = new Date(now + 86_400_000);
  return `${hhmm(ms)}${sameDay(d, new Date(now)) ? ' hoje' : sameDay(d, tomorrow) ? ' amanhã' : ''}`;
}

export default function AutomationCard({ status, canEdit }: Props) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const age = status ? now - status.evaluatedAt : undefined;
  const stale = age !== undefined && age > STALE_MS;
  const pill = !status ? <Pill tone="idle">Ponte sem automação</Pill>
    : stale ? <Pill tone="warn">Sem notícias da ponte há {ago(age!)}</Pill>
    : status.state === 'running' ? <Pill tone="ok">Ativa</Pill>
    : status.state === 'dry-run' ? <Pill tone="info">Simulação — não envia nada</Pill>
    : <Pill tone="idle">Desligada</Pill>;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-3.5 flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <Bot size={16} className="shrink-0 mt-px text-zinc-400" />
        <h2 className="flex-1 min-w-0 text-sm font-semibold text-zinc-100">Automação do aquecimento</h2>
        {pill}
      </div>

      {!status && (
        <p className="text-xs text-zinc-500 leading-relaxed">
          A ponte (Raspberry Pi) ainda não tem a automação — precisa de ser atualizada.
        </p>
      )}

      {status && status.state !== 'off' && (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <div className="flex flex-col">
              <span className={label}>Período</span>
              <span className="text-sm text-zinc-100 capitalize">{status.periodLabel ?? '—'}</span>
            </div>
            <div className="flex flex-col">
              <span className={label}>Alvo das divisões</span>
              <span className="text-sm text-zinc-100 tabular-nums">
                {status.roomTarget !== undefined ? `${status.roomTarget}°` : '—'}
                {status.boost && <span className="text-amber-300 text-xs"> · bónus solar</span>}
              </span>
            </div>
            <div className="flex flex-col">
              <span className={label}>Água (pavimento)</span>
              <span className="text-sm text-zinc-100 tabular-nums">
                {status.flowTarget !== undefined ? `${status.flowTarget}°` : '—'}
                {status.flowManual && <span className="text-zinc-400 text-xs"> · à mão</span>}
                {status.recovery && !status.flowManual && <span className="text-amber-300 text-xs"> · recuperação</span>}
              </span>
            </div>
            <div className="flex flex-col">
              <span className={label}>Exterior (bomba)</span>
              <span className="text-sm text-zinc-100 tabular-nums">
                {status.outdoor !== undefined ? `${status.outdoor.toFixed(1)}°` : '—'}
              </span>
            </div>
          </div>

          {status.pumpHold && (
            <p className="text-xs text-amber-300 leading-snug">Bomba: {status.pumpHold}.</p>
          )}
          {status.recovery && (
            <p className="text-xs text-amber-300 leading-snug">
              Recuperação: divisões {status.shortfall?.toFixed(1)}° abaixo do alvo em média — água no máximo até chegarem lá.
            </p>
          )}
          {status.restUntil !== undefined && (
            <p className="text-xs text-sky-300 leading-snug">
              Bomba em descanso até às {hhmm(status.restUntil)} (não fica parada no setpoint — é aí que o E13 dispara).
            </p>
          )}

          <ul className="flex flex-col gap-1">
            {status.reasons.map((r, i) => (
              <li key={i} className="text-xs text-zinc-400 leading-snug">{r}</li>
            ))}
          </ul>

          {status.zones.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className={label}>Zonas</span>
              {status.zones.map(z => (
                <div key={z.id} className="flex gap-2 text-xs">
                  <span className="w-28 shrink-0 truncate text-zinc-300">{z.name}</span>
                  <span className="text-zinc-500">{z.note}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {status && status.actions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={label}>Últimas ações</span>
          {status.actions.slice(0, 6).map((a, i) => (
            <div key={i} className="flex gap-2 text-xs tabular-nums">
              <span className="text-zinc-500 shrink-0">{hhmm(a.at)}</span>
              <span className="text-zinc-300 shrink-0 max-w-[7rem] truncate">{a.device}</span>
              <span className="flex-1 min-w-0 text-zinc-400">{a.what}</span>
              <span className={`shrink-0 ${a.error ? 'text-red-400' : a.sent ? 'text-emerald-400' : 'text-sky-400'}`}>
                {a.error ? 'falhou' : a.sent ? 'enviado' : 'simulado'}
              </span>
            </div>
          ))}
        </div>
      )}

      {status && <WarmBy status={status.warmBy ?? null} model={status.model} canEdit={canEdit} now={now} />}

      <Settings canEdit={canEdit} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Warm by HH:MM
// ---------------------------------------------------------------------------

const PHASE: Record<WarmByStatus['phase'], { text: string; tone: 'ok' | 'info' | 'idle' | 'warn' }> = {
  waiting: { text: 'Agendado', tone: 'info' },
  heating: { text: 'A aquecer', tone: 'ok' },
  holding: { text: 'Hora chegou', tone: 'idle' },
  done: { text: 'Terminado', tone: 'idle' },
};

function errorText(err: unknown) {
  const e = err as { code?: string; message?: string };
  if (e.code === 'functions/permission-denied') return 'Só o dono da casa pode marcar.';
  if (e.code === 'functions/unauthenticated') return 'Inicie sessão para marcar.';
  if (e.code === 'functions/invalid-argument') return `Pedido inválido: ${e.message}`;
  return 'Não foi possível guardar o pedido.';
}

/**
 * The one-off "warm by HH:MM": the bridge's plan for it (when it starts, why,
 * how it went), and — signed in — setting or cancelling it through the
 * `domoticsWarmBy` callable, which the chat will use too.
 */
function WarmBy({ status, model, canEdit, now }: {
  status: WarmByStatus | null; model?: WarmupModel; canEdit: boolean; now: number;
}) {
  const [time, setTime] = useState('07:00');
  const [target, setTarget] = useState(status?.target ?? DEFAULT_AUTOMATION.comfort);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Saved here, not yet in the bridge's status (it reads the request every 2 min). */
  const [sent, setSent] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setSent(done);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const phase = status ? PHASE[status.phase] : null;
  const input = 'bg-zinc-800 border border-zinc-700 rounded-md px-1.5 py-1 text-sm text-zinc-100 tabular-nums';
  const btn = 'w-7 h-7 flex items-center justify-center rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30';

  return (
    <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3">
      <div className="flex items-center gap-2">
        <AlarmClock size={13} className="text-zinc-400" />
        <span className={`flex-1 ${label}`}>Quente às…</span>
        {phase && <Pill tone={status!.late && status!.phase !== 'done' ? 'warn' : phase.tone}>{phase.text}</Pill>}
      </div>

      {status ? (
        <>
          <p className="text-sm text-zinc-100 tabular-nums">
            {whenLabel(status.at, now)} · {status.target}°
            {status.current !== null && <span className="text-zinc-500 text-xs"> · agora {status.current}°</span>}
          </p>
          <p className={`text-xs leading-snug ${status.late ? 'text-amber-300' : 'text-zinc-400'}`}>{status.note}</p>
        </>
      ) : (
        <p className="text-xs text-zinc-500">Sem pedido. Marque uma hora e a automação começa a aquecer a tempo.</p>
      )}

      {model && (
        <p className="text-[11px] text-zinc-500 leading-snug">
          Como a casa aquece: chão quente ~{model.floorMin} min depois de a bomba arrancar
          {model.floorSamples > 0 ? ` (${model.floorSamples} medições)` : ' (dos registos de 21–24/10)'}; divisões
          {' '}{model.roomRatePerH.toFixed(2).replace('.', ',')}°/h
          {model.roomSamples > 0 ? ` (${model.roomSamples} medições)` : ' (valor inicial, a aprender)'}.
        </p>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <input type="time" className={input} value={time} onChange={e => setTime(e.target.value)} aria-label="Hora" />
          <button type="button" className={btn} onClick={() => setTarget(t => Math.max(18, t - 0.5))} disabled={target <= 18} aria-label="Menos"><Minus size={13} /></button>
          <span className="w-10 text-center text-sm tabular-nums text-zinc-100">{target.toFixed(1)}°</span>
          <button type="button" className={btn} onClick={() => setTarget(t => Math.min(26, t + 0.5))} disabled={target >= 26} aria-label="Mais"><Plus size={13} /></button>
          <button
            type="button"
            onClick={() => void run(() => setWarmBy(time, target), `Pedido para as ${time} guardado — o Pi faz o plano em até 2 min.`)}
            disabled={busy || !/^\d{2}:\d{2}$/.test(time)}
            className="ml-auto text-xs px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 font-semibold disabled:opacity-40"
          >
            {busy ? 'A guardar…' : status ? 'Mudar' : 'Marcar'}
          </button>
          {status && status.phase !== 'done' && (
            <button
              type="button"
              onClick={() => void run(clearWarmBy, 'Pedido cancelado — o Pi deixa-o em até 2 min.')}
              disabled={busy}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 disabled:opacity-40"
            >
              Cancelar
            </button>
          )}
        </div>
      )}
      {sent && <p className="text-[11px] text-emerald-300">{sent}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function Toggle({ on, onChange, children, hint }: {
  on: boolean; onChange: (v: boolean) => void; children: ReactNode; hint?: string;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={`mt-0.5 shrink-0 w-9 h-5 rounded-full relative transition-colors ${on ? 'bg-emerald-500' : 'bg-zinc-700'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
      <span className="flex flex-col">
        <span className="text-sm text-zinc-200">{children}</span>
        {hint && <span className="text-[11px] text-zinc-500 leading-snug">{hint}</span>}
      </span>
    </label>
  );
}

function Stepper({ label: text, value, step, min, max, unit, onChange }: {
  label: string; value: number; step: number; min: number; max: number; unit: string;
  onChange: (v: number) => void;
}) {
  const set = (v: number) => onChange(Math.round(Math.min(max, Math.max(min, v)) / step) * step);
  const btn = 'w-7 h-7 flex items-center justify-center rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30';
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 min-w-0 text-xs text-zinc-400">{text}</span>
      <button type="button" className={btn} onClick={() => set(value - step)} disabled={value <= min} aria-label="Menos"><Minus size={13} /></button>
      <span className="w-16 text-center text-sm tabular-nums text-zinc-100">
        {Number.isInteger(step) ? value : value.toFixed(1)}{unit}
      </span>
      <button type="button" className={btn} onClick={() => set(value + step)} disabled={value >= max} aria-label="Mais"><Plus size={13} /></button>
    </div>
  );
}

function Times({ label: text, from, to, onChange }: {
  label: string; from: string; to: string; onChange: (from: string, to: string) => void;
}) {
  const input = 'bg-zinc-800 border border-zinc-700 rounded-md px-1.5 py-1 text-sm text-zinc-100 tabular-nums';
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 min-w-0 text-xs text-zinc-400">{text}</span>
      <input type="time" className={input} value={from} onChange={e => onChange(e.target.value, to)} />
      <span className="text-zinc-500 text-xs">–</span>
      <input type="time" className={input} value={to} onChange={e => onChange(from, e.target.value)} />
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3">
      <span className={label}>{title}</span>
      {children}
    </div>
  );
}

function Settings({ canEdit }: { canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<AutomationConfig | null>(null);
  const [cfg, setCfg] = useState<AutomationConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !canEdit || saved) return;
    loadAutomationConfig()
      .then(c => { setSaved(c); setCfg(c); })
      .catch(err => setError((err as { code?: string }).code === 'permission-denied'
        ? 'Esta conta não pode alterar a automação.'
        : 'Não foi possível ler as definições.'));
  }, [open, canEdit, saved]);

  const dirty = !!cfg && !!saved && JSON.stringify(cfg) !== JSON.stringify(saved);
  const patch = <K extends keyof AutomationConfig>(key: K, value: AutomationConfig[K]) =>
    setCfg(c => (c ? { ...c, [key]: value } : c));

  async function save() {
    if (!cfg) return;
    setSaving(true);
    setError(null);
    try {
      await saveAutomationConfig(cfg);
      setSaved(cfg);
    } catch {
      setError('Não foi possível guardar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
      >
        Configurar {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      {open && !canEdit && (
        <p className="text-xs text-zinc-500 leading-relaxed">
          Para alterar, abra a app com sessão iniciada (kidclub-dev-domotics.web.app). Na rede local só se vê o estado.
        </p>
      )}
      {open && error && <p className="text-xs text-red-400">{error}</p>}

      {open && cfg && (
        <div className="flex flex-col gap-3">
          <Toggle on={cfg.enabled} onChange={v => patch('enabled', v)} hint="Desligada: o Pi não decide nem envia nada.">
            Automação ligada
          </Toggle>
          <Toggle on={cfg.dryRun} onChange={v => patch('dryRun', v)} hint="Decide e mostra o que faria, sem enviar nada aos aparelhos. Bom para os primeiros dias.">
            Só simular
          </Toggle>

          <Group title="Conforto">
            <Stepper label="Temperatura da casa" value={cfg.comfort} step={0.5} min={cfg.limits.roomMin} max={cfg.limits.roomMax} unit="°" onChange={v => patch('comfort', v)} />
          </Group>

          <Group title="Horário (tarifa bi-horária)">
            <Times label="Pré-aquecimento (fim do vazio)" from={cfg.preheat.from} to={cfg.preheat.to} onChange={(from, to) => patch('preheat', { ...cfg.preheat, from, to })} />
            <Stepper label="…acima do conforto" value={cfg.preheat.delta} step={0.5} min={0} max={2} unit="°" onChange={v => patch('preheat', { ...cfg.preheat, delta: v })} />
            <Times label="Poupança (fim do dia)" from={cfg.evening.from} to={cfg.evening.to} onChange={(from, to) => patch('evening', { ...cfg.evening, from, to })} />
            <Stepper label="…abaixo do conforto" value={cfg.evening.delta} step={0.5} min={-2} max={0} unit="°" onChange={v => patch('evening', { ...cfg.evening, delta: v })} />
            <p className="text-[11px] text-zinc-500 leading-snug">
              Do fim da poupança ao pré-aquecimento é o vazio (noite): mantém o conforto com eletricidade barata.
            </p>
          </Group>

          <Group title="Bónus solar">
            <Toggle on={cfg.solarBoost.enabled} onChange={v => patch('solarBoost', { ...cfg.solarBoost, enabled: v })} hint="Com excedente solar durante o dia, sobe o alvo para guardar calor no pavimento.">
              Guardar o sol no pavimento
            </Toggle>
            <Stepper label="Subida" value={cfg.solarBoost.delta} step={0.5} min={0} max={2} unit="°" onChange={v => patch('solarBoost', { ...cfg.solarBoost, delta: v })} />
            <Stepper label="A partir de exportar" value={cfg.solarBoost.exportW} step={100} min={100} max={5000} unit=" W" onChange={v => patch('solarBoost', { ...cfg.solarBoost, exportW: v })} />
          </Group>

          <Group title="Água do pavimento">
            <Toggle on={cfg.flow.enabled} onChange={v => patch('flow', { ...cfg.flow, enabled: v })} hint="Usa o sensor exterior da própria bomba. Água mais fria = bomba mais eficiente.">
              Seguir a temperatura exterior
            </Toggle>
            <Stepper label="Com 15° lá fora" value={cfg.flow.at15} step={1} min={25} max={45} unit="°" onChange={v => patch('flow', { ...cfg.flow, at15: v })} />
            <Stepper label="Por cada grau mais frio" value={cfg.flow.slope} step={0.1} min={0} max={3} unit="°" onChange={v => patch('flow', { ...cfg.flow, slope: v })} />
            <Stepper label="Mínimo" value={cfg.flow.min} step={1} min={25} max={cfg.flow.max} unit="°" onChange={v => patch('flow', { ...cfg.flow, min: v })} />
            <Stepper label="Máximo" value={cfg.flow.max} step={1} min={cfg.flow.min} max={45} unit="°" onChange={v => patch('flow', { ...cfg.flow, max: v })} />
          </Group>

          <Group title="Recuperação">
            <Toggle on={cfg.recovery.enabled} onChange={v => patch('recovery', { enabled: v })} hint="Divisões mais de 0,5° abaixo do alvo: água no máximo até lá chegarem. Nunca baixa a água enquanto estiverem abaixo.">
              Recuperar depressa
            </Toggle>
          </Group>

          <Group title="Descanso no setpoint (E13)">
            <Toggle on={cfg.rest.enabled} onChange={v => patch('rest', { ...cfg.rest, enabled: v })} hint="Quando a água chega ao setpoint com o compressor no mínimo, desliga e descansa em vez de ficar parada e voltar a acelerar. Com a proteção E13 ligada é ela que desliga.">
              Desligar em vez de ficar parada
            </Toggle>
            <Stepper label="Descanso" value={cfg.rest.minutes} step={15} min={15} max={240} unit=" min" onChange={v => patch('rest', { ...cfg.rest, minutes: v })} />
          </Group>

          <Group title="Bomba">
            <Toggle on={cfg.pumpFollowsZones.enabled} onChange={v => patch('pumpFollowsZones', { ...cfg.pumpFollowsZones, enabled: v })} hint="Desliga a bomba quando nenhuma zona pede calor; liga quando uma pede, seja quem for que a desligou (depois do mínimo desligada). Nunca mexe numa bomba em avaria.">
              Desligar sem pedidos de calor
            </Toggle>
            <Stepper label="Válvulas fechadas há" value={cfg.pumpFollowsZones.idleMin} step={5} min={5} max={240} unit=" min" onChange={v => patch('pumpFollowsZones', { ...cfg.pumpFollowsZones, idleMin: v })} />
            <Stepper label="Mínimo a trabalhar" value={cfg.pumpFollowsZones.minOnMin} step={5} min={10} max={240} unit=" min" onChange={v => patch('pumpFollowsZones', { ...cfg.pumpFollowsZones, minOnMin: v })} />
            <Stepper label="Mínimo desligada" value={cfg.pumpFollowsZones.minOffMin} step={5} min={5} max={240} unit=" min" onChange={v => patch('pumpFollowsZones', { ...cfg.pumpFollowsZones, minOffMin: v })} />
          </Group>

          <Group title="Limites das divisões">
            <Stepper label="Mínimo" value={cfg.limits.roomMin} step={0.5} min={18} max={cfg.limits.roomMax} unit="°" onChange={v => patch('limits', { ...cfg.limits, roomMin: v })} />
            <Stepper label="Máximo" value={cfg.limits.roomMax} step={0.5} min={cfg.limits.roomMin} max={26} unit="°" onChange={v => patch('limits', { ...cfg.limits, roomMax: v })} />
          </Group>

          <div className="flex items-center gap-2 border-t border-zinc-800 pt-3">
            <button
              type="button"
              onClick={() => setCfg(DEFAULT_AUTOMATION)}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
            >
              Predefinições
            </button>
            <span className="flex-1 text-[11px] text-zinc-500">{dirty ? 'Por guardar' : 'Guardado'} · o Pi aplica em até 2 min</span>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 font-semibold disabled:opacity-40"
            >
              {saving ? 'A guardar…' : 'Guardar'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
