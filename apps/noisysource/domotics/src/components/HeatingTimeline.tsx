import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, lisbonDate } from '@shared/lib/energyBill';
import type { AutomationStatus } from '../data/automation';
import { cachedHeatingDay, heatingDayDue, loadHeatingDay, loadWarmupMaxMin } from '../data/heatingHistory';
import { HEATING_TONES, buildHeatingDay, hhmm, nextPlanStep, warmForecast, type HeatingRecord } from '../data/heatingTimeline';
import DayStrip, { StripLegend, ToneSwatch, type StripSelection } from './timeline/DayStrip';
import { stepSelection } from './timeline/stripLogic';

/**
 * The heating's day at a glance: what happens next, then Plano, Bomba and
 * Temperatura on one axis, tap for when, what, who and why, and the day's events
 * below. The logic is in data/heatingTimeline.ts, the records in
 * data/heatingHistory.ts; signed out on the LAN there's only the plan.
 */

interface Props {
  status?: AutomationStatus;
  /** The history is the owner's alone (firestore.rules). */
  canRead: boolean;
  /** The pump as read just now; undefined if it isn't answering. */
  pumpOn?: boolean;
  now: number;
}

const label = 'text-[10px] uppercase tracking-widest text-zinc-500';
const iconBtn = 'shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-30';

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('pt-PT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

export default function HeatingTimeline({ status, canRead, pumpOn, now }: Props) {
  const today = lisbonDate(now);
  /** null: follows today, across midnight too. */
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? today;
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);

  const dateShown = useRef(date);
  dateShown.current = date;

  const [selection, setSelection] = useState<StripSelection | null>(null);
  const [record, setRecord] = useState<{ date: string; record: HeatingRecord } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setSelection(null); setFailed(false); }, [date]);

  const [warmupMaxMin, setWarmupMaxMin] = useState<number>();
  useEffect(() => {
    if (!canRead) return;
    let live = true;
    void loadWarmupMaxMin().then(v => { if (live) setWarmupMaxMin(v); });
    return () => { live = false; };
  }, [canRead]);

  // The pump switching, or the automation saying it did: worth a look at the record sooner than the regular refresh.
  const lastPumpAction = status?.actions.find(a => a.device === 'Bomba de calor')?.at;
  const hint = `${pumpOn}|${lastPumpAction}`;
  const seenHint = useRef(hint);
  const forceNext = useRef(false);

  // Runs on every clock tick, but only reads Firestore when heatingDayDue says so.
  useEffect(() => {
    if (!canRead || date > today) return;
    if (hint !== seenHint.current) { seenHint.current = hint; forceNext.current = true; }
    const cached = cachedHeatingDay(date);
    if (cached) setRecord(r => (r?.record === cached ? r : { date, record: cached }));
    if (document.visibilityState === 'hidden') return;
    const force = forceNext.current && date >= yesterday;
    if (!heatingDayDue(date, Date.now(), force)) return;
    forceNext.current = false;
    // Not cancelled by the next tick: a slow read still lands, if this day is still the one on screen.
    loadHeatingDay(date, force)
      .then(r => {
        if (dateShown.current !== date) return;
        setFailed(false);
        if (r) setRecord({ date, record: r });
      })
      .catch(() => { if (dateShown.current === date) setFailed(true); });
  }, [canRead, date, today, yesterday, now, hint]);

  const shown = canRead && record?.date === date ? record.record : undefined;
  const view = useMemo(
    () => buildHeatingDay({ date, now, status, pumpOn, record: shown, warmupMaxMin }),
    [date, now, status, pumpOn, shown, warmupMaxMin],
  );

  const sel = selection ?? view.defaultSelection;
  const detail = sel ? view.describe(sel) : null;
  const next = date === today ? nextPlanStep(status, now, warmupMaxMin) : null;
  const forecast = date === today ? warmForecast(status, now) : null;
  const loading = canRead && !shown && !failed && date <= today;

  const pill = (text: string, target: string, disabled = false) => (
    <button
      key={target}
      type="button"
      disabled={disabled}
      aria-pressed={date === target}
      onClick={() => { setPicked(target === today ? null : target); setSelection(null); }}
      className={`flex-1 min-w-0 h-9 rounded-lg text-xs font-medium disabled:opacity-30 ${date === target ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'}`}
    >
      {text}
    </button>
  );

  return (
    <div className="flex flex-col gap-2.5">
      {(next || forecast) && (
        <div className="flex flex-col gap-1">
          {next && (
            <p className="text-xs text-zinc-300 leading-snug tabular-nums">
              <span className="text-zinc-500">A seguir: </span>{next.text}
            </p>
          )}
          {forecast && <p className="text-xs text-amber-300 leading-snug">{forecast.text}</p>}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <button type="button" className={iconBtn} aria-label="Dia anterior" disabled={!canRead && date <= today}
            onClick={() => { const d = addDays(date, -1); setPicked(d === today ? null : d); }}>
            <ChevronLeft size={15} />
          </button>
          {pill('Ontem', yesterday, !canRead)}
          {pill('Hoje', today)}
          {pill('Amanhã', tomorrow)}
          <button type="button" className={iconBtn} aria-label="Dia seguinte" disabled={date >= tomorrow}
            onClick={() => { const d = addDays(date, 1); setPicked(d === today ? null : d); }}>
            <ChevronRight size={15} />
          </button>
        </div>
        <p className="text-[11px] text-zinc-500 first-letter:uppercase">{dayLabel(date)}</p>
      </div>

      <DayStrip
        from={view.from}
        to={view.to}
        lanes={view.lanes}
        tones={HEATING_TONES}
        now={view.now}
        selection={sel}
        onSelect={setSelection}
        ariaLabel={`Aquecimento, ${dayLabel(date)}: plano, bomba e temperatura. Setas para mudar de troço.`}
      />
      <StripLegend tones={HEATING_TONES} keys={view.legend} />

      {!canRead && date <= today && (
        <p className="text-[11px] text-zinc-500 leading-snug">
          Aqui vê-se o plano e as últimas ações. O que a bomba fez e porquê precisa de sessão iniciada (kidclub-dev-domotics.web.app).
        </p>
      )}
      {loading && <p className="text-[11px] text-zinc-500">A ler o histórico…</p>}
      {failed && canRead && <p className="text-[11px] text-amber-300">Não foi possível ler o histórico. Tenta de novo daqui a uns minutos.</p>}
      {view.empty && <p className="text-[11px] text-zinc-500">Sem registos neste dia.</p>}
      {view.plan.length === 0 && <p className="text-[11px] text-zinc-500">Sem plano: a ponte ainda não deu as definições.</p>}

      {/* What the selection means. Under the strip so the finger doesn't cover it. */}
      <div className="flex items-stretch gap-1.5 rounded-lg bg-zinc-950/60 border border-zinc-800 p-1.5">
        <button type="button" className={iconBtn} aria-label="Troço anterior" disabled={!sel}
          onClick={() => sel && setSelection(stepSelection(view.lanes, sel, -1))}>
          <ChevronLeft size={15} />
        </button>
        <div aria-live="polite" className="flex-1 min-w-0 flex flex-col gap-1 py-1 self-center">
          {detail ? (
            <>
              <p className="text-xs text-zinc-100 leading-snug">
                <b className="font-semibold tabular-nums">{detail.when}</b>
                {' · '}{detail.text.slice(detail.when.length + 3)}
              </p>
              {detail.facts && <p className="text-[11px] text-zinc-400 leading-snug tabular-nums">{detail.facts}</p>}
              {detail.note && <p className="text-[11px] text-zinc-500 leading-snug">{detail.note}</p>}
            </>
          ) : (
            <p className="text-xs text-zinc-500 leading-snug">Toque numa faixa para ver quando, o quê, quem e porquê.</p>
          )}
        </div>
        <button type="button" className={iconBtn} aria-label="Troço seguinte" disabled={!sel}
          onClick={() => sel && setSelection(stepSelection(view.lanes, sel, 1))}>
          <ChevronRight size={15} />
        </button>
      </div>

      {view.phase !== 'future' && (
        <div className="flex flex-col gap-1">
          <span className={label}>{canRead ? 'O que aconteceu' : 'Últimas ações'}</span>
          {view.events.length === 0 ? (
            <p className="text-[11px] text-zinc-500">{loading ? '…' : 'Nada registado.'}</p>
          ) : (
            <ul className="flex flex-col">
              {view.events.map(e => (
                <li key={e.id}>
                  <button
                    type="button"
                    disabled={!e.select}
                    onClick={() => e.select && setSelection(e.select)}
                    className="w-full min-h-9 flex items-start gap-2 py-1 text-left rounded enabled:hover:bg-zinc-800/60"
                  >
                    <span className="w-10 shrink-0 text-xs text-zinc-400 tabular-nums">{hhmm(e.at)}</span>
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-200">
                        {e.tone && HEATING_TONES[e.tone] && <ToneSwatch tone={HEATING_TONES[e.tone]} />}
                        {e.what}
                        <span className="text-zinc-500">· {e.who}</span>
                      </span>
                      {e.why && (
                        <span className="text-[11px] text-zinc-500 leading-snug">
                          {e.why}{e.derived ? ' (deduzido do plano)' : ''}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
