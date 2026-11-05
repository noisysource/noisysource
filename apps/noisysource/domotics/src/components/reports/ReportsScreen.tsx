import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, Loader2, Printer, RefreshCw } from 'lucide-react';
import {
  codeSummary, endPhrase, fmtDate, fmtDateTime, fmtTime, loadIncidents, SOURCE_LABEL,
  type FaultIncident, type Incident, type NoteEntry, type SwitchEvent, type SwitchSource,
} from '../../data/incidents';
import { faultGuide } from '../../data/heatpumpFaults';
import EventLog from './EventLog';
import PumpChart from './PumpChart';
import { TimeStrip, TripTable } from './parts';
import TechnicianReport from './TechnicianReport';

/**
 * "Relatórios": what the heat pump has been through, from `domotics_incidents`
 * — faults grouped by code with the readings around each trip and the pattern
 * across them, every on/off with who did it, and the log of all of it in order
 * (EventLog). One tap opens the printable
 * pt-PT version for the technicians (TechnicianReport), which replaced the
 * hand-written report of 23/10.
 *
 * Owner only, like everything the bridge records: needs sign-in, so it can't
 * be read on the LAN (where nobody can sign in).
 */

interface Props {
  onBack: () => void;
  /** Signed in off the LAN: the only way the rules let the incidents be read. */
  canRead: boolean;
}

type Range = 7 | 30 | 0;
const RANGES: Array<[Range, string]> = [[7, '7 dias'], [30, '30 dias'], [0, 'Tudo']];

const label = 'text-[10px] uppercase tracking-widest text-zinc-500';
const DAY = 86_400_000;

