import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { addDays, firstDay, monthOf } from '@shared/finhub/dates';
import {
  BLUEPRINT_GROUPS, blueprints, unplannedGroupLines, yearGrid, type Blueprint, type BlueprintGroup,
} from '@shared/finhub/noisysource/blueprints';
import { ecRunway } from '@shared/finhub/noisysource/ec';
import { CALENDAR_KIND_LABEL, type NsEvent } from '@shared/finhub/noisysource/events';
import { intercompanyPosition } from '@shared/finhub/noisysource/intercompany';
import { loanInstalment, monthLabelPt } from '@shared/finhub/noisysource/plan';
import { costPlanVersions, termsAt, type NsState } from '@shared/finhub/noisysource/state';
import { useNs } from './NoisySourceModule';
import { eur, fmtDate, fmtDays, fmtMonth } from './format';
import { AbsenceForm, ContractForm, CostForm, HolidaysForm, IntercompanyForm, RuleForm, TermsForm } from './planForms';
import { confirmBlueprints, endContract, endEmployment, saveCost, undoEvent } from './planActions';
import { Badge } from './ui';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const SOURCE_LABEL: Record<string, string> = {
  manual: 'registado na app', system: 'sistema', 'import:seed': 'importado dos documentos', 'import:bpi-pdf': 'importado do extrato',
};
const BTN = 'rounded-md bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40';
const PRIMARY = 'rounded-md bg-sky-800 px-2 py-0.5 text-xs text-white hover:bg-sky-700 disabled:opacity-40';

const NEW_LABEL: Partial<Record<BlueprintGroup, string>> = {
  receitas: 'Novo contrato EC',
  pessoas: 'Nova pessoa',
  creditos: 'Novo crédito',
  'entre-empresas': 'Nova empresa',
  despesas: 'Nova despesa',
  calendario: 'Feriados',
};

function latestCost(s: NsState, key: string) {
  const v = costPlanVersions(s)[key];
  return v[v.length - 1];
}

const freqText = (c: { frequency: string; day: number; months?: number[]; from: string }) =>
  c.frequency === 'monthly' ? `mensal, dia ${c.day}`
  : c.frequency === 'annual' ? `anual (${(c.months ?? []).map(m => MONTHS[m - 1]).join(', ')}), dia ${c.day}`
  : `uma vez, ${fmtDate(c.from)}`;

/** One line that says what the blueprint is. */
function summary(b: Blueprint, s: NsState, today: string, accountId: string): string {
  switch (b.id.split(':')[0]) {
    case 'ec': {
      const c = s.contracts.find(x => x.number === b.ref)!;
      const r = ecRunway(s, c, today);
      return `${eur(c.dailyRateCents)}/dia · ${fmtDays(c.totalDays)} · início ${fmtDate(c.startDate)} · último dia ${fmtDate(r.lastDay)}`;
    }
    case 'pessoa': {
      const t = termsAt(s, b.ref, today) ?? s.terms[b.ref]?.[0];
      if (!t) return '';
      const vales = t.benefits.reduce((sum, x) => sum + (x.perMonthCents ?? 0), 0);
      return `bruto ${eur(t.grossMonthlyCents)} · IRS ${t.irsRatePct}% · SS ${t.ssEmpPct}% + ${t.ssErPct}% · refeição ${eur(t.mealPerDayCents)}/dia${vales ? ` · vales ${eur(vales)}/mês` : ''}`;
    }
    case 'custo': {
      const c = latestCost(s, b.ref);
      if (c.loan) {
        const inst = loanInstalment(c.loan, c.day, monthOf(today));
        return `em dívida ${inst ? eur(inst.balanceCents) : '—'} · capital ${eur(c.loan.capitalPerMonthCents)}/mês · ${c.loan.annualRatePct}% · dia ${c.day}`;
      }
      return `${eur(c.amountCents)} · ${freqText(c)}${c.to ? ` · até ${fmtDate(c.to)}` : ''}`;
    }
    case 'entre': {
      const ic = s.intercompany.find(x => x.key === b.ref)!;
      const owed = intercompanyPosition(s, ic, accountId).balanceCents;
      const who = owed === 0 ? 'nada em dívida' : owed > 0 ? `deve-nos ${eur(owed)}` : `devemos-lhe ${eur(-owed)}`;
      const back = ic.repayment ? `devolução ${eur(ic.repayment.amountCents)}/mês desde ${monthLabelPt(ic.repayment.firstMonth)}` : 'sem data de devolução';
      return `${who} · ${back}`;
    }
    case 'regra': {
      const r = s.rules.filter(x => x.what === b.ref).sort((x, y) => x.from.localeCompare(y.from)).filter(x => x.from <= today).pop() ?? s.rules.find(x => x.what === b.ref)!;
      const when = r.day === 31 ? 'último dia do mês' : `dia ${r.day}`;
      const offset = r.monthOffset === 1 ? ' do mês seguinte' : r.monthOffset > 1 ? ` (+${r.monthOffset} meses)` : '';
      return `${when}${offset}; se não for dia útil: ${r.nonBusinessDay === 'before' ? 'dia útil anterior' : 'dia útil seguinte'}${r.fee ? ` · ${r.fee.label} ${r.fee.pct}% + IVA ${r.fee.vatPct}%` : ''}`;
    }
    case 'feriados': {
      const [cal, year] = b.ref.split(':');
      return `${s.extraHolidays[cal]?.[Number(year)]?.length ?? 0} datas`;
    }
    case 'ausencias': {
      const days = s.calendar.filter(c => c.personId === b.ref).flatMap(c => c.dates).filter(d => d >= today);
      return `${days.length} dia(s) daqui para a frente`;
    }
    default: return '';
  }
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return <div className="flex gap-2"><dt className="w-44 shrink-0 text-zinc-500">{k}</dt><dd className="text-zinc-200">{v}</dd></div>;
}

