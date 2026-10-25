import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft, Battery, BatteryCharging, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Home, Loader2, RefreshCw,
  Settings2, Sun, Zap,
} from 'lucide-react';
import {
  BATTERY_FULL_SOC, SURPLUS_MIN_W, addDays, billingPeriod, computeScenarios, dayStart, derivedFlows, lisbonDate,
  parseTariff, projectBill, summarize, surplusOf, surplusWindow,
  type EnergyDay, type Projection, type SurplusSummary, type Tariff,
} from '@shared/lib/energyBill';
import { loadEnergyDays, loadTariff } from '../../data/energyHistory';
import { batteryFlow, formatWatts, gridFlow, liveSurplus, type EnergyReading } from '../../data/energy';
import { DEFAULT_AUTOMATION, loadAutomationConfig } from '../../data/automation';
import { DEMO } from '../../data/demoData';
import SurplusNow from '../SurplusNow';
import EnergyChart from './EnergyChart';
import TariffEditor from './TariffEditor';
import {
  bucketize, coverageOf, fmtDuration, fmtEur, fmtHours, fmtKwh, fmtPct, fmtWhen, grainOf, lastRecorded,
  periodContaining, periodLabel, shiftPeriod, socSeries, type Grain, type Period, type PeriodKind,
} from './view';

/**
 * "Energia": the house's electricity over a day, week, month, year or any
 * range — kWh by flow (consumption, solar, grid both ways, battery both ways),
 * what it cost, what it would have cost without the panels and the battery,
 * and where this month's bill is heading.
 *
 * Data: the bridge's 15-minute slots in `domotics_energy` (owner only, so this
 * needs sign-in, like the Reports page) and the tariff in
 * `domotics_config/tariff`. The euro maths is packages/shared/lib/energyBill.ts.
 */

interface Props {
  onBack: () => void;
  /** Signed in off the LAN (or the dev server's ?demo): the only way the rules let this be read. */
  canRead: boolean;
  /** The live reading, for the strip at the top. */
  live: EnergyReading | null;
}

const DAY = 86_400_000;
const KINDS: Array<[PeriodKind, string]> = [['day', 'Dia'], ['week', 'Semana'], ['month', 'Mês'], ['year', 'Ano'], ['custom', 'Período']];
const sectionTitle = 'text-[11px] font-semibold uppercase tracking-widest text-zinc-500 px-0.5';

function Tile({ title, value, hint, tone, icon }: { title: string; value: ReactNode; hint?: ReactNode; tone?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-zinc-900 border border-zinc-800 px-3 py-2.5 min-w-0">
      <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">{icon}{title}</span>
      <span className={`text-lg font-semibold tabular-nums truncate ${tone ?? 'text-zinc-100'}`}>{value}</span>
      {hint && <span className="text-[11px] text-zinc-500 leading-snug tabular-nums">{hint}</span>}
    </div>
  );
}

function EstimateBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-950/70 text-amber-300 whitespace-nowrap">estimativa</span>;
}

