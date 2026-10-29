// packages/shared/finhub/noisysource/events.ts
//
// NoisySource's event types on the shared envelope (HANDOFF-finhub-v2.md, "NoisySource events"),
// with a zod schema per payload. Plans change by a new event with a later effective date; facts
// change by a reversal and a new event. Nothing derived is ever stored.
//
// Additions to the handoff's table (night 1, marked in STATUS.md):
// - calendar kind 'licenca' (parental or other leave the company doesn't pay: base salary is
//   deducted per day, like the 2026 paternity leave on the payslips; EC days unchanged, see
//   days.ts);
// - `ec.contract.signed.opening`: days already used before FinHub's history starts;
// - `employment.terms.set`: subsidy months, holiday calendars, per diem value;
// - `cost.plan.set.loan`: an instalment computed from the outstanding capital;
// - `bank.movement.imported.seq`: the line's position in its statement (orders same-day lines).

import { z } from 'zod';
import { isVatCode, type VatCode } from '../../lib/vat';
import { envelopeSchema, isoDateSchema, yearMonthSchema, REVERSAL, type FinEvent } from '../envelope';
import { lastDay } from '../dates';

const cents = z.number().int();
const posCents = z.number().int().nonnegative();
const pct = z.number().min(0).max(100);
const dayOfMonth = z.number().int().min(1).max(31);
const vatCode = z.custom<VatCode>(isVatCode, 'código de IVA inválido');
const text = z.string().min(1);

// ── Plans ────────────────────────────────────────────────────────────────────

export const ecContractSignedSchema = z.object({
  number: text,
  /** The company invoiced (e.g. the platform the contract comes through). */
  client: text,
  /** Who the work is for, when different from `client`. */
  endClient: z.string().optional(),
  title: z.string().optional(),
  personId: text,
  dailyRateCents: z.number().int().positive(),
  totalDays: z.number().positive(),
  startDate: isoDateSchema,
  /** Holiday calendar the days follow (a `holidays.set` calendar id, e.g. 'client-ec'). */
  holidayCalendar: text,
  /** Calendar days from the invoice to the money arriving. */
  daysToPayment: z.number().int().min(0).max(180),
  vatCode,
  /** Days used before FinHub's history starts, up to and including `asOf`. */
  opening: z.object({ asOf: isoDateSchema, daysUsed: z.number().min(0) }).optional(),
  /** The client's own estimate of the last day, shown next to FinHub's. */
  clientEstimatedEnd: isoDateSchema.optional(),
});

export const ecContractEndedSchema = z.object({
  number: text,
  lastDay: isoDateSchema,
  reason: z.string().optional(),
});

export const PAYMENT_RULE_WHATS = ['salarios', 'refeicao', 'vales', 'ss', 'irs', 'ec-fatura'] as const;
export type PaymentRuleWhat = (typeof PAYMENT_RULE_WHATS)[number];

export const benefitSchema = z.object({
  code: text,
  label: text,
  perMonthCents: posCents.optional(),
  perDayCents: posCents.optional(),
  subjectToIRS: z.boolean(),
  subjectToSS: z.boolean(),
  /** 'cartao': loaded on a voucher card (not in the net pay); 'conta': paid with the salary. */
  paidAs: z.enum(['cartao', 'conta']),
});

export const employmentTermsSetSchema = z.object({
  personId: text,
  personName: text,
  from: isoDateSchema,
  contractType: z.enum(['employee', 'green_receipt']),
  grossMonthlyCents: posCents,
  irsRatePct: pct,
  ssEmpPct: pct,
  ssErPct: pct,
  /** Why the employer rate is what it is (e.g. an exemption), shown in the UI. */
  ssErNote: z.string().optional(),
  /** Meal allowance per meal day; 0 = none. */
  mealPerDayCents: posCents,
  mealPaidAs: z.enum(['cartao', 'conta']),
  /** Per diem (ajudas de custo) per trip day; 0 = none. */
  perDiemCents: posCents,
  benefits: z.array(benefitSchema),
  holidaySubsidyMonth: z.number().int().min(1).max(12).nullable(),
  christmasSubsidyMonth: z.number().int().min(1).max(12).nullable(),
  payDay: dayOfMonth,
  /** Calendars whose holidays aren't meal days (default pt-coimbra). */
  calendars: z.array(text).min(1),
  partTimeHours: z.number().positive().optional(),
  /** Fields that are a placeholder until Renato confirms them. */
  toConfirm: z.array(z.string()).optional(),
});

