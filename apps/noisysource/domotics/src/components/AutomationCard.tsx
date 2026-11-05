import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Minus, Plus, Bot, AlarmClock } from 'lucide-react';
import {
  DEFAULT_AUTOMATION, backToDryRun, clearWarmBy, goLive, loadAutomationConfig, saveAutomationConfig, setPause, setWarmBy,
  type AutomationConfig, type AutomationStatus, type WarmByStatus, type WarmupModel,
} from '../data/automation';
import { ago } from './HealthChips';

/**
 * The heating automation in the app. On top, one unmistakable state with its
 * one action (Ligar / Pausar / Retomar); then today's plan and what it is doing
 * now; then the four settings that matter, everything else under "Avançado".
 *
 * The automation runs on the Pi (domotics-bridge/src/automation.ts); this reads
 * its status from the bridge state and writes `domotics_config/automation`,
 * which the bridge picks up within two minutes. The plan (Renato, 2026-10-26):
 * a warm floor 19:00–09:00; by day the pump only on spare sun with the battery
 * ≥ 90 %, or below the day minimum.
 */

interface Props {
  /** From the bridge's state; undefined on a bridge that predates the automation. */
  status?: AutomationStatus;
  /** Settings are the owner's alone (firestore.rules): editable only signed in. */
  canEdit: boolean;
}

/** Past this, the status shown is older than the bridge would ever leave it. */
const STALE_MS = 10 * 60_000;
const HOUR = 3_600_000;

const label = 'text-[10px] uppercase tracking-widest text-zinc-500';

type Tone = 'ok' | 'info' | 'idle' | 'warn';

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
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

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' });
const dayOf = (ms: number) => new Date(ms).toLocaleDateString('pt-PT', { timeZone: 'Europe/Lisbon' });
/** "07:00 amanhã" — the requests are at most a day ahead. */
function whenLabel(ms: number, now: number) {
  return `${hhmm(ms)}${dayOf(ms) === dayOf(now) ? ' hoje' : dayOf(ms) === dayOf(now + 86_400_000) ? ' amanhã' : ''}`;
}
const deg = (v: number) => `${String(Math.round(v * 10) / 10).replace('.', ',')}°`;
/** "19:00–23:00 e 06:00–10:00" */
const windowsText = (ws: Array<{ from: string; to: string }>) =>
  ws.map(w => `${w.from}–${w.to}`).join(ws.length === 2 ? ' e ' : ', ');
const kw = (w: number) => `${(Math.max(0, w) / 1000).toFixed(1).replace('.', ',')} kW`;

const primaryBtn = 'shrink-0 text-sm px-4 py-2 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 font-semibold disabled:opacity-40';
const secondaryBtn = 'text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40';
const linkBtn = 'text-[11px] text-zinc-400 hover:text-zinc-200 underline underline-offset-2 disabled:opacity-40';

type Pending = { kind: 'live' | 'dry' | 'pause' | 'resume'; until?: number; at: number };

/** Whether the bridge's status already shows what was saved. */
function applied(p: Pending, s: AutomationStatus) {
  if (p.kind === 'live') return s.state === 'running';
  if (p.kind === 'dry') return s.state === 'dry-run';
  if (p.kind === 'pause') return s.pausedUntil === p.until;
  return !s.pausedUntil;
}