/** Every value of the blueprint. */
function Details({ b }: { b: Blueprint }) {
  const { state, today, accountId, eventIds, reload } = useNs();
  const s = state!;
  const kind = b.id.split(':')[0];
  if (kind === 'ec') {
    const c = s.contracts.find(x => x.number === b.ref)!;
    const r = ecRunway(s, c, today);
    return <>
      {c.endClient && <Row k="Cliente final" v={c.endClient} />}
      {c.title && <Row k="Função" v={c.title} />}
      <Row k="Dias" v={`${fmtDays(c.totalDays)}: ${fmtDays(r.usedDays)} usados, ${fmtDays(r.leftDays)} por usar`} />
      <Row k="Aviso (3 meses antes)" v={fmtDate(r.warningDate)} />
      <Row k="Recebe" v={`${c.daysToPayment} dias depois da fatura`} />
      <Row k="IVA" v={String(c.vatCode)} />
      <Row k="Calendário" v={c.holidayCalendar} />
      {c.clientEstimatedEnd && <Row k="Último dia, segundo o cliente" v={fmtDate(c.clientEstimatedEnd)} />}
      {c.endedLastDay && <Row k="Terminado mais cedo" v={`${fmtDate(c.endedLastDay)}${c.endReason ? `: ${c.endReason}` : ''}`} />}
    </>;
  }
  if (kind === 'pessoa') {
    const versions = s.terms[b.ref] ?? [];
    const t = termsAt(s, b.ref, today) ?? versions[versions.length - 1];
    if (!t) return null;
    return <>
      <Row k="Em vigor desde" v={fmtDate(t.from)} />
      {versions.filter(v => v.from > today).map(v => <Row key={v.eventId} k={`A partir de ${fmtDate(v.from)}`} v={`bruto ${eur(v.grossMonthlyCents)} · IRS ${v.irsRatePct}%`} />)}
      <Row k="Subsídio de férias" v={t.holidaySubsidyMonth ? fmtMonthName(t.holidaySubsidyMonth) : 'sem'} />
      <Row k="Subsídio de Natal" v={t.christmasSubsidyMonth ? fmtMonthName(t.christmasSubsidyMonth) : 'sem'} />
      <Row k="Ajudas de custo" v={`${eur(t.perDiemCents)}/dia de viagem`} />
      {t.benefits.map(x => <Row key={x.code} k={x.label} v={`${x.perMonthCents != null ? `${eur(x.perMonthCents)}/mês` : `${eur(x.perDayCents ?? 0)}/dia`} · ${x.paidAs === 'cartao' ? 'cartão' : 'conta'}`} />)}
      {t.ssErNote && <Row k="SS empresa" v={t.ssErNote} />}
      {!!t.toConfirm?.length && <Row k="A confirmar" v={t.toConfirm.join(', ')} />}
    </>;
  }
  if (kind === 'custo') {
    const c = latestCost(s, b.ref);
    if (c.loan) {
      return <>
        <Row k="Capital emprestado" v={eur(c.loan.principalCents)} />
        <Row k="Primeira prestação" v={fmtMonth(c.loan.firstPaymentMonth)} />
        <Row k="Taxa anual" v={`${c.loan.annualRatePct}%`} />
        <Row k="Juros contados" v={c.loan.dayCount === 'dias-reais' ? 'dias reais / 360' : '1/12 da taxa por mês'} />
        <Row k="Imposto de selo" v={`${c.loan.stampDutyPct}% dos juros`} />
      </>;
    }
    return <>
      <Row k="Desde" v={fmtDate(c.from)} />
      <Row k="Sentido" v={c.direction === 'saida' ? 'sai da conta' : 'entra na conta'} />
      <Row k="IVA" v={String(c.vatCode)} />
    </>;
  }
  if (kind === 'entre') {
    const ic = s.intercompany.find(x => x.key === b.ref)!;
    const pos = intercompanyPosition(s, ic, accountId!);
    return <>
      <Row k="Saldo inicial" v={`${eur(Math.abs(ic.openingCents))} em ${fmtDate(ic.openingAsOf)}${ic.openingCents < 0 ? ' (devemos nós)' : ''}`} />
      <Row k="Nome no banco" v={ic.matchWords.join(', ')} />
      <Row k="Saiu / entrou" v={`${eur(pos.outCents)} / ${eur(pos.inCents)}`} />
      {pos.lines.map(l => <Row key={l.id} k={fmtDate(l.date)} v={`${eur(l.amountCents)} · ${l.description}`} />)}
    </>;
  }
  if (kind === 'regra') {
    const r = s.rules.filter(x => x.what === b.ref).pop()!;
    return r.evidence ? <Row k="De onde veio" v={r.evidence} /> : null;
  }
  if (kind === 'feriados') {
    const [cal, year] = b.ref.split(':');
    const meta = s.holidayMeta[b.ref];
    return <>
      {(s.extraHolidays[cal]?.[Number(year)] ?? []).map(d => <Row key={d} k={fmtDate(d)} v={meta?.names[d] ?? ''} />)}
      {meta?.note && <Row k="Nota" v={meta.note} />}
    </>;
  }
  if (kind === 'ausencias') {
    return <>{s.calendar.filter(c => c.personId === b.ref && c.dates.some(d => d >= today)).map(c => (
      <Row key={c.eventId} k={CALENDAR_KIND_LABEL[c.kind]} v={
        <span>{c.dates.map(fmtDate).join(', ')}{c.label ? ` · ${c.label}` : ''}{' '}
          <button className="text-red-300 hover:underline" onClick={() => undoEvent(c.eventId, eventIds, 'anulado no Plano').then(reload)}>anular</button>
        </span>
      } />
    ))}</>;
  }
  return null;
}

