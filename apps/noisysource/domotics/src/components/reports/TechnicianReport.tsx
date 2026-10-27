import { useMemo } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import {
  codeSummary, endPhrase, fmtDate, fmtDateTime, fmtLongDate, fmtTime, hourOfDay, linkPrevious, num, shortRunSpell,
  SOURCE_LABEL, spellSummary, tripContext, type FaultIncident, type Incident, type SwitchEvent,
} from '../../data/incidents';
import { faultGuide } from '../../data/heatpumpFaults';
import PumpChart from './PumpChart';
import { MinutesBefore, TripTable } from './parts';

/**
 * The Reports page as a document for the heat pump technicians: pt-PT, light,
 * A4, printable or saved as PDF from the browser's print dialog. Replaces the
 * hand-written report of 23/10 (domotics-bridge/deploy/relatorio-e13-
 * 2026-10-23.html) and follows its structure, but every figure comes from
 * `domotics_incidents`.
 */

interface Props {
  incidents: Incident[];
  onClose: () => void;
}

/** This house's unit, as on its label and in its manual. */
const EQUIPMENT = 'Zantia Vancouver 13 (13DC-32), R32, monofásica · código 2301-0273 (etiqueta 2301-8273)';
const USE = 'Só aquecimento por piso radiante, 6 zonas com termóstato e válvula. As águas quentes (AQS) são feitas por outra bomba de calor.';

const h2 = 'text-base font-semibold text-zinc-900 border-b border-zinc-300 pb-1';
const cell = 'px-2 py-1.5 text-left align-top';

