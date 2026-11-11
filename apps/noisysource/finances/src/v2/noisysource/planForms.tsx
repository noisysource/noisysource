// The Plano screen's forms: one per kind of blueprint. Each writes a new event (planActions.ts) and
// shows, before saving, what the values would generate.

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { addDays, addMonths, firstDay, monthOf, yearOf } from '@shared/finhub/dates';
import { nextContractStart } from '@shared/finhub/noisysource/blueprints';
import { ecRunway } from '@shared/finhub/noisysource/ec';
import {
  CALENDAR_KIND_LABEL, CALENDAR_KINDS, slug, type CalendarKind, type EmploymentTerms, type PaymentRule, type CostPlan,
  type EcContractSigned, type IntercompanyPlan,
} from '@shared/finhub/noisysource/events';
import { intercompanyPosition } from '@shared/finhub/noisysource/intercompany';
import { loanInstalment } from '@shared/finhub/noisysource/plan';
import { costPlanVersions, type EcContractState, type WithId } from '@shared/finhub/noisysource/state';
import type { VatCode } from '@shared/lib/vat';
import { useNs } from './NoisySourceModule';
import { centsInput, eur, fmtDate, parseCents, parseNumber } from './format';
import { saveCalendarEntry, saveContract, saveCost, saveHolidays, saveIntercompany, saveRule, saveTerms } from './planActions';

const INPUT = 'w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-white';