export const employmentEndedSchema = z.object({ personId: text, lastDay: isoDateSchema });

export const CALENDAR_KINDS = ['ferias', 'doenca', 'viagem', 'outro', 'licenca'] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

export const CALENDAR_KIND_LABEL: Record<CalendarKind, string> = {
  ferias: 'Férias',
  doenca: 'Doença',
  viagem: 'Viagem',
  outro: 'Outro',
  licenca: 'Licença (não paga pela empresa)',
};

export const calendarEntrySetSchema = z.object({
  personId: text,
  kind: z.enum(CALENDAR_KINDS),
  dates: z.array(isoDateSchema).min(1),
  halfDays: z.array(isoDateSchema),
  label: z.string().optional(),
  /** The dates are a placeholder (only the count is known). */
  datesToConfirm: z.boolean().optional(),
});

export const holidaysSetSchema = z.object({
  calendarId: text,
  year: z.number().int().min(2000).max(2100),
  dates: z.array(isoDateSchema),
  names: z.record(z.string(), z.string()).optional(),
  toConfirm: z.boolean().optional(),
  note: z.string().optional(),
});

export const paymentRuleSetSchema = z.object({
  what: z.enum(PAYMENT_RULE_WHATS),
  label: text,
  from: isoDateSchema,
  /** Day of the month (31 = the month's last day). */
  day: dayOfMonth,
  /** 0 = the same month as the work, 1 = the month after… */
  monthOffset: z.number().int().min(0).max(3),
  nonBusinessDay: z.enum(['before', 'after']),
  toConfirm: z.boolean().optional(),
  /** What the day was read from, e.g. "extratos 2026: 24–30". No amounts. */
  evidence: z.string().optional(),
});

export const loanSchema = z.object({
  principalCents: posCents,
  capitalPerMonthCents: posCents,
  annualRatePct: pct,
  firstPaymentMonth: yearMonthSchema,
  stampDutyPct: pct,
});

export const costPlanSetSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: text,
  /** VAT-inclusive, positive. `direction` says whether it leaves or enters the account. */
  amountCents: posCents,
  direction: z.enum(['saida', 'entrada']),
  vatCode,
  frequency: z.enum(['monthly', 'annual', 'once']),
  day: dayOfMonth,
  /** annual: the months it falls in (1–12); once: the single month. */
  months: z.array(z.number().int().min(1).max(12)).optional(),
  from: isoDateSchema,
  to: isoDateSchema.optional(),
  account: text,
  category: z.string().optional(),
  toConfirm: z.boolean().optional(),
  loan: loanSchema.optional(),
});

// ── Facts ────────────────────────────────────────────────────────────────────

export const ecTimesheetSubmittedSchema = z.object({
  contractNumber: text,
  month: yearMonthSchema,
  days: z.number().min(0),
  halfDays: z.number().int().min(0).optional(),
});

export const ecInvoiceIssuedSchema = z.object({
  invoiceNumber: text,
  contractNumber: text,
  month: yearMonthSchema,
  amountCents: posCents,
  vatCode,
  issueDate: isoDateSchema,
  dueDate: isoDateSchema,
});

export const PAYSLIP_LINE_KINDS = [
  'base', 'licenca', 'subsidio-ferias', 'subsidio-natal', 'refeicao', 'ajudas', 'beneficio', 'outro',
] as const;
export type PayslipLineKind = (typeof PAYSLIP_LINE_KINDS)[number];

export const payslipLineSchema = z.object({
  code: z.string(),
  label: text,
  kind: z.enum(PAYSLIP_LINE_KINDS),
  amountCents: cents,
  quantity: z.number().optional(),
  unitCents: cents.optional(),
  paidAs: z.enum(['cartao', 'conta']).optional(),
  /** Not on the document: rebuilt from other evidence (see the note). */
  rebuilt: z.boolean().optional(),
});