export default function AutomationCard({ status, canEdit }: Props) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [choosingPause, setChoosingPause] = useState(false);
  useEffect(() => {
    if (pending && status && (applied(pending, status) || now - pending.at > 5 * 60_000)) setPending(null);
  }, [pending, status, now]);

  async function run(p: Omit<Pending, 'at'>, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setPending({ ...p, at: Date.now() });
      setChoosingPause(false);
    } catch (err) {
      setError((err as { code?: string }).code === 'permission-denied'
        ? 'Esta conta não pode alterar a automação.'
        : 'Não foi possível guardar. Tente de novo.');
    } finally {
      setBusy(false);
    }
  }

  const age = status ? now - status.evaluatedAt : undefined;
  const stale = age !== undefined && age > STALE_MS;
  const paused = status?.pausedUntil && status.pausedUntil > now ? status.pausedUntil : null;

  // The one state, and the one action next to it.
  let headline: string;
  let tone: Tone;
  let sub: string;
  let primary: ReactNode = null;
  let secondary: ReactNode = null;
  if (!status) {
    headline = 'Ponte sem automação';
    tone = 'idle';
    sub = 'A ponte (Raspberry Pi) ainda não tem a automação — precisa de ser atualizada.';
  } else if (!status.enabled) {
    headline = 'Desligada';
    tone = 'idle';
    sub = 'Não liga nem desliga nada.';
    primary = <button type="button" className={primaryBtn} disabled={busy} onClick={() => void run({ kind: 'live' }, goLive)}>Ligar</button>;
  } else if (paused) {
    headline = `Em pausa até às ${hhmm(paused)}`;
    tone = 'warn';
    sub = status.dryRun
      ? 'Ninguém volta a ligar a bomba sozinho até lá. (A automação só está a simular: não a desliga; desligue-a no painel ou na app se quiser.)'
      : 'A bomba fica desligada e a automação não a volta a ligar até lá.';
    primary = <button type="button" className={primaryBtn} disabled={busy} onClick={() => void run({ kind: 'resume' }, () => setPause(null))}>Retomar</button>;
  } else if (status.state === 'dry-run') {
    headline = 'Só a simular';
    tone = 'info';
    sub = `Decide e mostra o que faria, mas não mexe na bomba nem nos termóstatos. Ligar: passa a ligar e desligar a bomba pelo plano abaixo e põe os termóstatos a ${deg(status.settings?.comfort ?? 24)}.`;
    primary = <button type="button" className={primaryBtn} disabled={busy} onClick={() => void run({ kind: 'live' }, goLive)}>Ligar</button>;
    secondary = <button type="button" className={linkBtn} disabled={busy} onClick={() => setChoosingPause(c => !c)}>Pausar</button>;
  } else {
    headline = 'Ligada — controla a bomba';
    tone = 'ok';
    sub = 'Liga e desliga a bomba pelo plano, seja quem for que lhe mexeu (painel, SmartLife, o temporizador da bomba). Para a parar, use Pausar.';
    primary = <button type="button" className={primaryBtn} disabled={busy} onClick={() => setChoosingPause(c => !c)}>Pausar</button>;
    secondary = <button type="button" className={linkBtn} disabled={busy} onClick={() => void run({ kind: 'dry' }, backToDryRun)}>Voltar a só simular</button>;
  }
  // A bridge without the 2026-10-26 plan would go live with the old rules (pre-heat, evening setback, pump following the zones all day).
  const oldBridge = !!status && !status.settings;
  if (oldBridge && !paused) {
    sub = 'A ponte (Raspberry Pi) ainda tem a automação antiga — atualize-a antes de ligar.';
    primary = null;
  }
  if (!canEdit) { primary = null; secondary = null; }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-3.5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Bot size={16} className="shrink-0 text-zinc-400" />
        <h2 className="flex-1 min-w-0 text-sm font-semibold text-zinc-100">Automação do aquecimento</h2>
        {stale && <Pill tone="warn">Sem notícias da ponte há {ago(age!)}</Pill>}
      </div>

      {/* State + action */}
      <div className="flex flex-col gap-2 rounded-lg bg-zinc-950/60 border border-zinc-800 p-3">
        <div className="flex items-center gap-3">
          <span className={`shrink-0 w-2.5 h-2.5 rounded-full ${{ ok: 'bg-emerald-400 animate-pulse', info: 'bg-sky-400', idle: 'bg-zinc-500', warn: 'bg-amber-400' }[tone]}`} />
          <span className="flex-1 min-w-0 text-base font-semibold text-zinc-100 leading-tight">{headline}</span>
          {primary}
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed">{sub}</p>
        {secondary && <div className="flex justify-end">{secondary}</div>}
        {choosingPause && status && <PauseChoices status={status} now={now} busy={busy}
          onPick={until => void run({ kind: 'pause', until }, () => setPause(until))} onCancel={() => setChoosingPause(false)} />}
        {pending && <p className="text-[11px] text-emerald-300">Guardado — o Pi aplica em até 2 min.</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        {!canEdit && status && (
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Para ligar, pausar ou mudar, abra a app com sessão iniciada (kidclub-dev-domotics.web.app). Na rede local só se vê o estado.
          </p>
        )}
      </div>

      {status && status.enabled && <Today status={status} />}

      <Settings canEdit={canEdit} summary={status?.settings} />

      {status && status.state !== 'off' && <Details status={status} />}

      {status && <WarmBy status={status.warmBy ?? null} model={status.model} canEdit={canEdit} now={now} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pausar
// ---------------------------------------------------------------------------

function PauseChoices({ status, now, busy, onPick, onCancel }: {
  status: AutomationStatus; now: number; busy: boolean; onPick: (until: number) => void; onCancel: () => void;
}) {
  const w = status.warm;
  const opts: Array<{ text: string; until: number }> = [{ text: '2 h', until: now + 2 * HOUR }];
  if (w && !w.inWindow && w.nextStart - now > 30 * 60_000) opts.push({ text: `Até às ${hhmm(w.nextStart)}`, until: w.nextStart });
  if (w && w.end > now) opts.push({ text: `Até ${dayOf(w.end) === dayOf(now) ? '' : 'amanhã '}às ${hhmm(w.end)}`, until: w.end });
  return (
    <div className="flex flex-col gap-2 border-t border-zinc-800 pt-2">
      <p className="text-xs text-zinc-300 leading-snug">
        Pausar até quando? Até lá, a automação não liga a bomba
        {status.state === 'running' ? ' e desliga-a já.' : '.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {opts.map(o => (
          <button key={o.text} type="button" className={secondaryBtn} disabled={busy} onClick={() => onPick(o.until)}>{o.text}</button>
        ))}
        <button type="button" className="text-xs px-3 py-1.5 rounded-lg text-zinc-500 hover:text-zinc-300" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hoje: the plan and what it is doing now
// ---------------------------------------------------------------------------

function Today({ status }: { status: AutomationStatus }) {
  const facts: string[] = [];
  if (status.meanRoom !== undefined) facts.push(`casa ${deg(status.meanRoom)}`);
  if (status.solar?.soc !== null && status.solar?.soc !== undefined) facts.push(`bateria ${Math.round(status.solar.soc)} %`);
  // The battery's charge says more than the spare sun, which the inverter hides by holding the panels back.
  const bat = status.solar?.batteryW;
  if (bat !== null && bat !== undefined) facts.push(bat >= 0 ? `a carregar ${kw(bat)}` : `a descarregar ${kw(-bat)}`);
  else if (status.solar?.spareW !== null && status.solar?.spareW !== undefined && status.mode === 'day') facts.push(`sol a sobrar ${kw(status.solar.spareW)}`);
  if (status.flowTarget !== undefined) facts.push(`água ${status.flowTarget}°${status.flowManual ? ' (à mão)' : ''}`);
  return (
    <div className="flex flex-col gap-1.5">
      <span className={label}>Hoje</span>
      {status.plan
        ? <p className="text-sm text-zinc-100 leading-snug">{status.plan}</p>
        : <p className="text-xs text-zinc-500">A ponte ainda não tem o plano novo — precisa de ser atualizada.</p>}
      {status.doing && (
        <p className="text-xs text-zinc-300 leading-snug">
          <span className="text-zinc-500">Agora{status.state === 'dry-run' ? ' (simulação)' : ''}: </span>{status.doing}
        </p>
      )}
      {facts.length > 0 && <p className="text-[11px] text-zinc-500 tabular-nums first-letter:uppercase">{facts.join(' · ')}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details: reasons, zones, last actions — collapsed
// ---------------------------------------------------------------------------

function Collapsible({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-2 border-t border-zinc-800 pt-2.5">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-left">
        <span className={`flex-1 ${label}`}>{title}</span>
        {open ? <ChevronUp size={13} className="text-zinc-500" /> : <ChevronDown size={13} className="text-zinc-500" />}
      </button>
      {open && children}
    </div>
  );
}

function Details({ status }: { status: AutomationStatus }) {
  return (
    <Collapsible title="Detalhes — porquê, zonas, últimas ações">
      {status.pumpHold && <p className="text-xs text-amber-300 leading-snug">Bomba: {status.pumpHold}.</p>}
      {status.restUntil !== undefined && (
        <p className="text-xs text-sky-300 leading-snug">
          Bomba em descanso até às {hhmm(status.restUntil)} (não fica parada no setpoint).
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {status.reasons.map((r, i) => <li key={i} className="text-xs text-zinc-400 leading-snug">{r}</li>)}
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
      {status.actions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={label}>Últimas ações</span>
          {status.actions.slice(0, 8).map((a, i) => (
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
      {status.model && (
        <p className="text-[11px] text-zinc-500 leading-snug">
          Como a casa aquece: chão quente ~{status.model.floorMin} min depois de a bomba arrancar
          {status.model.floorSamples > 0 ? ` (${status.model.floorSamples} medições)` : ' (dos registos de 21–24/10)'}; divisões
          {' '}{status.model.roomRatePerH.toFixed(2).replace('.', ',')}°/h
          {status.model.roomSamples > 0 ? ` (${status.model.roomSamples} medições)` : ' (valor inicial, a aprender)'}.
          {' '}A bomba gasta ~3,3 kW a trabalhar.
          {status.switchOns24h !== undefined && status.switchOns24h > 0 && ` Ligou-a ${status.switchOns24h}× nas últimas 24 h (máx. 12).`}
        </p>
      )}
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Warm by HH:MM (one-off)
// ---------------------------------------------------------------------------

const PHASE: Record<WarmByStatus['phase'], { text: string; tone: Tone }> = {
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
 * The one-off "warm by HH:MM" — for a day off, say: it heats for that time
 * whatever the hour, sun or not. Signed in, set or cancelled through the
 * `domoticsWarmBy` callable, which the chat will use too.
 */
function WarmBy({ status, model, canEdit, now }: {
  status: WarmByStatus | null; model?: WarmupModel; canEdit: boolean; now: number;
}) {
  const [time, setTime] = useState('15:00');
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
  const active = !!status && status.phase !== 'done';

  return (
    <Collapsible title={active ? `Pedido pontual: quente às ${hhmm(status!.at)}` : 'Pedido pontual: quente às…'} defaultOpen={active}>
      <div className="flex items-center gap-2">
        <AlarmClock size={13} className="text-zinc-400" />
        <span className="flex-1 text-[11px] text-zinc-500 leading-snug">
          Fora do horário quente (um dia em casa, por exemplo): aquece para essa hora, com sol ou sem ele.
        </span>
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
        <p className="text-xs text-zinc-500">Sem pedido.</p>
      )}

      {model && !status && (
        <p className="text-[11px] text-zinc-500 leading-snug">
          Começa cedo o suficiente: chão ~{model.floorMin} min + divisões a {model.roomRatePerH.toFixed(2).replace('.', ',')}°/h + 30 min de margem.
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
          {active && (
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
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Settings: four on top, the rest under "Avançado"
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

function Stepper({ label: text, hint, value, step, min, max, unit, onChange }: {
  label: string; hint?: string; value: number; step: number; min: number; max: number; unit: string;
  onChange: (v: number) => void;
}) {
  const set = (v: number) => onChange(Math.round(Math.min(max, Math.max(min, v)) / step) * step);
  const btn = 'w-7 h-7 flex items-center justify-center rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30';
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="text-xs text-zinc-300">{text}</span>
        {hint && <span className="text-[11px] text-zinc-500 leading-snug">{hint}</span>}
      </span>
      <button type="button" className={btn} onClick={() => set(value - step)} disabled={value <= min} aria-label="Menos"><Minus size={13} /></button>
      <span className="w-16 text-center text-sm tabular-nums text-zinc-100">
        {Number.isInteger(step) ? value : value.toFixed(1)}{unit}
      </span>
      <button type="button" className={btn} onClick={() => set(value + step)} disabled={value >= max} aria-label="Mais"><Plus size={13} /></button>
    </div>
  );
}

function Times({ label: text, hint, from, to, onChange }: {
  label: string; hint?: string; from: string; to: string; onChange: (from: string, to: string) => void;
}) {
  const input = 'bg-zinc-800 border border-zinc-700 rounded-md px-1.5 py-1 text-sm text-zinc-100 tabular-nums';
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="text-xs text-zinc-300">{text}</span>
        {hint && <span className="text-[11px] text-zinc-500 leading-snug">{hint}</span>}
      </span>
      <input type="time" className={input} value={from} onChange={e => onChange(e.target.value, to)} aria-label="Desde" />
      <span className="text-zinc-500 text-xs">–</span>
      <input type="time" className={input} value={to} onChange={e => onChange(from, e.target.value)} aria-label="Até" />
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

function Settings({ canEdit, summary }: { canEdit: boolean; summary?: AutomationStatus['settings'] }) {
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
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

  // The pause is set from the buttons on top, not here.
  const strip = (c: AutomationConfig) => JSON.stringify({ ...c, pauseUntil: null });
  const dirty = !!cfg && !!saved && strip(cfg) !== strip(saved);
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

  const s = summary;
  const several = s?.windows && s.windows.length > 1 ? windowsText(s.windows) : null;
  const sun = s?.solar?.enabled === false ? 'sem aquecer com o sol'
    : s ? `sol com bateria ≥ ${Math.round(s.socOn)} %${s.solar?.boost ? ` (divisões +${deg(s.solar.boost)})` : ''}` : '';
  const line = s
    ? `Quente ${several ?? `${s.warmFrom}–${s.warmTo}`} · ${deg(s.comfort)} · mínimo de dia ${deg(s.dayMin)} · ${sun}`
    : 'Horário quente, temperatura, mínimo de dia e bateria para aquecer com sol.';

  return (
    <div className="flex flex-col gap-2 border-t border-zinc-800 pt-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 flex flex-col">
          <span className={label}>Definições</span>
          <span className="text-xs text-zinc-300 tabular-nums">{line}</span>
        </span>
        <button type="button" onClick={() => setOpen(o => !o)} className={`${secondaryBtn} flex items-center gap-1`}>
          {open ? 'Fechar' : 'Alterar'} {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {open && !canEdit && (
        <p className="text-xs text-zinc-500 leading-relaxed">
          Para alterar, abra a app com sessão iniciada (kidclub-dev-domotics.web.app). Na rede local só se vê o estado.
        </p>
      )}
      {open && error && <p className="text-xs text-red-400">{error}</p>}

      {open && cfg && (
        <div className="flex flex-col gap-3 pt-1">
          {cfg.windows && cfg.windows.length > 1 ? (
            <div className="flex flex-col gap-0.5">
              <span className={label}>Horários quentes</span>
              <span className="text-xs text-zinc-300 tabular-nums">{windowsText(cfg.windows)}</span>
              <span className="text-xs text-zinc-500 leading-relaxed">Começa a aquecer meia hora antes de cada um; entre eles a bomba fica desligada (de dia, só com sol ou abaixo do mínimo de dia). Ainda não se alteram aqui.</span>
            </div>
          ) : (
            <Times label="Horário quente" hint="Chão quente neste horário; começa a aquecer antes, para estar quente à hora de início."
              from={cfg.warm.from} to={cfg.warm.to} onChange={(from, to) => patch('warm', { from, to })} />
          )}
          <Stepper label="Temperatura" hint="Das divisões, nos termóstatos." value={cfg.comfort} step={0.5}
            min={cfg.limits.roomMin} max={cfg.limits.roomMax} unit="°" onChange={v => patch('comfort', v)} />
          <Stepper label="Mínimo de dia" hint="Se a média das divisões descer daqui, aquece mesmo sem sol." value={cfg.dayMin}
            step={0.5} min={16} max={cfg.comfort} unit="°" onChange={v => patch('dayMin', v)} />
          <Stepper label="Bateria para aquecer com sol" hint="De dia, só liga com a bateria a este nível e sol a sobrar: a bateria a carregar no máximo (os painéis travados) ou cheia."
            value={cfg.solar.socOn} step={5} min={20} max={100} unit=" %" onChange={v => patch('solar', { ...cfg.solar, socOn: v })} />

          <button type="button" onClick={() => setAdvanced(a => !a)} className="flex items-center gap-1.5 border-t border-zinc-800 pt-2.5 text-left">
            <span className={`flex-1 ${label}`}>Avançado</span>
            {advanced ? <ChevronUp size={13} className="text-zinc-500" /> : <ChevronDown size={13} className="text-zinc-500" />}
          </button>

          {advanced && (
            <div className="flex flex-col gap-3">
              <Toggle on={cfg.enabled} onChange={v => patch('enabled', v)} hint="Desligada: o Pi não decide nem envia nada.">
                Automação ligada
              </Toggle>
              <Toggle on={cfg.dryRun} onChange={v => patch('dryRun', v)} hint="Decide e mostra o que faria, sem enviar nada aos aparelhos.">
                Só simular
              </Toggle>

              <Group title="Sol">
                <Toggle on={cfg.solar.enabled} onChange={v => patch('solar', { ...cfg.solar, enabled: v })}
                  hint="Desligado: de dia só aquece abaixo do mínimo de dia.">
                  Aquecer de dia com o sol
                </Toggle>
                <Stepper label="Consumo da bomba a trabalhar" hint="Tirado ao consumo da casa enquanto trabalha, para o excedente não desaparecer ao ligá-la (medido: ~3300 W)."
                  value={cfg.solar.pumpW} step={100} min={500} max={8000} unit=" W" onChange={v => patch('solar', { ...cfg.solar, pumpW: v })} />
                <Stepper label="…ou a enviar para a rede" hint="Com a bateria no nível acima, também liga se estiver a ir isto para a rede."
                  value={cfg.solar.exportW} step={100} min={100} max={5000} unit=" W" onChange={v => patch('solar', { ...cfg.solar, exportW: v })} />
                <Stepper label="…ou a bateria a carregar" hint="O inversor só produz o que a casa e a bateria gastam, e a bateria carrega no máximo ~3000 W: a carregar a isto, os painéis estão travados e há sol a sobrar."
                  value={cfg.solar.chargeW} step={100} min={500} max={5000} unit=" W" onChange={v => patch('solar', { ...cfg.solar, chargeW: v })} />
                <Stepper label="Continua com a bateria a carregar" hint="Com a bomba a trabalhar, a bateria tem de continuar a carregar pelo menos isto; abaixo, 15 min depois desliga e só volta a tentar 1 h depois."
                  value={cfg.solar.keepChargeW} step={100} min={0} max={5000} unit=" W" onChange={v => patch('solar', { ...cfg.solar, keepChargeW: v })} />
                <Stepper label="Divisões mais quentes com o sol" hint="A aquecer com o sol, os termóstatos ficam isto acima da temperatura (até ao máximo), para as válvulas abrirem e o chão guardar o calor para a noite."
                  value={cfg.solar.boost} step={0.5} min={0} max={2} unit="°" onChange={v => patch('solar', { ...cfg.solar, boost: v })} />
              </Group>

              <Group title="Água do pavimento">
                <Toggle on={cfg.flow.enabled} onChange={v => patch('flow', { ...cfg.flow, enabled: v })} hint="Usa o sensor exterior da própria bomba. Água mais fria = bomba mais eficiente. Uma temperatura mudada à mão é respeitada até mudar de dia para noite.">
                  Seguir a temperatura exterior
                </Toggle>
                <Stepper label="Com 15° lá fora" value={cfg.flow.at15} step={1} min={25} max={45} unit="°" onChange={v => patch('flow', { ...cfg.flow, at15: v })} />
                <Stepper label="Por cada grau mais frio" value={cfg.flow.slope} step={0.1} min={0} max={3} unit="°" onChange={v => patch('flow', { ...cfg.flow, slope: v })} />
                <Stepper label="Mínimo" value={cfg.flow.min} step={1} min={25} max={cfg.flow.max} unit="°" onChange={v => patch('flow', { ...cfg.flow, min: v })} />
                <Stepper label="Máximo" value={cfg.flow.max} step={1} min={cfg.flow.min} max={45} unit="°" onChange={v => patch('flow', { ...cfg.flow, max: v })} />
              </Group>

              <Group title="Recuperação">
                <Toggle on={cfg.recovery.enabled} onChange={v => patch('recovery', { enabled: v })} hint="Divisões mais de 0,5° abaixo do alvo: água no máximo enquanto a bomba trabalha. Nunca baixa a água enquanto estiverem abaixo.">
                  Recuperar depressa
                </Toggle>
              </Group>

              <Group title="Bomba">
                <Toggle on={cfg.pumpFollowsZones.enabled} onChange={v => patch('pumpFollowsZones', { ...cfg.pumpFollowsZones, enabled: v })} hint="No horário quente, desliga a bomba quando nenhuma zona pede calor e liga quando uma pede. Desligado: trabalha o horário quente todo.">
                  Seguir as zonas
                </Toggle>
                <Stepper label="Válvulas fechadas há" value={cfg.pumpFollowsZones.idleMin} step={5} min={5} max={240} unit=" min" onChange={v => patch('pumpFollowsZones', { ...cfg.pumpFollowsZones, idleMin: v })} />
                <Stepper label="Mínimo a trabalhar" hint="Antes de a automação a desligar (exceto em pausa)." value={cfg.pumpFollowsZones.minOnMin} step={5} min={10} max={240} unit=" min" onChange={v => patch('pumpFollowsZones', { ...cfg.pumpFollowsZones, minOnMin: v })} />
                <Stepper label="Mínimo desligada" hint="Antes de a voltar a ligar, seja quem for que a desligou." value={cfg.pumpFollowsZones.minOffMin} step={5} min={5} max={240} unit=" min" onChange={v => patch('pumpFollowsZones', { ...cfg.pumpFollowsZones, minOffMin: v })} />
              </Group>

              <Group title="Limites das divisões">
                <Stepper label="Mínimo" value={cfg.limits.roomMin} step={0.5} min={18} max={cfg.limits.roomMax} unit="°" onChange={v => patch('limits', { ...cfg.limits, roomMin: v })} />
                <Stepper label="Máximo" value={cfg.limits.roomMax} step={0.5} min={cfg.limits.roomMin} max={26} unit="°" onChange={v => patch('limits', { ...cfg.limits, roomMax: v })} />
              </Group>

              <button
                type="button"
                onClick={() => setCfg(c => (c ? {
                  ...DEFAULT_AUTOMATION, enabled: c.enabled, dryRun: c.dryRun, pauseUntil: c.pauseUntil,
                  // No control for it here, and the default is on: live, the bridge would rest the pump 60 min at the setpoint, unseen.
                  rest: c.rest,
                } : c))}
                className="self-start text-xs px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
              >
                Repor predefinições
              </button>
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-zinc-800 pt-3">
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