const VAT_OPTIONS: { value: string; label: string }[] = [
  { value: 'isento', label: 'Isento' },
  { value: 'autoliquidacao', label: 'Autoliquidação' },
  { value: '0', label: '0%' },
  { value: '6', label: '6%' },
  { value: '13', label: '13%' },
  { value: '23', label: '23%' },
  { value: 'por_confirmar', label: 'Por confirmar' },
];
const toVat = (v: string) => (/^\d+$/.test(v) ? Number(v) : v) as VatCode;

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`block text-xs text-zinc-400 ${wide ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
      <span className="mb-0.5 block">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-zinc-500">{hint}</span>}
    </label>
  );
}

interface ShellProps {
  title: string;
  submit: string;
  onCancel: () => void;
  onSave: () => Promise<void>;
  preview?: ReactNode;
  children: ReactNode;
}

/** Runs the save, shows what went wrong, and reloads the log when it worked. */
function FormShell({ title, submit, onCancel, onSave, preview, children }: ShellProps) {
  const { reload } = useNs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handle = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave();
      reload();
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={handle} className="mt-2 rounded-md border border-sky-900 bg-zinc-900 p-3">
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
      {preview && <div className="mt-2 rounded-md bg-zinc-800/60 px-2 py-1.5 text-xs text-zinc-300">{preview}</div>}
      {error && <p className="mt-2 rounded-md border border-red-800 bg-red-950/50 p-2 text-xs text-red-200">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={busy} className="rounded-md bg-sky-800 px-3 py-1 text-sm text-white hover:bg-sky-700 disabled:opacity-40">{submit}</button>
        <button type="button" onClick={onCancel} className="rounded-md bg-zinc-800 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-700">Cancelar</button>
      </div>
    </form>
  );
}

const nextMonthStart = (today: string) => firstDay(addMonths(monthOf(today), 1));

// ── EC contract ──────────────────────────────────────────────────────────────

export function ContractForm({ initial, onClose }: { initial?: EcContractState; onClose: () => void }) {
  const { state, today, eventIds } = useNs();
  const s = state!;
  const base = initial ?? s.contracts[s.contracts.length - 1];
  const [f, setF] = useState({
    number: initial?.number ?? '',
    client: base?.client ?? '',
    endClient: base?.endClient ?? '',
    title: base?.title ?? '',
    personId: base?.personId ?? s.people[0]?.id ?? '',
    rate: initial ? centsInput(initial.dailyRateCents) : '',
    totalDays: initial ? String(initial.totalDays).replace('.', ',') : '',
    startDate: initial?.startDate ?? nextContractStart(s, today),
    holidayCalendar: base?.holidayCalendar ?? '',
    daysToPayment: String(base?.daysToPayment ?? 10),
    vatCode: String(base?.vatCode ?? 'isento'),
    clientEstimatedEnd: initial?.clientEstimatedEnd ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const build = (): EcContractSigned => ({
    number: f.number.trim(),
    client: f.client.trim(),
    ...(f.endClient.trim() ? { endClient: f.endClient.trim() } : {}),
    ...(f.title.trim() ? { title: f.title.trim() } : {}),
    personId: f.personId,
    dailyRateCents: parseCents(f.rate),
    totalDays: parseNumber(f.totalDays),
    startDate: f.startDate,
    holidayCalendar: f.holidayCalendar.trim(),
    daysToPayment: Math.round(parseNumber(f.daysToPayment)),
    vatCode: toVat(f.vatCode),
    ...(initial?.opening ? { opening: initial.opening } : {}),
    ...(f.clientEstimatedEnd ? { clientEstimatedEnd: f.clientEstimatedEnd } : {}),
  });
  const preview = useMemo(() => {
    try {
      const r = ecRunway(s, { ...build(), eventId: 'preview' }, today);
      if (!r.months.length) return null;
      const total = r.months.reduce((t, m) => t + m.amountCents, 0);
      return <>Gera <b>{r.months.length} faturas</b> ({r.months[0].month} a {r.months[r.months.length - 1].month}), {eur(total)}. Último dia previsto: <b>{fmtDate(r.lastDay)}</b>.</>;
    } catch { return null; }
  }, [f, s, today]);
  const calendars = Object.keys(s.extraHolidays);
  return (
    <FormShell title={initial ? `Corrigir o contrato ${initial.number}` : 'Novo contrato EC'} submit={initial ? 'Guardar correção' : 'Adicionar contrato'}
      onCancel={onClose} preview={preview}
      onSave={() => saveContract(build(), initial?.eventId ?? null, eventIds)}>
      <Field label="Número"><input required disabled={!!initial} value={f.number} onChange={set('number')} className={INPUT} /></Field>
      <Field label="Taxa diária (€)"><input required inputMode="decimal" value={f.rate} onChange={set('rate')} className={INPUT} /></Field>
      <Field label="Dias do contrato"><input required inputMode="decimal" value={f.totalDays} onChange={set('totalDays')} className={INPUT} /></Field>
      <Field label="Início"><input required type="date" value={f.startDate} onChange={set('startDate')} className={INPUT} /></Field>
      <Field label="Quem fatura (cliente)"><input required value={f.client} onChange={set('client')} className={INPUT} /></Field>
      <Field label="Cliente final"><input value={f.endClient} onChange={set('endClient')} className={INPUT} /></Field>
      <Field label="Função"><input value={f.title} onChange={set('title')} className={INPUT} /></Field>
      <Field label="Quem trabalha">
        <select value={f.personId} onChange={set('personId')} className={INPUT}>{s.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </Field>
      <Field label="Calendário de feriados">
        <input required list="plan-calendars" value={f.holidayCalendar} onChange={set('holidayCalendar')} className={INPUT} />
        <datalist id="plan-calendars">{calendars.map(c => <option key={c} value={c} />)}</datalist>
      </Field>
      <Field label="Dias até receber"><input required inputMode="numeric" value={f.daysToPayment} onChange={set('daysToPayment')} className={INPUT} /></Field>
      <Field label="IVA">
        <select value={f.vatCode} onChange={set('vatCode')} className={INPUT}>{VAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      </Field>
      <Field label="Último dia segundo o cliente (opcional)"><input type="date" value={f.clientEstimatedEnd} onChange={set('clientEstimatedEnd')} className={INPUT} /></Field>
    </FormShell>
  );
}

// ── Person and salary ────────────────────────────────────────────────────────

interface BenefitRow { code: string; label: string; amount: string; paidAs: 'cartao' | 'conta'; irs: boolean; ss: boolean; perDay: boolean }

export function TermsForm({ current, onClose }: { current?: WithId<EmploymentTerms>; onClose: () => void }) {
  const { today, eventIds } = useNs();
  const [f, setF] = useState({
    name: current?.personName ?? '',
    from: nextMonthStart(today),
    gross: current ? centsInput(current.grossMonthlyCents) : '',
    irs: String(current?.irsRatePct ?? '').replace('.', ','),
    ssEmp: String(current?.ssEmpPct ?? 11).replace('.', ','),
    ssEr: String(current?.ssErPct ?? 23.75).replace('.', ','),
    meal: current ? centsInput(current.mealPerDayCents) : '0,00',
    perDiem: current ? centsInput(current.perDiemCents) : '0,00',
    holiday: String(current?.holidaySubsidyMonth ?? 6),
    christmas: String(current?.christmasSubsidyMonth ?? 11),
    payDay: String(current?.payDay ?? 25),
  });
  const [benefits, setBenefits] = useState<BenefitRow[]>((current?.benefits ?? []).map(b => ({
    code: b.code, label: b.label, amount: centsInput(b.perMonthCents ?? b.perDayCents ?? 0), paidAs: b.paidAs, irs: b.subjectToIRS, ss: b.subjectToSS, perDay: b.perDayCents != null,
  })));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const setB = (i: number, patch: Partial<BenefitRow>) => setBenefits(benefits.map((b, k) => (k === i ? { ...b, ...patch } : b)));
  const month = (v: string) => (v.trim() ? Math.round(parseNumber(v)) : null);
  const build = (): EmploymentTerms => ({
    personId: current?.personId ?? slug(f.name),
    personName: f.name.trim(),
    from: f.from,
    contractType: current?.contractType ?? 'employee',
    grossMonthlyCents: parseCents(f.gross),
    irsRatePct: parseNumber(f.irs),
    ssEmpPct: parseNumber(f.ssEmp),
    ssErPct: parseNumber(f.ssEr),
    ...(current?.ssErNote ? { ssErNote: current.ssErNote } : {}),
    mealPerDayCents: parseCents(f.meal),
    mealPaidAs: current?.mealPaidAs ?? 'cartao',
    perDiemCents: parseCents(f.perDiem),
    benefits: benefits.filter(b => b.label.trim()).map(b => ({
      code: b.code || slug(b.label),
      label: b.label.trim(),
      ...(b.perDay ? { perDayCents: parseCents(b.amount) } : { perMonthCents: parseCents(b.amount) }),
      subjectToIRS: b.irs,
      subjectToSS: b.ss,
      paidAs: b.paidAs,
    })),
    holidaySubsidyMonth: month(f.holiday),
    christmasSubsidyMonth: month(f.christmas),
    payDay: Math.round(parseNumber(f.payDay)),
    calendars: current?.calendars ?? ['pt-coimbra'],
    ...(current?.partTimeHours ? { partTimeHours: current.partTimeHours } : {}),
  });
  return (
    <FormShell title={current ? `Alterar ${current.personName}` : 'Nova pessoa'} submit="Guardar" onCancel={onClose}
      onSave={() => saveTerms(build(), eventIds)}>
      {!current && <Field label="Nome"><input required value={f.name} onChange={set('name')} className={INPUT} /></Field>}
      <Field label="A partir de" hint="Os meses anteriores ficam como estavam."><input required type="date" value={f.from} onChange={set('from')} className={INPUT} /></Field>
      <Field label="Bruto mensal (€)"><input required inputMode="decimal" value={f.gross} onChange={set('gross')} className={INPUT} /></Field>
      <Field label="Retenção IRS (%)"><input required inputMode="decimal" value={f.irs} onChange={set('irs')} className={INPUT} /></Field>
      <Field label="SS trabalhador (%)"><input required inputMode="decimal" value={f.ssEmp} onChange={set('ssEmp')} className={INPUT} /></Field>
      <Field label="SS empresa (%)" hint={current?.ssErNote}><input required inputMode="decimal" value={f.ssEr} onChange={set('ssEr')} className={INPUT} /></Field>
      <Field label="Refeição por dia (€)"><input required inputMode="decimal" value={f.meal} onChange={set('meal')} className={INPUT} /></Field>
      <Field label="Ajudas de custo por dia (€)"><input required inputMode="decimal" value={f.perDiem} onChange={set('perDiem')} className={INPUT} /></Field>
      <Field label="Subsídio de férias (mês 1–12)"><input inputMode="numeric" value={f.holiday} onChange={set('holiday')} className={INPUT} /></Field>
      <Field label="Subsídio de Natal (mês 1–12)"><input inputMode="numeric" value={f.christmas} onChange={set('christmas')} className={INPUT} /></Field>
      <Field label="Dia de pagamento"><input required inputMode="numeric" value={f.payDay} onChange={set('payDay')} className={INPUT} /></Field>
      <div className="sm:col-span-2 lg:col-span-3">
        <div className="mb-1 text-xs text-zinc-400">Benefícios (vales)</div>
        {benefits.map((b, i) => (
          <div key={i} className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <input aria-label="Benefício" value={b.label} onChange={e => setB(i, { label: e.target.value })} className={`${INPUT} max-w-56`} />
            <input aria-label="Valor" inputMode="decimal" value={b.amount} onChange={e => setB(i, { amount: e.target.value })} className={`${INPUT} max-w-24`} />
            <span>{b.perDay ? '€/dia' : '€/mês'}</span>
            <select aria-label="Pago em" value={b.paidAs} onChange={e => setB(i, { paidAs: e.target.value as BenefitRow['paidAs'] })} className={`${INPUT} max-w-24`}>
              <option value="cartao">cartão</option>
              <option value="conta">conta</option>
            </select>
            <label><input type="checkbox" checked={b.irs} onChange={e => setB(i, { irs: e.target.checked })} /> IRS</label>
            <label><input type="checkbox" checked={b.ss} onChange={e => setB(i, { ss: e.target.checked })} /> SS</label>
            <button type="button" onClick={() => setBenefits(benefits.filter((_, k) => k !== i))} className="text-red-300 hover:underline">remover</button>
          </div>
        ))}
        <button type="button" onClick={() => setBenefits([...benefits, { code: '', label: '', amount: '0,00', paidAs: 'cartao', irs: false, ss: false, perDay: false }])}
          className="text-xs text-sky-300 hover:underline">+ benefício</button>
      </div>
    </FormShell>
  );
}

// ── Expense and loan ─────────────────────────────────────────────────────────

export function CostForm({ current, isLoan, onClose }: { current?: WithId<CostPlan>; isLoan?: boolean; onClose: () => void }) {
  const { state, today, accountId, eventIds } = useNs();
  const [f, setF] = useState({
    description: current?.description ?? '',
    amount: current ? centsInput(current.amountCents) : '',
    direction: current?.direction ?? 'saida',
    frequency: current?.frequency ?? 'monthly',
    months: (current?.months ?? []).join(', '),
    day: String(current?.day ?? 1),
    // A loan's values define its whole schedule: a correction replaces it, not just the months ahead.
    from: current ? (current.loan ? current.from : nextMonthStart(today)) : today,
    to: current?.to ?? '',
    vatCode: String(current?.vatCode ?? 'isento'),
    principal: current?.loan ? centsInput(current.loan.principalCents) : '',
    capital: current?.loan ? centsInput(current.loan.capitalPerMonthCents) : '',
    rate: String(current?.loan?.annualRatePct ?? '').replace('.', ','),
    firstMonth: current?.loan?.firstPaymentMonth ?? monthOf(today),
    stamp: String(current?.loan?.stampDutyPct ?? 4).replace('.', ','),
    dayCount: current?.loan?.dayCount ?? 'mensal',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const newKey = () => {
    const taken = costPlanVersions(state!);
    const base = slug(f.description) || 'custo';
    let key = base;
    for (let n = 2; taken[key]; n++) key = `${base}-${n}`;
    return key;
  };
  const build = (): CostPlan => ({
    key: current?.key ?? newKey(),
    description: f.description.trim(),
    amountCents: isLoan ? 0 : parseCents(f.amount),
    direction: isLoan ? 'saida' : f.direction as CostPlan['direction'],
    vatCode: toVat(f.vatCode),
    frequency: isLoan ? 'monthly' : f.frequency as CostPlan['frequency'],
    day: Math.round(parseNumber(f.day)),
    ...(!isLoan && f.frequency !== 'monthly' ? { months: f.months.split(/[,\s]+/).filter(Boolean).map(m => Math.round(parseNumber(m))) } : {}),
    from: f.from,
    ...(f.to ? { to: f.to } : {}),
    account: current?.account ?? accountId!,
    ...(current?.category ? { category: current.category } : {}),
    ...(isLoan ? {
      loan: {
        principalCents: parseCents(f.principal),
        capitalPerMonthCents: parseCents(f.capital),
        annualRatePct: parseNumber(f.rate),
        firstPaymentMonth: f.firstMonth,
        stampDutyPct: parseNumber(f.stamp),
        dayCount: f.dayCount as 'mensal' | 'dias-reais',
      },
    } : {}),
  });
  const preview = useMemo(() => {
    if (!isLoan) return null;
    try {
      const plan = build();
      const month = addMonths(monthOf(today), 1);
      const inst = loanInstalment(plan.loan!, plan.day, month);
      if (!inst) return 'Nada em dívida no próximo mês com estes valores.';
      return <>Prestação de {month}: capital {eur(inst.capitalCents)} + juros {eur(inst.interestCents)} sobre {eur(inst.balanceCents)} + selo {eur(inst.stampCents)} = <b>{eur(inst.capitalCents + inst.interestCents + inst.stampCents)}</b>.</>;
    } catch { return null; }
  }, [f, today]);
  const title = current ? `Alterar ${current.description}` : isLoan ? 'Novo crédito' : 'Nova despesa';
  return (
    <FormShell title={title} submit="Guardar" onCancel={onClose} preview={preview} onSave={() => saveCost(build(), eventIds)}>
      <Field label="Descrição" wide><input required value={f.description} onChange={set('description')} className={INPUT} /></Field>
      {isLoan ? <>
        <Field label="Capital emprestado (€)"><input required inputMode="decimal" value={f.principal} onChange={set('principal')} className={INPUT} /></Field>
        <Field label="Amortização por mês (€)"><input required inputMode="decimal" value={f.capital} onChange={set('capital')} className={INPUT} /></Field>
        <Field label="Taxa anual (%)"><input required inputMode="decimal" value={f.rate} onChange={set('rate')} className={INPUT} /></Field>
        <Field label="Primeira prestação (mês)"><input required type="month" value={f.firstMonth} onChange={set('firstMonth')} className={INPUT} /></Field>
        <Field label="Imposto de selo sobre os juros (%)"><input required inputMode="decimal" value={f.stamp} onChange={set('stamp')} className={INPUT} /></Field>
        <Field label="Juros contados">
          <select value={f.dayCount} onChange={set('dayCount')} className={INPUT}>
            <option value="mensal">1/12 da taxa por mês</option>
            <option value="dias-reais">dias reais / 360 (como o banco)</option>
          </select>
        </Field>
      </> : <>
        <Field label="Valor com IVA (€)"><input required inputMode="decimal" value={f.amount} onChange={set('amount')} className={INPUT} /></Field>
        <Field label="Sentido">
          <select value={f.direction} onChange={set('direction')} className={INPUT}><option value="saida">Sai da conta</option><option value="entrada">Entra na conta</option></select>
        </Field>
        <Field label="Frequência">
          <select value={f.frequency} onChange={set('frequency')} className={INPUT}><option value="monthly">Mensal</option><option value="annual">Anual</option><option value="once">Uma vez</option></select>
        </Field>
        {f.frequency === 'annual' && <Field label="Meses (1–12, separados por vírgula)"><input required value={f.months} onChange={set('months')} className={INPUT} /></Field>}
        <Field label="IVA">
          <select value={f.vatCode} onChange={set('vatCode')} className={INPUT}>{VAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        </Field>
      </>}
      <Field label="Dia do mês"><input required inputMode="numeric" value={f.day} onChange={set('day')} className={INPUT} /></Field>
      <Field label="A partir de" hint={current ? (isLoan ? 'Com a mesma data, substitui o crédito todo.' : 'Os meses anteriores ficam como estavam.') : undefined}><input required type="date" value={f.from} onChange={set('from')} className={INPUT} /></Field>
      <Field label="Até (opcional)"><input type="date" value={f.to} onChange={set('to')} className={INPUT} /></Field>
    </FormShell>
  );
}

// ── Money between companies ──────────────────────────────────────────────────

export function IntercompanyForm({ current, draft, onClose }: { current?: WithId<IntercompanyPlan>; draft?: Partial<IntercompanyPlan>; onClose: () => void }) {
  const { state, today, accountId, eventIds } = useNs();
  const v = current ?? draft;
  const [f, setF] = useState({
    counterparty: v?.counterparty ?? '',
    words: (v?.matchWords ?? []).join(', '),
    openingAsOf: v?.openingAsOf ?? today,
    opening: centsInput(Math.abs(v?.openingCents ?? 0)),
    openingSide: (v?.openingCents ?? 0) < 0 ? 'devemos' : 'devem',
    toConfirm: v?.toConfirm ?? true,
    hasRepayment: !!v?.repayment,
    repayAmount: v?.repayment ? centsInput(v.repayment.amountCents) : '',
    repayMonth: v?.repayment?.firstMonth ?? addMonths(monthOf(today), 1),
    repayDay: String(v?.repayment?.day ?? 15),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const build = (): IntercompanyPlan => ({
    key: current?.key ?? slug(f.counterparty),
    counterparty: f.counterparty.trim(),
    matchWords: f.words.split(',').map(w => w.trim()).filter(Boolean),
    from: today,
    openingCents: parseCents(f.opening) * (f.openingSide === 'devemos' ? -1 : 1),
    openingAsOf: f.openingAsOf,
    ...(f.hasRepayment ? { repayment: { amountCents: parseCents(f.repayAmount), firstMonth: f.repayMonth, day: Math.round(parseNumber(f.repayDay)) } } : {}),
    ...(f.toConfirm ? { toConfirm: true } : {}),
  });
  const preview = useMemo(() => {
    try {
      const plan = build();
      const pos = intercompanyPosition(state!, plan, accountId!);
      const b = pos.balanceCents;
      return <>
        {pos.lines.length} linha(s) do banco: saiu {eur(pos.outCents)}, entrou {eur(pos.inCents)}.{' '}
        <b>{b === 0 ? 'Nada em dívida.' : b > 0 ? `${plan.counterparty} deve ${eur(b)}.` : `Devemos ${eur(-b)} a ${plan.counterparty}.`}</b>
      </>;
    } catch { return null; }
  }, [f, state, accountId]);
  return (
    <FormShell title={current ? `Alterar ${current.counterparty}` : 'Dinheiro entre empresas'} submit="Guardar" onCancel={onClose} preview={preview}
      onSave={() => saveIntercompany(build(), eventIds)}>
      <Field label="Empresa"><input required disabled={!!current} value={f.counterparty} onChange={set('counterparty')} className={INPUT} /></Field>
      <Field label="Nome nas linhas do banco" hint="Separados por vírgula. Maiúsculas, acentos e espaços não contam."><input required value={f.words} onChange={set('words')} className={INPUT} /></Field>
      <Field label="Saldo inicial em" hint="O que já estava em dívida antes desta data."><input required type="date" value={f.openingAsOf} onChange={set('openingAsOf')} className={INPUT} /></Field>
      <Field label="Saldo inicial (€)"><input required inputMode="decimal" value={f.opening} onChange={set('opening')} className={INPUT} /></Field>
      <Field label="Quem deve">
        <select value={f.openingSide} onChange={set('openingSide')} className={INPUT}><option value="devem">Eles devem-nos</option><option value="devemos">Nós devemos-lhes</option></select>
      </Field>
      <Field label="Saldo inicial por confirmar">
        <label className="flex items-center gap-2 py-1 text-sm text-zinc-300"><input type="checkbox" checked={f.toConfirm} onChange={e => setF({ ...f, toConfirm: e.target.checked })} /> ainda não sei ao certo</label>
      </Field>
      <div className="sm:col-span-2 lg:col-span-3">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={f.hasRepayment} onChange={e => setF({ ...f, hasRepayment: e.target.checked })} /> Já há plano de devolução (sem plano, fica fora da previsão)
        </label>
      </div>
      {f.hasRepayment && <>
        <Field label="Devolução por mês (€)" hint="Para uma só vez, põe o total."><input required inputMode="decimal" value={f.repayAmount} onChange={set('repayAmount')} className={INPUT} /></Field>
        <Field label="Primeiro mês"><input required type="month" value={f.repayMonth} onChange={set('repayMonth')} className={INPUT} /></Field>
        <Field label="Dia do mês"><input required inputMode="numeric" value={f.repayDay} onChange={set('repayDay')} className={INPUT} /></Field>
      </>}
    </FormShell>
  );
}

// ── Payment day ──────────────────────────────────────────────────────────────

export function RuleForm({ current, onClose }: { current: WithId<PaymentRule>; onClose: () => void }) {
  const { today, eventIds } = useNs();
  const [f, setF] = useState({
    from: nextMonthStart(today),
    day: String(current.day),
    monthOffset: String(current.monthOffset),
    nonBusinessDay: current.nonBusinessDay as string,
    feePct: String(current.fee?.pct ?? '').replace('.', ','),
    feeVat: String(current.fee?.vatPct ?? '').replace('.', ','),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const build = (): PaymentRule => ({
    what: current.what,
    label: current.label,
    from: f.from,
    day: Math.round(parseNumber(f.day)),
    monthOffset: Math.round(parseNumber(f.monthOffset)),
    nonBusinessDay: f.nonBusinessDay as PaymentRule['nonBusinessDay'],
    ...(current.evidence ? { evidence: current.evidence } : {}),
    ...(current.fee ? { fee: { label: current.fee.label, pct: parseNumber(f.feePct), vatPct: parseNumber(f.feeVat) } } : {}),
  });
  return (
    <FormShell title={`Alterar ${current.label}`} submit="Guardar" onCancel={onClose} onSave={() => saveRule(build(), eventIds)}>
      <Field label="A partir de"><input required type="date" value={f.from} onChange={set('from')} className={INPUT} /></Field>
      <Field label="Dia do mês" hint="31 = último dia do mês."><input required inputMode="numeric" value={f.day} onChange={set('day')} className={INPUT} /></Field>
      <Field label="Meses depois do mês de trabalho"><input required inputMode="numeric" value={f.monthOffset} onChange={set('monthOffset')} className={INPUT} /></Field>
      <Field label="Se não for dia útil">
        <select value={f.nonBusinessDay} onChange={set('nonBusinessDay')} className={INPUT}><option value="before">Dia útil anterior</option><option value="after">Dia útil seguinte</option></select>
      </Field>
      {current.fee && <>
        <Field label={`${current.fee.label} (%)`}><input required inputMode="decimal" value={f.feePct} onChange={set('feePct')} className={INPUT} /></Field>
        <Field label="IVA sobre a comissão (%)"><input required inputMode="decimal" value={f.feeVat} onChange={set('feeVat')} className={INPUT} /></Field>
      </>}
    </FormShell>
  );
}

// ── Calendar ─────────────────────────────────────────────────────────────────

/** '2027-04-02', '02/04/2027' or '2/4' (the form's year), separated by commas, spaces or lines. */
export function parseDates(text: string, year?: number): string[] {
  return text.split(/[\s,;]+/).filter(Boolean).map(t => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
    const y = m?.[3] ?? year;
    if (!m || !y) throw new Error(`Data inválida: "${t}"`);
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  });
}

export function HolidaysForm({ initial, onClose }: { initial?: { calendarId: string; year: number }; onClose: () => void }) {
  const { state, today, eventIds } = useNs();
  const s = state!;
  const dates = initial ? s.extraHolidays[initial.calendarId]?.[initial.year] ?? [] : [];
  const [f, setF] = useState({
    calendarId: initial?.calendarId ?? Object.keys(s.extraHolidays)[0] ?? '',
    year: String(initial?.year ?? yearOf(today) + 1),
    dates: dates.join('\n'),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const meta = initial ? s.holidayMeta[`${initial.calendarId}:${initial.year}`] : undefined;
  return (
    <FormShell title={initial ? `Feriados ${initial.calendarId} ${initial.year}` : 'Feriados de um calendário'} submit="Guardar" onCancel={onClose}
      onSave={() => {
        const year = Math.round(parseNumber(f.year));
        return saveHolidays({ calendarId: f.calendarId.trim(), year, dates: parseDates(f.dates, year), ...(meta?.note ? { note: meta.note } : {}), ...(Object.keys(meta?.names ?? {}).length ? { names: meta!.names } : {}) }, eventIds);
      }}>
      <Field label="Calendário">
        <input required list="plan-calendars-h" disabled={!!initial} value={f.calendarId} onChange={set('calendarId')} className={INPUT} />
        <datalist id="plan-calendars-h">{Object.keys(s.extraHolidays).map(c => <option key={c} value={c} />)}</datalist>
      </Field>
      <Field label="Ano"><input required disabled={!!initial} inputMode="numeric" value={f.year} onChange={set('year')} className={INPUT} /></Field>
      <Field label="Datas" hint="Uma por linha ou separadas por vírgula: 2/4 ou 2027-04-02. Substitui a lista desse ano." wide>
        <textarea required rows={5} value={f.dates} onChange={set('dates')} className={INPUT} />
      </Field>
    </FormShell>
  );
}

export function AbsenceForm({ onClose }: { onClose: () => void }) {
  const { state, today, eventIds } = useNs();
  const s = state!;
  const [f, setF] = useState({ personId: s.people[0]?.id ?? '', kind: 'ferias' as CalendarKind, dates: '', label: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <FormShell title="Nova ausência" submit="Guardar" onCancel={onClose}
      onSave={() => saveCalendarEntry({
        personId: f.personId, kind: f.kind, dates: parseDates(f.dates, yearOf(addDays(today, 30))), halfDays: [], ...(f.label.trim() ? { label: f.label.trim() } : {}),
      }, eventIds)}>
      <Field label="Quem">
        <select value={f.personId} onChange={set('personId')} className={INPUT}>{s.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </Field>
      <Field label="Tipo">
        <select value={f.kind} onChange={set('kind')} className={INPUT}>{CALENDAR_KINDS.map(k => <option key={k} value={k}>{CALENDAR_KIND_LABEL[k]}</option>)}</select>
      </Field>
      <Field label="Nota"><input value={f.label} onChange={set('label')} className={INPUT} /></Field>
      <Field label="Datas" hint="Uma por linha ou separadas por vírgula: 3/8/2027 ou 2027-08-03." wide>
        <textarea required rows={3} value={f.dates} onChange={set('dates')} className={INPUT} />
      </Field>
    </FormShell>
  );
}