export const payslipRecordedSchema = z.object({
  personId: text,
  month: yearMonthSchema,
  lines: z.array(payslipLineSchema),
  grossCents: cents,
  irsRatePct: pct.optional(),
  irsCents: cents,
  ssEmpCents: cents,
  ssErCents: cents,
  /** Employer SS isn't on the payslip: true when ssErCents was derived. */
  ssErDerived: z.boolean().optional(),
  netCents: cents,
  payDate: isoDateSchema.optional(),
});

export const bankMovementImportedSchema = z.object({
  accountId: text,
  date: isoDateSchema,
  valueDate: isoDateSchema,
  amountCents: cents,
  description: z.string(),
  balanceAfterCents: cents,
  importId: text,
  /** Position of the line in its statement (orders same-day lines). */
  seq: z.number().int().min(0),
});

export const MATCH_TARGETS = ['ec-fatura', 'salario', 'refeicao', 'vales', 'ss', 'irs', 'custo', 'outro'] as const;

export const bankMovementMatchedSchema = z.object({
  movementId: text,
  to: z.enum(MATCH_TARGETS),
  ref: text,
  month: yearMonthSchema,
});

export const bankMovementClassifiedSchema = z.object({
  movementId: text,
  category: text,
  vatCode,
  description: text,
});

export const reversalPayloadSchema = z.object({});

export const NS_PAYLOAD_SCHEMAS = {
  'ec.contract.signed': ecContractSignedSchema,
  'ec.contract.ended': ecContractEndedSchema,
  'employment.terms.set': employmentTermsSetSchema,
  'employment.ended': employmentEndedSchema,
  'calendar.entry.set': calendarEntrySetSchema,
  'holidays.set': holidaysSetSchema,
  'payment.rule.set': paymentRuleSetSchema,
  'cost.plan.set': costPlanSetSchema,
  'ec.timesheet.submitted': ecTimesheetSubmittedSchema,
  'ec.invoice.issued': ecInvoiceIssuedSchema,
  'payroll.payslip.recorded': payslipRecordedSchema,
  'bank.movement.imported': bankMovementImportedSchema,
  'bank.movement.matched': bankMovementMatchedSchema,
  'bank.movement.classified': bankMovementClassifiedSchema,
  [REVERSAL]: reversalPayloadSchema,
} as const;

type Schemas = typeof NS_PAYLOAD_SCHEMAS;
export type NsEventType = keyof Schemas;
export type NsPayload<T extends NsEventType> = z.output<Schemas[T]>;
export type NsEventOf<T extends NsEventType> = FinEvent<T, NsPayload<T>> & { company: 'noisysource' };
export type NsEvent = { [T in NsEventType]: NsEventOf<T> }[NsEventType];

export type EcContractSigned = NsPayload<'ec.contract.signed'>;
export type EmploymentTerms = NsPayload<'employment.terms.set'>;
export type CalendarEntry = NsPayload<'calendar.entry.set'>;
export type PaymentRule = NsPayload<'payment.rule.set'>;
export type CostPlan = NsPayload<'cost.plan.set'>;
export type Payslip = NsPayload<'payroll.payslip.recorded'>;
export type PayslipLine = z.output<typeof payslipLineSchema>;
export type BankMovement = NsPayload<'bank.movement.imported'>;

export const NS_EVENT_TYPES = Object.keys(NS_PAYLOAD_SCHEMAS) as NsEventType[];

export function isNsEventType(t: unknown): t is NsEventType {
  return typeof t === 'string' && t in NS_PAYLOAD_SCHEMAS;
}

export type ParseResult = { ok: true; event: NsEvent } | { ok: false; id: string; error: string };