function Badge({ tone, children }: { tone: 'bad' | 'warn' | 'idle' | 'ok'; children: ReactNode }) {
  const cls = {
    bad: 'bg-red-950/70 text-red-300',
    warn: 'bg-amber-950/70 text-amber-300',
    idle: 'bg-zinc-800 text-zinc-400',
    ok: 'bg-emerald-950/70 text-emerald-300',
  }[tone];
  return <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${cls}`}>{children}</span>;
}

function Stat({ title, value, hint }: { title: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-zinc-950/60 border border-zinc-800 px-3 py-2 min-w-[6.5rem]">
      <span className="text-[11px] text-zinc-500">{title}</span>
      <span className="text-lg font-semibold text-zinc-100">{value}</span>
      {hint && <span className="text-[10px] text-zinc-500">{hint}</span>}
    </div>
  );
}

const ORIGIN: Record<string, string> = { bridge: 'registado pela ponte', log: 'do registo manual', notes: 'das notas, sem leituras' };

export default function ReportsScreen({ onBack, canRead }: Props) {
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<Range>(0);
  const [printing, setPrinting] = useState(false);

  const load = useCallback(() => {
    if (!canRead) return;
    setLoading(true);
    setError(null);
    loadIncidents()
      .then(setIncidents)
      .catch(err => setError((err as { code?: string }).code === 'permission-denied'
        ? 'Esta conta não tem acesso aos relatórios.'
        : 'Não foi possível ler os relatórios. Tente de novo.'))
      .finally(() => setLoading(false));
  }, [canRead]);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    if (!incidents) return [];
    const from = range ? Date.now() - range * DAY : 0;
    return incidents.filter(i => i.at >= from);
  }, [incidents, range]);

  const byCode = useMemo(() => {
    const m = new Map<string, FaultIncident[]>();
    for (const i of shown) if (i.kind === 'fault') m.set(i.code, [...(m.get(i.code) ?? []), i]);
    return [...m].sort((a, b) => b[1].length - a[1].length);
  }, [shown]);
  const switches = shown.filter((i): i is SwitchEvent => i.kind === 'switch');
  const notes = shown.filter((i): i is NoteEntry => i.kind === 'note');

  if (printing && incidents) {
    return <TechnicianReport incidents={incidents} onClose={() => setPrinting(false)} />;
  }

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col overflow-hidden">
      <header
        className="flex items-center gap-3 px-4 pb-3 border-b border-zinc-900 shrink-0"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <button onClick={onBack} className="w-9 h-9 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300" aria-label="Voltar">
          <ArrowLeft size={16} />
        </button>
        <h1 className="flex-1 text-base font-semibold">Relatórios</h1>
        <button onClick={load} disabled={loading || !canRead} className="w-9 h-9 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 disabled:opacity-40" aria-label="Atualizar" title="Atualizar">
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
        </button>
        <button
          onClick={() => setPrinting(true)}
          disabled={!incidents?.length}
          className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-semibold disabled:opacity-40"
          title="Versão para imprimir ou enviar aos técnicos"
        >
          <Printer size={14} /> <span className="hidden sm:inline">Versão para os técnicos</span><span className="sm:hidden">Técnicos</span>
        </button>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-4 flex flex-col gap-5" style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
          {!canRead && (
            <p className="text-sm text-zinc-400 leading-relaxed">
              Os relatórios precisam de sessão iniciada. Na rede de casa não é possível entrar — abra
              kidclub-dev-domotics.web.app e inicie sessão.
            </p>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          {canRead && !incidents && !error && <p className="text-sm text-zinc-500">A carregar…</p>}

          {incidents && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 mr-1">Período</span>
                <div className="flex rounded-xl bg-zinc-900 border border-zinc-800 p-0.5">
                  {RANGES.map(([r, text]) => (
                    <button key={r} onClick={() => setRange(r)}
                      className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${range === r ? 'bg-zinc-100 text-zinc-900 font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}>
                      {text}
                    </button>
                  ))}
                </div>
              </div>

              <EventLog incidents={shown} />

              {byCode.length === 0 && (
                <p className="text-sm text-zinc-400">Sem avarias neste período.</p>
              )}
              {byCode.map(([code, faults]) => <CodeSection key={code} code={code} faults={faults} />)}

              <SwitchSection switches={switches} />

              {notes.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold text-zinc-200">Notas</h2>
                  {notes.map(n => (
                    <div key={n.id} className="flex gap-3 text-xs">
                      <span className="w-24 shrink-0 text-zinc-500 tabular-nums">{fmtDate(n.at)}</span>
                      <span className="text-zinc-300 leading-relaxed">{n.note}</span>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function CodeSection({ code, faults }: { code: string; faults: FaultIncident[] }) {
  const guide = faultGuide(code);
  const [showGuide, setShowGuide] = useState(false);
  const sorted = [...faults].sort((a, b) => b.at - a.at);
  const locks = faults.filter(f => f.lockout).length;
  const self = faults.filter(f => f.endedHow === 'self').length;
  const active = faults.find(f => f.status === 'active');
  const summary = codeSummary(faults);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-zinc-100">{code} · {guide.name}</h2>
        {guide.where && <span className="text-[11px] text-zinc-500">{guide.where}</span>}
        {active && <Badge tone="bad">em curso desde {fmtTime(active.at)}</Badge>}
      </div>

      <div className="flex flex-wrap gap-2">
        <Stat title="Disparos" value={faults.length} hint={`${faults.filter(f => f.before.length).length} com leituras`} />
        <Stat title="Bloqueios" value={locks} hint="precisaram de rearme" />
        <Stat title="Limparam sozinhos" value={self} />
        <Stat title="Último" value={fmtDate(sorted[0].at)} hint={fmtTime(sorted[0].at)} />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={label}>O padrão</span>
        <ul className="flex flex-col gap-1 list-disc pl-4 marker:text-zinc-600">
          {summary.map((s, i) => <li key={i} className="text-sm text-zinc-300 leading-relaxed">{s}</li>)}
        </ul>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={label}>Hora do dia</span>
        <TimeStrip
          kinds={[{ label: 'limpou sozinho / sem registo do fim', color: 'var(--viz-1)' }, { label: 'bloqueou', color: 'var(--viz-critical)' }]}
          dots={faults.filter(f => f.origin !== 'notes').map(f => ({
            at: f.at,
            kind: f.lockout ? 1 : 0,
            title: `${fmtDateTime(f.at)} · ${f.lockout ? 'bloqueou — ' : ''}${endPhrase(f)}`,
          }))}
        />
        {faults.some(f => f.origin === 'notes') && (
          <span className="text-[11px] text-zinc-500">Os disparos só conhecidos pelas notas não entram aqui: a hora deles não é exata.</span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={label}>Antes de cada disparo</span>
        <TripTable trips={[...faults].sort((a, b) => a.at - b.at)} />
      </div>

      <div className="flex flex-col gap-2">
        <button onClick={() => setShowGuide(v => !v)} className="self-start flex items-center gap-1.5 text-xs text-zinc-300 hover:text-zinc-100">
          Causas e o que fazer {showGuide ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {showGuide && (
          <div className="flex flex-col gap-2 text-sm text-zinc-300 leading-relaxed">
            {guide.behaviour && <p>{guide.behaviour}</p>}
            {guide.causes.length > 0 && (
              <>
                <span className={label}>Causas possíveis (manual)</span>
                <ul className="list-disc pl-4 marker:text-zinc-600">{guide.causes.map(c => <li key={c}>{c}</li>)}</ul>
              </>
            )}
            <span className={label}>O que fazer</span>
            <ul className="list-disc pl-4 marker:text-zinc-600">{guide.todo.map(c => <li key={c}>{c}</li>)}</ul>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className={label}>Ocorrências</span>
        {sorted.map(f => <FaultRow key={f.id} f={f} />)}
      </div>
    </section>
  );
}

function FaultRow({ f }: { f: FaultIncident }) {
  const [open, setOpen] = useState(false);
  const readings = [...f.before, ...f.after];
  const canOpen = readings.length > 1 || !!f.note || f.actions.length > 0;
  return (
    <div className="border-t border-zinc-800/70 first:border-t-0">
      <button
        onClick={() => canOpen && setOpen(o => !o)}
        className={`w-full flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-left ${canOpen ? 'hover:bg-zinc-800/40' : 'cursor-default'} rounded-md px-1`}
        aria-expanded={canOpen ? open : undefined}
      >
        <span className="w-24 shrink-0 text-sm text-zinc-100 tabular-nums">{fmtDateTime(f.at)}</span>
        {(f.after[0]?.sp ?? f.before.at(-1)?.sp) !== undefined && (
          <span className="text-xs text-zinc-400 tabular-nums">{f.after[0]?.sp ?? f.before.at(-1)?.sp}° setpoint</span>
        )}
        {f.lockout && <Badge tone="bad">bloqueou</Badge>}
        <Badge tone="idle">{ORIGIN[f.origin] ?? f.origin}</Badge>
        <span className="order-last basis-full sm:order-none sm:basis-auto sm:flex-1 min-w-0 text-xs text-zinc-400">{endPhrase(f)}</span>
        {canOpen && (open ? <ChevronUp size={14} className="text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />)}
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-1 pb-4 pt-1">
          {f.note && <p className="text-xs text-zinc-300 leading-relaxed">{f.note}</p>}
          {f.lockoutWhy && <p className="text-xs text-red-300">Bloqueio: {f.lockoutWhy}.</p>}
          {f.offlineDuring && <p className="text-xs text-zinc-400">A bomba esteve sem ligação durante a avaria (disjuntor ou rede).</p>}
          {f.actions.length > 0 && (
            <ul className="flex flex-col gap-0.5">
              {f.actions.map((a, i) => (
                <li key={i} className="text-xs text-zinc-400 tabular-nums">
                  {fmtTime(a.at)} · {a.what === 'on' ? 'ligada' : 'desligada'} {SOURCE_LABEL[a.by]}{a.reason ? ` — ${a.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
          {readings.length > 1 && <PumpChart samples={readings} tripAt={f.at} tripLabel={f.codes.join(', ')} />}
        </div>
      )}
    </div>
  );
}