export default function TechnicianReport({ incidents, onClose }: Props) {
  const now = Date.now();
  const all = useMemo(() => [...incidents].sort((a, b) => a.at - b.at), [incidents]);
  const faults = linkPrevious(all.filter((i): i is FaultIncident => i.kind === 'fault'));
  const spell = shortRunSpell(faults, now);
  const codes = [...new Set(faults.map(f => f.code))];
  const detailed = faults.filter(f => tripContext(f));
  const outsideOffs = all.filter((i): i is SwitchEvent => i.kind === 'switch' && !i.on && i.source === 'outside');
  // The biggest group of those within 15 min of the same time of day: a timer's signature.
  const sameHour = outsideOffs
    .map(a => outsideOffs.filter(b => {
      const d = Math.abs(hourOfDay(a.at) - hourOfDay(b.at));
      return Math.min(d, 24 - d) <= 0.25;
    }))
    .sort((a, b) => b.length - a.length)[0] ?? [];

  const title = codes.length === 0 ? 'Bomba de calor: registo de ocorrências'
    : codes.length === 1 ? `Bomba de calor: alarme ${codes[0]} (${faultGuide(codes[0]).name.toLowerCase()}) repetido`
    : `Bomba de calor: alarmes ${codes.join(', ')}`;

  return (
    <div className="viz-light min-h-screen h-screen overflow-y-auto bg-white text-zinc-900 print:h-auto print:overflow-visible">
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2 bg-zinc-100 border-b border-zinc-300 print:hidden"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
        <button onClick={onClose} className="w-9 h-9 flex items-center justify-center rounded-lg bg-white border border-zinc-300 hover:bg-zinc-50 text-zinc-700" aria-label="Voltar">
          <ArrowLeft size={16} />
        </button>
        <span className="flex-1 text-xs text-zinc-600">Para enviar por email: Imprimir → Guardar como PDF.</span>
        <button onClick={() => window.print()} className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-semibold">
          <Printer size={14} /> Imprimir
        </button>
      </div>

      <article className="max-w-[52rem] mx-auto px-5 py-6 flex flex-col gap-6 text-sm leading-relaxed print:px-0 print:py-0">
        <header className="flex flex-col gap-3">
          <p className="text-xs text-zinc-500">
            Relatório para assistência técnica · atualizado a {fmtLongDate(now)}, {fmtTime(now)}
          </p>
          <h1 className="text-xl font-semibold text-zinc-900">{title}</h1>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-500">Equipamento</dt><dd>{EQUIPMENT}</dd>
            <dt className="text-zinc-500">Utilização</dt><dd>{USE}</dd>
            {all.length > 0 && (<><dt className="text-zinc-500">Período</dt><dd>{fmtLongDate(all[0].at)} a {fmtLongDate(all[all.length - 1].at)}</dd></>)}
            {codes.map(c => {
              const g = faultGuide(c);
              return (
                <div key={c} className="contents">
                  <dt className="text-zinc-500">Alarme {c}</dt>
                  <dd>{g.name.toLowerCase()}{g.where ? ` (${g.where})` : ''}</dd>
                </div>
              );
            })}
          </dl>
        </header>

        {spell.length > 0 && (
          <section className="flex flex-col gap-2 rounded-lg border-2 border-red-300 px-4 py-3 print-avoid-break">
            <h2 className="text-base font-semibold text-red-800">Situação atual: dispara em todos os arranques</h2>
            <ul className="list-disc pl-5 flex flex-col gap-1">
              {spellSummary(spell, faults[faults.indexOf(spell[0]) - 1]).map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h2 className={h2}>Resumo</h2>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            {codes.flatMap(c => codeSummary(faults.filter(f => f.code === c)).map((s, i) => (
              <li key={`${c}-${i}`}>{codes.length > 1 ? <b>{c}: </b> : null}{s}</li>
            )))}
            {codes.map(c => faultGuide(c).behaviour && <li key={`b-${c}`}>{faultGuide(c).behaviour}</li>)}
            {outsideOffs.length > 0 && (
              <li>
                A máquina foi desligada {outsideOffs.length} {outsideOffs.length === 1 ? 'vez' : 'vezes'} sem ser pela ponte nem pelo
                cliente ({outsideOffs.map(s => fmtDateTime(s.at)).join(', ')})
                {sameHour.length >= 2 ? `, ${sameHour.length} delas às ${sameHour.map(s => fmtTime(s.at)).join(' / ')}, em dias diferentes — como um temporizador.` : '.'}
              </li>
            )}
          </ul>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className={h2}>Ocorrências</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse tabular-nums">
              <thead>
                <tr className="border-b border-zinc-400 text-zinc-600">
                  <th className={cell}>Data e hora</th><th className={cell}>Água (setpoint)</th>
                  <th className={cell}>Situação</th><th className={cell}>Notas</th>
                </tr>
              </thead>
              <tbody>
                {all.map(i => (
                  <tr key={i.id} className="border-b border-zinc-200 print-avoid-break">
                    <td className={`${cell} whitespace-nowrap`}>{i.origin === 'notes' ? '~' : ''}{fmtDateTime(i.at)}</td>
                    <td className={`${cell} whitespace-nowrap`}>{i.kind === 'note' ? '' : setpointOf(i)}</td>
                    <td className={cell}>{situation(i)}</td>
                    <td className={`${cell} text-zinc-700`}>{notesOf(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-zinc-500">~ = hora aproximada (conhecida só pelas notas, sem registo contínuo).</p>
        </section>

        {detailed.length > 0 && (
          <section className="flex flex-col gap-4">
            <h2 className={h2}>Os minutos antes de cada disparo</h2>
            <p className="text-xs text-zinc-600">
              Leituras da própria máquina. Descarga = C01. A faixa vermelha é o tempo em avaria; a linha vermelha, o disparo.
            </p>
            {detailed.map((f, n) => {
              const c = tripContext(f)!;
              return (
                <div key={f.id} className="flex flex-col gap-2 print-avoid-break">
                  <h3 className="text-sm font-semibold">
                    Disparo {String.fromCharCode(65 + n)} · {fmtDate(f.at)} {fmtTime(f.at)} · água a {c.last.sp ?? '—'} °C
                  </h3>
                  <p className="text-xs text-zinc-600">
                    exterior {num(c.last.outdoor)} °C · leituras a cada {c.step >= 55 ? 'minuto' : `${Math.round(c.step / 10) * 10} s`}
                    {c.last.valves !== undefined ? ` · ${c.last.valves} ${c.last.valves === 1 ? 'zona aberta' : 'zonas abertas'}${c.last.zones !== undefined ? ` (de ${c.last.zones} legíveis)` : ''}` : ''}
                    {c.runMin !== undefined ? ` · ${c.runMin} min depois de arrancar` : c.runOver !== undefined ? ` · a trabalhar há mais de ${c.runOver} min` : ''}
                    {f.minutesSincePrevious !== undefined ? ` · ${f.minutesSincePrevious} min depois do disparo anterior` : ''}
                    {' · '}{f.lockout ? 'bloqueou — ' : ''}{endPhrase(f)}
                  </p>
                  <PumpChart samples={[...f.before, ...f.after]} tripAt={f.at} tripLabel={f.codes.join(', ')} printable />
                  <MinutesBefore f={f} light />
                </div>
              );
            })}
          </section>
        )}

        {detailed.length > 1 && (
          <section className="flex flex-col gap-2">
            <h2 className={h2}>O que distingue os disparos</h2>
            <TripTable trips={detailed} light />
          </section>
        )}

        {codes.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className={h2}>Pedido de verificação</h2>
            {codes.map(c => {
              const g = faultGuide(c);
              return (
                <div key={c} className="flex flex-col gap-1 print-avoid-break">
                  {codes.length > 1 && <h3 className="text-sm font-semibold">{c} · {g.name}</h3>}
                  {g.causes.length > 0 && (
                    <>
                      <p>Causas que o manual indica, a confirmar no local:</p>
                      <ul className="list-disc pl-5">{g.causes.map(x => <li key={x}>{x}</li>)}</ul>
                    </>
                  )}
                  <ul className="list-disc pl-5">{g.todo.map(x => <li key={x}>{x}</li>)}</ul>
                </div>
              );
            })}
          </section>
        )}

        <footer className="text-[11px] text-zinc-500 border-t border-zinc-300 pt-2">
          Leituras obtidas da própria máquina através do seu módulo Wi-Fi (Tuya), com o significado de cada sensor segundo o
          modelo de dados do equipamento. Horas em hora legal de Portugal. Os registos completos estão disponíveis em ficheiro.
        </footer>
      </article>
    </div>
  );
}

function setpointOf(i: FaultIncident | SwitchEvent): string {
  const s = i.kind === 'fault' ? (i.after[0] ?? i.before.at(-1)) : i.before.at(-1);
  return s?.sp !== undefined ? `${s.sp} °C` : '—';
}

function situation(i: Incident): string {
  if (i.kind === 'fault') return `${i.codes.join(', ')}${i.lockout ? ' — bloqueou' : ''}`;
  if (i.kind === 'switch') return `${i.on ? 'ligada' : 'desligada'} ${SOURCE_LABEL[i.source]}`;
  return 'nota';
}

function notesOf(i: Incident): string {
  if (i.kind === 'note') return i.note;
  if (i.kind === 'switch') {
    return [i.faults.length ? `ainda em ${i.faults.join(', ')}` : '', i.reason, i.note].filter(Boolean).join('. ');
  }
  const c = tripContext(i);
  const parts = [
    i.origin !== 'notes' ? endPhrase(i) : '',
    c?.disRise !== undefined ? `descarga ${num(c.disBefore)} → ${num(c.disAt)} °C` : '',
    i.note ?? '',
  ];
  return parts.filter(Boolean).join('. ');
}