const fmtMonthName = (m: number) => MONTHS[m - 1];

function Origin({ b, byId }: { b: Blueprint; byId: Map<string, NsEvent> }) {
  const ev = byId.get(b.eventIds[b.eventIds.length - 1]);
  if (!ev) return null;
  return <p className="mt-1 text-[11px] text-zinc-500">Origem: {SOURCE_LABEL[ev.source] ?? ev.source}, {fmtDate(ev.recordedAt.slice(0, 10))}{ev.note ? ` · ${ev.note}` : ''}</p>;
}

function Card({ b, byId, focused }: { b: Blueprint; byId: Map<string, NsEvent>; focused: boolean }) {
  const { state, today, accountId, eventIds, reload } = useNs();
  const s = state!;
  const [open, setOpen] = useState(focused);
  const [form, setForm] = useState<null | 'edit' | 'end'>(null);
  const [endDate, setEndDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); reload(); setForm(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const kind = b.id.split(':')[0];
  const latestEvent = byId.get(b.eventIds[b.eventIds.length - 1]);
  // A corrected contract reversed its original: undoing the correction would leave no contract at all.
  const canUndoVersion = latestEvent?.source === 'manual' && kind !== 'ausencias' && !(kind === 'ec' && /-r\d+$/.test(latestEvent.id));
  const canEnd = b.active && (kind === 'ec' || kind === 'pessoa' || kind === 'custo');

  const finish = () => run(async () => {
    if (kind === 'ec') await endContract({ number: b.ref, lastDay: endDate }, eventIds);
    else if (kind === 'pessoa') await endEmployment({ personId: b.ref, lastDay: endDate }, eventIds);
    else {
      const { eventId: _unused, ...plan } = latestCost(s, b.ref);
      await saveCost({ ...plan, to: endDate }, eventIds);
    }
  });

  return (
    <div id={`bp-${b.id}`} className={`border-t border-zinc-800 px-3 py-2 ${focused ? 'bg-sky-950/20' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            <span className="text-zinc-500">{open ? '▾' : '▸'}</span> {b.label}
            {b.confirmed ? <Badge tone="emerald">confirmado</Badge> : b.active ? <Badge tone="zinc">por confirmar</Badge> : null}
            {b.placeholders.length > 0 && <Badge tone="amber" title={b.placeholders.join(', ')}>a confirmar</Badge>}
          </div>
          <div className="pl-4 text-xs text-zinc-400">{summary(b, s, today, accountId!)}</div>
        </button>
        <div className="flex flex-wrap gap-1">
          {b.active && !b.confirmed && <button disabled={busy} className={PRIMARY} onClick={() => run(() => confirmBlueprints([b], today, eventIds))}>Confirmar</button>}
          {b.confirmed && b.confirmEventId && <button disabled={busy} className={BTN} onClick={() => run(() => undoEvent(b.confirmEventId!, eventIds, 'confirmação desfeita no Plano'))}>Desfazer</button>}
          {kind !== 'ausencias' && <button className={BTN} onClick={() => { setOpen(true); setForm(form === 'edit' ? null : 'edit'); }}>{kind === 'ec' ? 'Corrigir' : 'Alterar'}</button>}
          {canEnd && <button className={BTN} onClick={() => { setOpen(true); setForm(form === 'end' ? null : 'end'); }}>Terminar</button>}
          {canUndoVersion && <button disabled={busy} className={BTN} title={kind === 'ec' ? 'Tira este contrato do plano' : 'Volta à versão anterior'} onClick={() => run(() => undoEvent(latestEvent!.id, eventIds, 'anulado no Plano'))}>{kind === 'ec' ? 'Remover' : 'Anular alteração'}</button>}
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
      {open && (
        <div className="mt-2 pl-4">
          <dl className="space-y-0.5 text-xs"><Details b={b} /></dl>
          <Origin b={b} byId={byId} />
          {form === 'end' && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              Último dia <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-white" />
              <button disabled={busy} className={PRIMARY} onClick={finish}>Terminar</button>
            </div>
          )}
          {form === 'edit' && kind === 'ec' && <ContractForm initial={s.contracts.find(c => c.number === b.ref)} onClose={() => setForm(null)} />}
          {form === 'edit' && kind === 'pessoa' && <TermsForm current={termsAt(s, b.ref, today) ?? s.terms[b.ref]?.[0]} onClose={() => setForm(null)} />}
          {form === 'edit' && kind === 'custo' && <CostForm current={latestCost(s, b.ref)} isLoan={!!latestCost(s, b.ref).loan} onClose={() => setForm(null)} />}
          {form === 'edit' && kind === 'entre' && <IntercompanyForm current={s.intercompany.find(x => x.key === b.ref)} onClose={() => setForm(null)} />}
          {form === 'edit' && kind === 'regra' && <RuleForm current={s.rules.filter(x => x.what === b.ref).pop()!} onClose={() => setForm(null)} />}
          {form === 'edit' && kind === 'feriados' && <HolidaysForm initial={{ calendarId: b.ref.split(':')[0], year: Number(b.ref.split(':')[1]) }} onClose={() => setForm(null)} />}
        </div>
      )}
    </div>
  );
}

function Section({ id, label, list, byId, focus, extra }: { id: BlueprintGroup; label: string; list: Blueprint[]; byId: Map<string, NsEvent>; focus: string | null; extra?: ReactNode }) {
  const { today, eventIds, reload } = useNs();
  const [adding, setAdding] = useState(false);
  const [absence, setAbsence] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = list.filter(b => b.active);
  const done = list.filter(b => !b.active);
  const open = active.filter(b => !b.confirmed);
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60">
      <header className="flex flex-wrap items-center justify-between gap-2 p-3">
        <h2 className="font-semibold">{label} <span className="text-xs font-normal text-zinc-500">{active.length - open.length}/{active.length} confirmados</span></h2>
        <div className="flex flex-wrap gap-1">
          {open.length > 1 && (
            <button disabled={busy} className={BTN} onClick={async () => { setBusy(true); try { await confirmBlueprints(open, today, eventIds); reload(); } finally { setBusy(false); } }}>
              Confirmar os {open.length}
            </button>
          )}
          {NEW_LABEL[id] && <button className={BTN} onClick={() => setAdding(!adding)}>{NEW_LABEL[id]}</button>}
          {id === 'calendario' && <button className={BTN} onClick={() => setAbsence(!absence)}>Ausência</button>}
        </div>
      </header>
      {extra}
      {adding && (
        <div className="px-3 pb-3">
          {id === 'receitas' && <ContractForm onClose={() => setAdding(false)} />}
          {id === 'pessoas' && <TermsForm onClose={() => setAdding(false)} />}
          {id === 'creditos' && <CostForm isLoan onClose={() => setAdding(false)} />}
          {id === 'entre-empresas' && <IntercompanyForm onClose={() => setAdding(false)} />}
          {id === 'despesas' && <CostForm onClose={() => setAdding(false)} />}
          {id === 'calendario' && <HolidaysForm onClose={() => setAdding(false)} />}
        </div>
      )}
      {absence && <div className="px-3 pb-3"><AbsenceForm onClose={() => setAbsence(false)} /></div>}
      {active.map(b => <Card key={b.id} b={b} byId={byId} focused={focus === b.id} />)}
      {active.length === 0 && !adding && <p className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">Nada ainda.</p>}
      {done.length > 0 && (
        <details className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">
          <summary className="cursor-pointer">Já terminados ({done.length})</summary>
          {done.map(b => <Card key={b.id} b={b} byId={byId} focused={focus === b.id} />)}
        </details>
      )}
    </section>
  );
}

/** Everything the forecast is generated from, what each value is, and whether Renato confirmed it. */
export default function PlanoPage() {
  const { state, today, accountId, rec, events } = useNs();
  const s = state!;
  const [params] = useSearchParams();
  const focus = params.get('b');
  const list = useMemo(() => blueprints(s, { today }), [s, today]);
  const byId = useMemo(() => new Map(events.map(e => [e.id, e])), [events]);
  const grid = useMemo(() => (accountId ? yearGrid(s, { accountId, today, rec }) : null), [s, accountId, today, rec]);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => {
    if (focus) document.getElementById(`bp-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus]);

  if (!accountId) return <p className="text-zinc-400">Sem extratos importados: não há conta de partida.</p>;
  const active = list.filter(b => b.active);
  const confirmed = active.filter(b => b.confirmed).length;
  const unplanned = rec ? unplannedGroupLines(s, rec) : null;
  const firstLine = s.movements.find(m => m.accountId === accountId);

  return (
    <div className="max-w-5xl space-y-4">
      <header>
        <h1 className="text-xl font-bold">Plano — NoisySource</h1>
        <p className="text-sm text-zinc-400">
          Tudo aquilo de que a previsão é gerada. Adiciona ou altera aqui, e os meses geram-se sozinhos: vê-os no{' '}
          <Link to="/v2/noisysource/ano" className="text-sky-300 hover:underline">Ano</Link>. Confirma cada um quando estiver certo.
        </p>
        <p className="mt-1 text-sm"><b>{confirmed}</b> de <b>{active.length}</b> confirmados.</p>
      </header>

      {grid && grid.warnings.length > 0 && (
        <ul className="space-y-1 rounded-md border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-100">
          {grid.warnings.map(w => <li key={w.text}>{w.text}</li>)}
        </ul>
      )}

      {BLUEPRINT_GROUPS.map(g => (
        <Section key={g.id} id={g.id} label={g.label} list={list.filter(b => b.group === g.id)} byId={byId} focus={focus}
          extra={g.id === 'entre-empresas' && unplanned && unplanned.count > 0 ? (
            <div className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-300">
              <p>
                O banco tem {unplanned.count} linha(s) com a NoisyPhocus: saiu {eur(unplanned.outCents)}, entrou {eur(unplanned.inCents)}.{' '}
                <button className={PRIMARY} onClick={() => setDrafting(!drafting)}>Criar a partir das linhas</button>
              </p>
              {drafting && firstLine && (
                <IntercompanyForm onClose={() => setDrafting(false)} draft={{
                  counterparty: 'NoisyPhocus', matchWords: ['NoisyPhocus'], openingCents: 0,
                  openingAsOf: addDays(firstDay(monthOf(firstLine.date)), -1), toConfirm: true,
                }} />
              )}
            </div>
          ) : undefined}
        />
      ))}
    </div>
  );
}