/** Validates an event read from storage (envelope + payload for its type). Never throws. */
export function parseNsEvent(raw: unknown): ParseResult {
  const id = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : '?';
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) return { ok: false, id, error: env.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  if (env.data.company !== 'noisysource') return { ok: false, id, error: `company ${env.data.company} ≠ noisysource` };
  if (!isNsEventType(env.data.type)) return { ok: false, id, error: `tipo desconhecido: ${env.data.type}` };
  if (env.data.type === REVERSAL && !env.data.reverses) return { ok: false, id, error: 'reversal sem `reverses`' };
  const payload = NS_PAYLOAD_SCHEMAS[env.data.type].safeParse(env.data.payload);
  if (!payload.success) {
    return { ok: false, id, error: payload.error.issues.map(i => `payload.${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, event: { ...env.data, payload: payload.data } as NsEvent };
}

// ── Ids (deterministic when the source has a natural key) ────────────────────

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const nsIds = {
  ecContract: (number: string) => `ec-${slug(number)}`,
  ecContractEnd: (number: string) => `ec-${slug(number)}-end`,
  terms: (personId: string, from: string) => `emp-${slug(personId)}-${from}`,
  employmentEnd: (personId: string) => `emp-${slug(personId)}-end`,
  calendar: (personId: string, kind: CalendarKind, firstDate: string) => `cal-${slug(personId)}-${kind}-${firstDate}`,
  holidays: (calendarId: string, year: number) => `hol-${slug(calendarId)}-${year}`,
  rule: (what: PaymentRuleWhat, from: string) => `rule-${what}-${from}`,
  cost: (key: string, from: string) => `cost-${slug(key)}-${from}`,
  timesheet: (number: string, month: string) => `ts-${slug(number)}-${month}`,
  invoice: (invoiceNumber: string) => `inv-${slug(invoiceNumber)}`,
  payslip: (personId: string, month: string) => `ps-${slug(personId)}-${month}`,
  match: (movementId: string) => `m-${movementId}`,
  classified: (movementId: string) => `c-${movementId}`,
};

/** The effective date an event of this type gets when nothing else is said. */
export function defaultEffectiveDate<T extends NsEventType>(type: T, payload: NsPayload<T>): string {
  const p = payload as Record<string, unknown>;
  switch (type) {
    case 'ec.contract.signed': return p.startDate as string;
    case 'ec.contract.ended': return p.lastDay as string;
    case 'employment.terms.set': return p.from as string;
    case 'employment.ended': return p.lastDay as string;
    case 'calendar.entry.set': return [...(p.dates as string[])].sort()[0];
    case 'holidays.set': return `${p.year}-01-01`;
    case 'payment.rule.set': return p.from as string;
    case 'cost.plan.set': return p.from as string;
    case 'ec.timesheet.submitted': return lastDay(p.month as string);
    case 'ec.invoice.issued': return p.issueDate as string;
    case 'payroll.payslip.recorded': return (p.payDate as string | undefined) ?? lastDay(p.month as string);
    case 'bank.movement.imported': return p.date as string;
    default: throw new Error(`no default effective date for ${type}`);
  }
}

export interface BuildOptions {
  id: string;
  source: FinEvent['source'];
  recordedBy: string;
  /** Server time on write; in-memory builds (tests, the importer's dry run) pass a fixed one. */
  recordedAt: string;
  effectiveDate?: string;
  note?: string;
  reverses?: string;
}

/** Builds and validates an event. Throws with the reason when the payload is wrong. */
export function buildNsEvent<T extends NsEventType>(type: T, payload: NsPayload<T>, o: BuildOptions): NsEventOf<T> {
  const raw = {
    id: o.id,
    company: 'noisysource' as const,
    type,
    effectiveDate: o.effectiveDate ?? (type === REVERSAL ? o.recordedAt.slice(0, 10) : defaultEffectiveDate(type, payload)),
    recordedAt: o.recordedAt,
    recordedBy: o.recordedBy,
    source: o.source,
    ...(o.reverses ? { reverses: o.reverses } : {}),
    ...(o.note ? { note: o.note } : {}),
    payload,
  };
  const parsed = parseNsEvent(raw);
  if (!parsed.ok) throw new Error(`${o.id}: ${parsed.error}`);
  return parsed.event as NsEventOf<T>;
}