const SOURCE_ORDER: SwitchSource[] = ['outside', 'unknown', 'guard', 'automation', 'app'];
const SOURCE_TITLE: Record<SwitchSource, string> = {
  outside: 'De fora — sem explicação',
  unknown: 'Origem desconhecida',
  guard: 'Proteção E13',
  automation: 'Automação',
  app: 'App / ponte',
};

function SwitchSection({ switches }: { switches: SwitchEvent[] }) {
  const [openSource, setOpenSource] = useState<SwitchSource | null>('outside');
  if (switches.length === 0) return null;
  const groups = SOURCE_ORDER.map(s => [s, switches.filter(x => x.source === s)] as const).filter(([, l]) => l.length);
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-zinc-100">Ligar e desligar a bomba</h2>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Quem ligou ou desligou, quando se sabe. "De fora" é tudo o que não passou pela ponte: SmartLife, o painel,
          os técnicos ou um temporizador da máquina.
        </p>
      </div>
      {groups.map(([source, list]) => (
        <div key={source} className="flex flex-col gap-2 border-t border-zinc-800 pt-3 first:border-t-0 first:pt-0">
          <button onClick={() => setOpenSource(o => (o === source ? null : source))} className="flex items-center gap-2 text-left">
            <span className="flex-1 text-sm font-medium text-zinc-200">{SOURCE_TITLE[source]}</span>
            <span className="text-xs text-zinc-400 tabular-nums">
              {list.filter(x => !x.on).length} desligar · {list.filter(x => x.on).length} ligar
            </span>
            {openSource === source ? <ChevronUp size={14} className="text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />}
          </button>
          <TimeStrip
            kinds={[{ label: 'desligada', color: 'var(--viz-2)' }, { label: 'ligada', color: 'var(--viz-1)' }]}
            dots={list.filter(x => x.origin !== 'notes').map(x => ({
              at: x.at,
              kind: x.on ? 1 : 0,
              title: `${fmtDateTime(x.at)} · ${x.on ? 'ligada' : 'desligada'}${x.faults.length ? ` (em ${x.faults.join(', ')})` : ''}`,
            }))}
          />
          {openSource === source && (
            <ul className="flex flex-col gap-1">
              {[...list].sort((a, b) => b.at - a.at).map(x => (
                <li key={x.id} className="flex gap-3 text-xs">
                  <span className="w-24 shrink-0 text-zinc-300 tabular-nums">{fmtDateTime(x.at)}</span>
                  <span className="w-16 shrink-0 text-zinc-400">{x.on ? 'ligada' : 'desligada'}</span>
                  <span className="flex-1 min-w-0 text-zinc-500 leading-relaxed">
                    {[x.faults.length ? `em ${x.faults.join(', ')}` : '', x.reason, x.note].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
