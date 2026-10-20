// One-off events (Halloween, strike days...). Reads go to Firestore (published
// events are public; registrations are staff-only, or a family's own); every
// write goes through the callables in functions/src/kidclub/adhocEvents.ts.
import { getDocs, getDoc, query, where } from 'firebase/firestore';
import { col, docRef } from '../lib/db';
import { callable } from '../lib/callable';
import type { AdhocEvent, AdhocEventDay, AdhocEventRegistration } from '@shared/models';

const mapEvent = (id: string, x: any): AdhocEvent => ({
  id,
  name: String(x.name ?? ''),
  description: x.description || undefined,
  location: x.location || undefined,
  days: ((x.days ?? []) as AdhocEventDay[]).slice().sort((a, b) => a.date.localeCompare(b.date)),
  published: !!x.published,
  registrationOpen: !!x.registrationOpen,
  closesOn: x.closesOn || undefined,
  createdAt: x.createdAt,
  updatedAt: x.updatedAt,
});

export const lastDay = (ev: Pick<AdhocEvent, 'days'>) => ev.days[ev.days.length - 1]?.date ?? '';

export interface RegisterInput {
  eventId: string;
  days: string[];
  guardian: { name?: string; email?: string; phone: string; nif?: string };
  children: ({ name: string; birthDate?: string; healthNotes?: string } | { childId: string; healthNotes?: string })[];
  pickupNotes?: string;
  photoConsent: boolean;
  acceptTerms: boolean;
  payment: 'now' | 'monthly';
  familyId?: string;    // admins only: impersonating, or a walk-in for a family
  adminEntry?: boolean; // admins only: walk-in
}

export interface RegisterResult {
  registrationId: string;
  token: string;
  status: 'held' | 'confirmed';
  total: number;
  billingId: string | null;
  billingPeriod: string | null;
  holdExpiresAt: number | null;
}

/** What getAdhocRegistration returns: the registration page's view. */
export interface RegistrationView {
  id: string;
  eventId: string;
  eventName: string;
  location: string | null;
  kind: 'guest' | 'member';
  status: AdhocEventRegistration['status'];
  payment: 'now' | 'monthly';
  total: number;
  lines: { title: string; amount: number }[];
  billingPeriod: string | null;
  billingPeriodLabel: string | null;
  days: { date: string; startTime: string | null; endTime: string | null }[];
  children: string[];
  guardianName: string;
  guardianPhone: string;
  holdExpiresAt: number | null;
  mbwayAttemptsLeft: number;
  bill: { id: string; status: string; invoiceNumber: string | null; hasInvoice: boolean } | null;
  refundPending: boolean;
  cancelReason: string | null;
}

export const adhocEventService = {
  /** Published events whose last day hasn't passed, soonest first. Works signed out. */
  async listUpcoming(today: string): Promise<AdhocEvent[]> {
    const snap = await getDocs(query(col('adhocEvents'), where('published', '==', true)));
    return snap.docs.map(d => mapEvent(d.id, d.data()))
      .filter(ev => ev.days.length && lastDay(ev) >= today)
      .sort((a, b) => a.days[0].date.localeCompare(b.days[0].date));
  },

  async get(eventId: string): Promise<AdhocEvent | null> {
    const snap = await getDoc(docRef('adhocEvents', eventId));
    return snap.exists() ? mapEvent(snap.id, snap.data()) : null;
  },

  /** Admin: every event, newest first. */
  async listAll(): Promise<AdhocEvent[]> {
    const snap = await getDocs(col('adhocEvents'));
    return snap.docs.map(d => mapEvent(d.id, d.data()))
      .sort((a, b) => (b.days[0]?.date ?? '').localeCompare(a.days[0]?.date ?? ''));
  },

  /** Admin: an event's registrations, newest first. */
  async listRegistrations(eventId: string): Promise<AdhocEventRegistration[]> {
    const snap = await getDocs(query(col('adhocEventRegistrations'), where('eventId', '==', eventId)));
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<AdhocEventRegistration, 'id'>) }))
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  },

  /** A family's own registrations (rules: userId). */
  async listMine(userId: string): Promise<AdhocEventRegistration[]> {
    const snap = await getDocs(query(col('adhocEventRegistrations'), where('userId', '==', userId)));
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<AdhocEventRegistration, 'id'>) }));
  },

  save: (data: Omit<AdhocEvent, 'id' | 'days' | 'createdAt' | 'updatedAt'> & { eventId?: string; days: Omit<AdhocEventDay, 'taken'>[] }) =>
    callable<typeof data, { eventId: string }>('saveAdhocEvent')(data).then(r => r.data),
  remove: (eventId: string) => callable<{ eventId: string }, { ok: boolean }>('deleteAdhocEvent')({ eventId }).then(r => r.data),
  register: (input: RegisterInput) => callable<RegisterInput, RegisterResult>('registerForAdhocEvent')(input).then(r => r.data),
  getRegistration: (registrationId: string, token: string) =>
    callable<{ registrationId: string; token: string }, RegistrationView>('getAdhocRegistration')({ registrationId, token }).then(r => r.data),
  pay: (registrationId: string, token: string, phone: string) =>
    callable<{ registrationId: string; token: string; phone: string }, { easypayId: string }>('payAdhocRegistration')({ registrationId, token, phone }).then(r => r.data),
  cancel: (registrationId: string, reason: string) =>
    callable<{ registrationId: string; reason: string }, { ok: boolean; already: boolean; refundPending: boolean }>('cancelAdhocRegistration')({ registrationId, reason }).then(r => r.data),
  invoicePdf: (billingId: string, registrationId: string, token: string) =>
    callable<{ billingId: string; registrationId: string; token: string }, { filename: string; contentType: string; base64: string }>('getInvoicePdf')({ billingId, registrationId, token }).then(r => r.data),
};

// ── Display helpers ─────────────────────────────────────────────────────────

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** "sex, 31 out" */
export function fmtDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "09:00–17:30", or '' */
export const fmtTime = (day: { startTime?: string | null; endTime?: string | null }) =>
  day.startTime ? `${day.startTime}${day.endTime ? `–${day.endTime}` : ''}` : '';

export const fmtEur = (n: number) => `€${n.toFixed(2)}`;

/** yyyy-mm-dd in Lisbon (the server's "today"). */
export function lisbonToday(): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Why a signup can't happen now (shown instead of the form), or null. Mirrors signupRefusal on the server. */
export function eventClosedReason(ev: AdhocEvent, today: string): string | null {
  if (!ev.registrationOpen) return 'As inscrições para este evento estão fechadas.';
  if (ev.closesOn && ev.closesOn < today) return 'As inscrições para este evento já fecharam.';
  if (!ev.days.some(d => d.date >= today)) return 'Este evento já terminou.';
  return null;
}

/** The message of a callable error, as the server wrote it (Portuguese). */
export const callableMessage = (err: unknown, fallback = 'Ocorreu um erro. Tente novamente.') => {
  const m = (err as any)?.message;
  return typeof m === 'string' && m && m !== 'internal' && m !== 'INTERNAL' ? m : fallback;
};