export default function EnergyScreen({ onBack, canRead, live }: Props) {
  const today = lisbonDate(Date.now());
  const [period, setPeriod] = useState<Period>(() => periodContaining('day', today));
  /** What was last loaded, and for which period: the page shows that until the next one arrives. */
  const [data, setData] = useState<{ period: Period; days: EnergyDay[] } | null>(null);
  const [tariff, setTariff] = useState<Tariff>(() => parseTariff({}));
  const [bill, setBill] = useState<{ period: EnergyDay[]; recent: EnergyDay[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  /** The heating automation's solar boost, to link the surplus to it. */
  const [boost, setBoost] = useState<{ enabled: boolean; exportW: number; delta: number } | null>(null);

  useEffect(() => {
    if (!canRead) return;
    loadTariff().then(setTariff).catch(() => { /* defaults, labelled as estimates */ });
    if (DEMO) setBoost(DEFAULT_AUTOMATION.solarBoost);
    else loadAutomationConfig().then(c => setBoost(c.solarBoost)).catch(() => { /* the note just isn't shown */ });
  }, [canRead]);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const wanted = period;
    loadEnergyDays(wanted.from, wanted.to)
      .then(days => { if (!cancelled) setData({ period: wanted, days }); })
      .catch(err => {
        if (cancelled) return;
        setError((err as { code?: string }).code === 'permission-denied'
          ? 'Esta conta não tem acesso aos dados de energia.'
          : 'Não foi possível ler os dados de energia. Tente de novo.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `period` changes identity only when it changes.
  }, [canRead, period, refresh]);

  // The billing period in progress and the week before it, for the bill card.
  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    const bp = billingPeriod(today, tariff.billingDay);
    const recentFrom = addDays(today, -7);
    loadEnergyDays(bp.from < recentFrom ? bp.from : recentFrom, today)
      .then(all => {
        if (!cancelled) setBill({ period: all.filter(d => d.date >= bp.from), recent: all.filter(d => d.date >= recentFrom && d.date < today) });
      })
      .catch(() => { /* the period view shows the error */ });
    return () => { cancelled = true; };
  }, [canRead, tariff.billingDay, today, refresh]);

  const shown = data?.period ?? period;
  const grain = grainOf(shown);
  const stale = !!data && data.period !== period;
  const view = useMemo(() => {
    if (!data) return null;
    const { period, days } = data;
    const now = Date.now();
    const range = { from: dayStart(period.from), to: dayStart(addDays(period.to, 1)), now };
    const summary = summarize(days, tariff, range);
    const billedDays = Math.max(0, Math.min(range.to, now) - range.from) / DAY;
    return {
      summary,
      billedDays,
      scenarios: computeScenarios(summary, billedDays, tariff),
      surplus: surplusOf(days, tariff, range),
      buckets: bucketize(period, days, tariff, now),
      soc: grainOf(period) === 'hour' ? socSeries(days, range.from, range.to) : undefined,
      last: lastRecorded(days),
    };
  }, [data, tariff]);
  const projection = useMemo(
    () => (bill ? projectBill(bill.period, bill.recent, tariff, Date.now()) : null),
    [bill, tariff],
  );

  const next = shiftPeriod(period, 1);
  const isCurrent = period.from <= today && today <= period.to;
  const shownCurrent = shown.from <= today && today <= shown.to;
  const estimate = !tariff.confirmed;

  function setKind(kind: PeriodKind) {
    if (kind === 'custom') setPeriod({ kind, from: period.from, to: period.to > today ? today : period.to });
    else setPeriod(periodContaining(kind, period.to < today ? period.to : today));
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
        <h1 className="flex-1 text-base font-semibold">Energia</h1>
        <button onClick={() => setRefresh(n => n + 1)} disabled={loading || !canRead}
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 disabled:opacity-40" aria-label="Atualizar" title="Atualizar">
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
        </button>
        <button onClick={() => setEditing(true)} disabled={!canRead}
          className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs disabled:opacity-40" title="Preços da eletricidade">
          <Settings2 size={14} /> Tarifário
        </button>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-4 flex flex-col gap-5" style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
          {live?.online && <LiveStrip live={live} />}
          {live?.online && liveSurplus(live) && <SurplusNow surplus={liveSurplus(live)!} />}

          {!canRead && (
            <p className="text-sm text-zinc-400 leading-relaxed">
              O histórico de energia precisa de sessão iniciada. Na rede de casa não é possível entrar — abra
              kidclub-dev-domotics.web.app e inicie sessão.
            </p>
          )}

          {canRead && estimate && (
            <div className="rounded-xl border border-amber-900/60 bg-amber-950/30 px-3.5 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="flex-1 min-w-[14rem] text-sm text-amber-100 leading-relaxed">
                Os euros são <b>estimativas</b>: os preços ainda são os de um tarifário bi-horário típico, não os seus.
              </p>
              <button onClick={() => setEditing(true)} className="h-8 px-3 rounded-lg bg-amber-300 hover:bg-amber-200 text-amber-950 text-xs font-semibold">
                Preencher o tarifário
              </button>
            </div>
          )}

          {canRead && (
            <PeriodBar
              period={period}
              today={today}
              canNext={next.from <= today}
              isCurrent={isCurrent}
              onKind={setKind}
              onShift={dir => setPeriod(shiftPeriod(period, dir))}
              onToday={() => setPeriod(period.kind === 'custom' ? periodContaining('day', today) : periodContaining(period.kind, today))}
              onCustom={(from, to) => setPeriod({ kind: 'custom', from, to })}
            />
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
          {canRead && !view && !error && <p className="text-sm text-zinc-500">A carregar…</p>}

          {view && (
            <div className={`flex flex-col gap-5 transition-opacity ${stale ? 'opacity-50' : ''}`} aria-busy={stale}>
              <CoverageNote summary={view.summary} last={view.last} isCurrent={shownCurrent} />

              <section className="flex flex-col gap-2">
                <h2 className={sectionTitle}>Energia</h2>
                <EnergyTiles summary={view.summary} tariff={tariff} />
              </section>

              <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h2 className={sectionTitle}>Custo</h2>
                  <EstimateBadge show={estimate} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Tile title="Custo do período" value={fmtEur(view.scenarios.actual.total)}
                    hint={`inclui potência e taxas de ${fmtDays(view.billedDays)}${view.scenarios.actual.exportCredit > 0 ? ` · excedente pago −${fmtEur(view.scenarios.actual.exportCredit)}` : ''}`} />
                  <Tile title="Sem painéis nem bateria" value={fmtEur(view.scenarios.withoutSystem.total)} tone="text-zinc-300"
                    hint="toda a energia comprada à rede, ao preço da hora" />
                  <Tile title="Poupança" value={fmtEur(view.scenarios.saving)} tone="text-emerald-300"
                    hint={<>painéis {fmtEur(view.scenarios.savingPv)} · bateria {fmtEur(view.scenarios.savingBattery)}</>} />
                </div>
              </section>

              <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex flex-col gap-2">
                {view.summary.expectedSec === 0
                  ? <p className="text-sm text-zinc-400">Este período ainda não começou.</p>
                  : <EnergyChart buckets={view.buckets} grain={grain} soc={view.soc} />}
              </section>

              {view.summary.coveredSec > 0 && <SurplusSection s={view.surplus} grain={grain} tariff={tariff} boost={boost} />}
            </div>
          )}

          {canRead && projection && <BillCard p={projection} tariff={tariff} estimate={estimate} />}

          {canRead && <HowItWorks />}
        </div>
      </main>

      {editing && (
        <TariffEditor
          tariff={tariff}
          canSave={canRead}
          onClose={() => setEditing(false)}
          onSaved={t => { setTariff(t); setEditing(false); }}
        />
      )}
    </div>
  );
}

const fmtDays = (d: number) => (d >= 1.95 ? `${Math.round(d)} dias` : d >= 0.95 ? '1 dia' : `${Math.max(1, Math.round(d * 24))} h`);

function LiveStrip({ live }: { live: EnergyReading }) {
  const battery = batteryFlow(live);
  const grid = gridFlow(live);
  const abs = (w?: number) => (w === undefined ? undefined : Math.abs(w));
  const item = 'flex items-center gap-1 whitespace-nowrap';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-zinc-900 border border-zinc-800 px-3 py-2 text-xs tabular-nums">
      <span className="text-zinc-500">Agora</span>
      <span className={`${item} text-amber-300`}><Sun size={13} />{formatWatts(live.pvPowerW)}</span>
      <span className={`${item} text-zinc-100`}><Home size={13} className="text-zinc-400" />{formatWatts(live.consumptionW)}</span>
      <span className={`${item} ${battery === 'in' ? 'text-lime-300' : battery === 'out' ? 'text-orange-300' : 'text-zinc-300'}`}>
        {battery === 'in' ? <BatteryCharging size={14} /> : <Battery size={14} />}
        {live.soc ?? '—'}%
        {battery !== 'idle' && <span className="opacity-80">{battery === 'in' ? '↑' : '↓'}{formatWatts(abs(live.batteryPowerW))}</span>}
      </span>
      <span className={`${item} ${grid === 'out' ? 'text-sky-300' : grid === 'in' ? 'text-red-300' : 'text-zinc-400'}`}>
        <Zap size={13} />{grid === 'out' ? 'a enviar ' : grid === 'in' ? 'a comprar ' : 'rede '}{formatWatts(abs(live.gridPowerW))}
      </span>
    </div>
  );
}

function PeriodBar({ period, today, canNext, isCurrent, onKind, onShift, onToday, onCustom }: {
  period: Period;
  today: string;
  canNext: boolean;
  isCurrent: boolean;
  onKind: (k: PeriodKind) => void;
  onShift: (dir: 1 | -1) => void;
  onToday: () => void;
  onCustom: (from: string, to: string) => void;
}) {
  const navBtn = 'w-9 h-9 flex items-center justify-center rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 disabled:opacity-30';
  const dateInput = 'h-9 rounded-lg bg-zinc-900 border border-zinc-800 px-2 text-sm text-zinc-100 tabular-nums';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex rounded-xl bg-zinc-900 border border-zinc-800 p-0.5 self-start max-w-full overflow-x-auto">
        {KINDS.map(([k, text]) => (
          <button key={k} onClick={() => onKind(k)}
            className={`px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors ${period.kind === k ? 'bg-zinc-100 text-zinc-900 font-semibold' : 'text-zinc-400 hover:text-zinc-200'}`}>
            {text}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => onShift(-1)} className={navBtn} aria-label="Período anterior"><ChevronLeft size={16} /></button>
        {period.kind === 'custom' ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <input type="date" className={dateInput} value={period.from} max={period.to}
              onChange={e => e.target.value && onCustom(e.target.value, period.to)} aria-label="De" />
            <span className="text-zinc-500 text-xs">a</span>
            <input type="date" className={dateInput} value={period.to} min={period.from} max={today}
              onChange={e => e.target.value && onCustom(period.from, e.target.value)} aria-label="Até" />
          </div>
        ) : (
          <span className="min-w-[9rem] text-center inline-block text-sm font-medium text-zinc-100 first-letter:uppercase">{periodLabel(period, today)}</span>
        )}
        <button onClick={() => onShift(1)} disabled={!canNext} className={navBtn} aria-label="Período seguinte"><ChevronRight size={16} /></button>
        {!isCurrent && (
          <button onClick={onToday} className="h-9 px-3 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-xs text-zinc-300">Hoje</button>
        )}
      </div>
    </div>
  );
}

function CoverageNote({ summary, last, isCurrent }: { summary: ReturnType<typeof summarize>; last?: number; isCurrent: boolean }) {
  if (summary.expectedSec === 0) return null;
  if (summary.coveredSec === 0) {
    return (
      <p className="text-sm text-zinc-400 leading-relaxed">
        Sem registos neste período. A ponte guarda a energia de 15 em 15 minutos desde que passou a fazê-lo; antes disso não há histórico.
      </p>
    );
  }
  const cov = coverageOf(summary.coveredSec, summary.expectedSec);
  const missing = summary.expectedSec - summary.coveredSec;
  return (
    <div className="flex flex-col gap-1 text-xs text-zinc-500 leading-relaxed">
      {isCurrent && last && <span>Registado até às {fmtWhen(last).slice(6)} (em períodos de 15 minutos, enviados de hora a hora).</span>}
      {cov < 0.98 && missing > 15 * 60 && (
        <span className="text-amber-300/90">
          Sem dados em {fmtDuration(missing)} deste período ({fmtPct(1 - cov)}) — ponte ou inversor sem ligação. Os totais ficam abaixo do real.
          {summary.gaps.length > 0 && ` Maiores falhas: ${summary.gaps
            .sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 3)
            .map(g => `${fmtWhen(g.from)}–${fmtWhen(g.to).slice(6)}`).join(', ')}.`}
        </span>
      )}
    </div>
  );
}

function EnergyTiles({ summary, tariff }: { summary: ReturnType<typeof summarize>; tariff: Tariff }) {
  const t = summary.total;
  const d = derivedFlows(t);
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      <Tile title="Consumo da casa" icon={<Home size={12} />} value={fmtKwh(t.load)} hint={`${fmtKwh(summary.vazio.load)} em vazio`} />
      <Tile title="Produção solar" icon={<Sun size={12} />} value={fmtKwh(t.pv)} tone="text-amber-300"
        hint={d.selfConsumption !== undefined ? `${fmtPct(d.selfConsumption)} usada em casa` : undefined} />
      <Tile title="Comprado à rede" icon={<Zap size={12} />} value={fmtKwh(t.imp)} tone="text-sky-300"
        hint={`vazio ${fmtKwh(summary.vazio.imp)} · fora ${fmtKwh(summary.fora.imp)}`} />
      <Tile title="Enviado à rede" icon={<Zap size={12} />} value={fmtKwh(t.exp)}
        hint={tariff.exportPrice > 0 ? `pago a ${String(tariff.exportPrice).replace('.', ',')} €/kWh` : 'sem pagamento (ver excedente)'} />
      <Tile title="Bateria carregou" icon={<BatteryCharging size={12} />} value={fmtKwh(t.chg)} tone="text-emerald-300"
        hint={t.gridBat > 0 ? `${fmtKwh(t.gridBat)} da rede` : 'do sol'} />
      <Tile title="Bateria descarregou" icon={<Battery size={12} />} value={fmtKwh(t.dis)} tone="text-emerald-300"
        hint={`${fmtKwh(summary.fora.batLoad)} em horas fora de vazio`} />
      <Tile title="Autossuficiência" value={fmtPct(d.selfSufficiency)} hint="do consumo sem comprar à rede" />
      <Tile title="Autoconsumo" value={fmtPct(d.selfConsumption)} hint="da produção solar usada em casa" />
    </div>
  );
}

function BillCard({ p, tariff, estimate }: { p: Projection; tariff: Tariff; estimate: boolean }) {
  const [open, setOpen] = useState(false);
  const label = `${fmtWhen(dayStart(p.period.from), false)} – ${fmtWhen(dayStart(p.period.to), false)}`;
  const daysIn = Math.min(p.period.days, Math.floor(p.elapsedDays) + 1);
  const proj = p.projected;
  const b = proj.actual;
  const kwh = (wh: number) => fmtKwh(wh);
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-zinc-100">Fatura em curso</h2>
        <span className="text-xs text-zinc-500 tabular-nums">{label} · dia {daysIn} de {p.period.days}</span>
        <EstimateBadge show={estimate} />
        {tariff.supplier && <span className="text-xs text-zinc-500">{tariff.supplier}</span>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile title="Até agora" value={fmtEur(p.soFar.actual.total)} hint={`${kwh(p.soFarEnergy.total.imp)} comprados`} />
        <Tile title="Previsão do período" value={p.basisDays > 0 ? fmtEur(b.total) : '—'}
          hint={p.basisDays > 0 ? `${kwh(p.projectedEnergy.total.imp)} comprados` : 'sem dados recentes para prever'} />
        <Tile title="Sem painéis nem bateria" value={p.basisDays > 0 ? fmtEur(proj.withoutSystem.total) : '—'} tone="text-zinc-300" hint="previsão" />
        <Tile title="Poupança prevista" value={p.basisDays > 0 ? fmtEur(proj.saving) : '—'} tone="text-emerald-300"
          hint={p.basisDays > 0 ? <>painéis {fmtEur(proj.savingPv)} · bateria {fmtEur(proj.savingBattery)}</> : undefined} />
      </div>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        {p.basisDays > 0
          ? `Previsão: o que já foi registado mais a média diária dos últimos 7 dias (${String(Math.round(p.basisDays * 10) / 10).replace('.', ',')} dias com dados) para os dias que faltam.`
          : 'Sem dados dos últimos dias, não há base para prever: só conta o que já foi registado.'}
      </p>
      {p.basisDays > 0 && (
        <>
          <button onClick={() => setOpen(o => !o)} className="self-start flex items-center gap-1.5 text-xs text-zinc-300 hover:text-zinc-100">
            Detalhe da previsão {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {open && (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs tabular-nums border-collapse">
                <tbody>
                  {b.lines.map(l => (
                    <tr key={l.key} className="border-b border-zinc-800/60">
                      <td className="px-1 py-1.5 text-zinc-300">{l.label}</td>
                      <td className="px-1 py-1.5 text-zinc-500">{l.detail}</td>
                      <td className="px-1 py-1.5 text-right text-zinc-200">{fmtEur(l.net)}</td>
                    </tr>
                  ))}
                  {b.vat.map(v => (
                    <tr key={v.rate} className="border-b border-zinc-800/60">
                      <td className="px-1 py-1.5 text-zinc-300">IVA {v.rate}%</td>
                      <td className="px-1 py-1.5 text-zinc-500">sobre {fmtEur(v.base)}</td>
                      <td className="px-1 py-1.5 text-right text-zinc-200">{fmtEur(v.tax)}</td>
                    </tr>
                  ))}
                  {b.exportCredit > 0 && (
                    <tr className="border-b border-zinc-800/60">
                      <td className="px-1 py-1.5 text-zinc-300">Excedente pago pela rede</td>
                      <td className="px-1 py-1.5 text-zinc-500">{kwh(p.projectedEnergy.total.exp)}</td>
                      <td className="px-1 py-1.5 text-right text-zinc-200">−{fmtEur(b.exportCredit)}</td>
                    </tr>
                  )}
                  <tr>
                    <td className="px-1 py-1.5 font-semibold text-zinc-100" colSpan={2}>Total previsto</td>
                    <td className="px-1 py-1.5 text-right font-semibold text-zinc-100">{fmtEur(b.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <button onClick={() => setOpen(o => !o)} className="self-start flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200">
        Como é calculado {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <ul className="flex flex-col gap-1.5 list-disc pl-4 marker:text-zinc-600 text-xs text-zinc-400 leading-relaxed">
          <li>
            Os kWh vêm da potência que a ponte lê ao inversor a cada ~30 segundos, somada em períodos de 15 minutos. Quando a ponte ou o
            inversor ficam sem ligação mais de 3 minutos, esse tempo fica sem dados (é indicado acima) em vez de ser inventado.
          </li>
          <li>
            O consumo da casa é calculado (solar − bateria − rede), como na app do inversor, e por isso inclui as perdas do próprio
            inversor: medido à noite, cerca de 10 % acima do consumo que o inversor indica em AC. O custo real não é afetado (vem da
            energia comprada à rede); o custo "sem painéis nem bateria" e a poupança ficam um pouco acima do real. A fatura vem do
            contador da E-REDES, que pode diferir uns pontos percentuais.
          </li>
          <li>
            <b className="text-zinc-300">Sem painéis nem bateria</b>: toda a energia que a casa gastou comprada à rede, ao preço da hora em
            que foi gasta. <b className="text-zinc-300">Só painéis</b>: o que o sol cobriu na hora, o resto comprado, o excedente enviado à rede.
            A poupança dos painéis é a diferença entre os dois; a da bateria, entre "só painéis" e o real (energia guardada e usada mais
            tarde, menos o que custou carregá-la).
          </li>
          <li>Potência, contribuição audiovisual e taxa DGEG contam pelos dias do período e são iguais nos três casos.</li>
          <li>
            <b className="text-zinc-300">Excedente</b>: energia dos painéis que foi para a rede em períodos de 15 minutos com mais de{' '}
            {SURPLUS_MIN_W} W em média; abaixo disso é o inversor a regular e não conta. "Bateria cheia": {BATTERY_FULL_SOC} % ou mais no
            fim do período, ou a bateria a carregar menos de {SURPLUS_MIN_W} W enquanto o sol ia para a rede. O valor é o que essa energia
            teria poupado se fosse usada em casa em vez de comprada, ao preço dessa hora com IVA; não é dinheiro perdido, porque não há
            contrato de venda.
          </li>
        </ul>
      )}
    </section>
  );
}

/**
 * Solar the house sent to the grid for nothing, above all with the battery
 * full: how much, what it would have been worth used instead of bought, and
 * when in the day it happens — the useful part ("run the machines, heat the
 * slab between 12:00 and 15:00").
 */
function SurplusSection({ s, grain, tariff, boost }: {
  s: SurplusSummary;
  grain: Grain;
  tariff: Tariff;
  boost: { enabled: boolean; exportW: number; delta: number } | null;
}) {
  const regulation = Math.max(0, s.exp - s.surplus);
  // The advice is about energy nothing else wanted: the battery-full hours when there are any.
  const win = surplusWindow(s.full > 0 ? s.byHourFull : s.byHour);
  const paid = tariff.exportPrice > 0;
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold text-zinc-100">Excedente solar</h2>
        <p className="text-xs text-zinc-500 leading-relaxed">
          Energia dos painéis que foi para a rede {paid ? 'paga a ' + String(tariff.exportPrice).replace('.', ',') + ' €/kWh' : 'sem pagamento'} e
          que podia ter sido usada em casa.
        </p>
      </div>
      {s.surplus === 0 ? (
        <p className="text-sm text-zinc-400">
          Sem excedente neste período: o sol foi todo usado em casa ou guardado na bateria
          {regulation > 0 ? ` (só ${fmtKwh(regulation)} de regulação do inversor foram para a rede)` : ''}.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Tile title="Excedente enviado à rede" value={fmtKwh(s.surplus)} tone="text-amber-200"
              hint={regulation > 0 ? `mais ${fmtKwh(regulation)} de regulação do inversor` : paid ? undefined : 'sem pagamento'} />
            <Tile title="Com a bateria cheia" value={fmtKwh(s.full)}
              hint={`${fmtPct(s.full / s.surplus)} do excedente${grain !== 'hour' && s.days > 1 ? ` · ${fmtKwh(s.full / s.days)} por dia` : ''}`} />
            <Tile title="Valor se fosse usado" value={fmtEur(s.value)} tone="text-emerald-300"
              hint={<>poupança possível, não receita · {fmtEur(s.valueFull)} com a bateria cheia</>} />
          </div>
          {win && (
            <p className="text-sm text-zinc-300 leading-relaxed">
              {grain === 'hour' ? 'Neste dia, o excedente' : 'O excedente costuma ser'} sobretudo entre as{' '}
              <b className="text-zinc-100">{fmtHours(win.from, win.to)}</b> ({fmtPct(win.share)}
              {s.full > 0 ? ' do que foi com a bateria cheia' : ''}). É a altura de pôr máquinas a trabalhar, usar o forno ou aquecer o
              pavimento: essa energia já está paga.
              {grain === 'hour' && s.full > 0 && ' As horas marcadas no gráfico tiveram excedente com a bateria cheia.'}
            </p>
          )}
          {grain !== 'hour' && <HourProfile s={s} />}
        </>
      )}
      {boost?.enabled && (
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          A automação do aquecimento já aproveita parte disto: durante o dia, com {boost.exportW} W ou mais a ir para a rede, sobe{' '}
          {String(boost.delta).replace('.', ',')}° o alvo das divisões para guardar calor no pavimento (bónus solar, nas definições da
          automação; só atua com a automação ligada e fora de simulação).
        </p>
      )}
    </section>
  );
}

/** Surplus by hour of day, averaged per day with readings: when in the day the panels outrun the house and the battery. */
function HourProfile({ s }: { s: SurplusSummary }) {
  const perDay = (wh: number) => wh / Math.max(1, s.days);
  const max = Math.max(...s.byHour.map(perDay), 1);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--viz-ink-2)]">
        <span className="text-zinc-500">Por hora do dia, média por dia</span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--viz-surplus)' }} aria-hidden="true" /> com a bateria cheia
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--viz-solar)', opacity: 0.55 }} aria-hidden="true" /> com a bateria a carregar
        </span>
      </div>
      <div
        className="flex items-end gap-px h-16"
        role="img"
        aria-label={`Excedente por hora do dia: máximo ${fmtKwh(max)} por dia`}
      >
        {s.byHour.map((wh, h) => {
          const full = perDay(s.byHourFull[h]);
          const rest = perDay(wh) - full;
          return (
            <div key={h} className="flex-1 h-full flex flex-col justify-end" title={`${fmtHours(h, h + 1)}: ${fmtKwh(perDay(wh))} por dia (${fmtKwh(full)} com a bateria cheia)`}>
              <div style={{ height: `${(rest / max) * 100}%`, background: 'var(--viz-solar)', opacity: 0.55 }} />
              <div style={{ height: `${(full / max) * 100}%`, background: 'var(--viz-surplus)' }} />
            </div>
          );
        })}
      </div>
      <div className="flex text-[10px] text-zinc-500 tabular-nums">
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="flex-1 text-center">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>
        ))}
      </div>
    </div>
  );
}
