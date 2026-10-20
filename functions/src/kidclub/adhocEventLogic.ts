// Pure logic for one-off events (adhocEvents.ts): input validation, prices,
// seats, which monthly bill a registration goes on, line items and emails.
// No Firestore here, so it's unit-tested (adhocEventLogic.test.ts).
//
// Prices and seats mirror packages/shared/models/AdhocEvent.ts (functions
// can't import @shared at runtime, see billing.ts); adhocEventParity.test.ts
// keeps them equal.
import { randomBytes, timingSafeEqual } from "crypto";
import { realNif } from "./vendusClientLogic";

export const ADHOC_MAX_CHILDREN = 4;
export const ADHOC_HOLD_MINUTES = 30;
// Every MB WAY attempt keeps the hold for at least this long. EasyPay expires
// an unanswered MB WAY request after ~5 minutes, so a hold is never released
// while a payment the parent could still approve is out.
export const ADHOC_MBWAY_HOLD_MINUTES = 15;
export const ADHOC_MAX_MBWAY_ATTEMPTS = 3;
// Guest (no account) signups and token-based MB WAY starts, per Lisbon day,
// across every event. A public form that reaches EasyPay and sends emails must
// fail closed: past these, the callables refuse until tomorrow.
export const DAILY_GUEST_REGISTRATION_CAP = 100;
export const DAILY_TOKEN_MBWAY_CAP = 150;
export const ADHOC_VAT_CODE = 23; // KIDCLUB_VAT.event in packages/shared/models/kidclubVat.ts
export const MBWAY_MIN_TOTAL = 0.5;

export type Tier = "public" | "member";
export type Payment = "now" | "monthly";

export interface EventDay {
  date: string;
  startTime?: string;
  endTime?: string;
  capacity: number;
  price: number;
  memberPrice?: number;
  taken: number;
}

export interface EventDoc {
  name: string;
  published?: boolean;
  registrationOpen?: boolean;
  closesOn?: string;
  days: EventDay[];
  location?: string;
}

// ── Prices ────────────────────────────────────────────────────────────────────

export function dayPrice(day: Pick<EventDay, "price" | "memberPrice">, tier: Tier): number {
  if (tier === "member" && typeof day.memberPrice === "number" && day.memberPrice >= 0) return day.memberPrice;
  return day.price;
}

/** € for `childCount` children on the chosen days, to the cent. */
export function eventTotal(days: Pick<EventDay, "date" | "price" | "memberPrice">[], chosen: string[], childCount: number, tier: Tier): number {
  let cents = 0;
  for (const d of days) if (chosen.includes(d.date)) cents += Math.round(dayPrice(d, tier) * 100) * childCount;
  return cents / 100;
}

export const seatsLeft = (day: Pick<EventDay, "capacity" | "taken">) => Math.max(0, (day.capacity ?? 0) - (day.taken ?? 0));

// ── Dates ─────────────────────────────────────────────────────────────────────

/** yyyy-mm-dd in Lisbon. formatToParts, not a locale pattern (see manualPayment.ts). */
export function lisbonDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validIsoDate = (s: unknown): s is string => typeof s === "string" && ISO_DATE.test(s) && !isNaN(Date.parse(`${s}T12:00:00Z`));

const PT_MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
/** "2026-11" → "Novembro 2026", the monthly bill's periodLabel (periodForDate in billing.ts). */
export const periodLabelPt = (period: string) => `${PT_MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

/** "31/10" */
export const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// ── Input validation ──────────────────────────────────────────────────────────

export interface GuestChildInput { name: string; birthDate?: string; healthNotes?: string }
export interface MemberChildInput { childId: string; healthNotes?: string }

export interface RegistrationInput {
  eventId: string;
  days: string[];
  guardian: { name: string; email: string; phone: string; nif?: string };
  guestChildren: GuestChildInput[];
  memberChildren: MemberChildInput[];
  pickupNotes?: string;
  photoConsent: boolean;
  payment: Payment;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Portuguese mobile/landline: 9 digits, optionally with +351 / 00351. */
export function normalizePhone(v: unknown): string {
  const digits = str(v, 30).replace(/\D/g, "");
  const national = digits.startsWith("00351") ? digits.slice(5) : digits.startsWith("351") && digits.length === 12 ? digits.slice(3) : digits;
  return /^[29]\d{8}$/.test(national) ? national : "";
}

/** Same checksum as apps/noisyphocus/kidclub/src/lib/nif.ts isValidNif. */
export function isValidNif(v: string): boolean {
  if (!/^\d{9}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(v[i]) * (9 - i);
  const check = 11 - (sum % 11);
  return (check >= 10 ? 0 : check) === Number(v[8]);
}

/**
 * Checks and normalizes what the signup form sent. `member`: the children are
 * the family's own (ids), and the guardian comes from the family; a guest
 * types everything. Returns an error message (Portuguese, shown to the parent)
 * or the clean input.
 */
export function parseRegistrationInput(raw: any, member: boolean): { error: string } | { input: RegistrationInput } {
  const eventId = str(raw?.eventId, 100);
  if (!eventId) return { error: "Evento em falta." };
  if (raw?.acceptTerms !== true) return { error: "É necessário aceitar os termos e a política de privacidade." };

  const days = Array.isArray(raw?.days) ? [...new Set(raw.days.filter(validIsoDate) as string[])].sort() : [];
  if (!days.length) return { error: "Escolha pelo menos um dia." };

  const g = raw?.guardian ?? {};
  const guardian = {
    name: str(g.name, 100),
    email: str(g.email, 200).toLowerCase(),
    phone: normalizePhone(g.phone),
    nif: realNif(str(g.nif, 20)) || undefined,
  };
  if (!guardian.phone) return { error: "Indique um número de telemóvel válido (9 dígitos)." };
  if (!member) {
    if (guardian.name.length < 2) return { error: "Indique o nome do encarregado de educação." };
    if (!EMAIL.test(guardian.email)) return { error: "Indique um email válido." };
    if (guardian.nif && !isValidNif(guardian.nif)) return { error: "NIF inválido — confirme os 9 dígitos, ou deixe em branco." };
  }

  const rawChildren: any[] = Array.isArray(raw?.children) ? raw.children : [];
  if (!rawChildren.length) return { error: "Indique pelo menos uma criança." };
  if (rawChildren.length > ADHOC_MAX_CHILDREN) return { error: `No máximo ${ADHOC_MAX_CHILDREN} crianças por inscrição.` };

  const guestChildren: GuestChildInput[] = [];
  const memberChildren: MemberChildInput[] = [];
  for (const c of rawChildren) {
    const healthNotes = str(c?.healthNotes, 500) || undefined;
    if (member) {
      const childId = str(c?.childId, 100);
      if (!childId) return { error: "Criança inválida." };
      memberChildren.push({ childId, ...(healthNotes ? { healthNotes } : {}) });
    } else {
      const name = str(c?.name, 100);
      if (name.length < 2) return { error: "Indique o nome de cada criança." };
      const birthDate = validIsoDate(c?.birthDate) ? c.birthDate : undefined;
      guestChildren.push({ name, ...(birthDate ? { birthDate } : {}), ...(healthNotes ? { healthNotes } : {}) });
    }
  }
  if (member && new Set(memberChildren.map(c => c.childId)).size !== memberChildren.length) return { error: "A mesma criança foi escolhida duas vezes." };

  const payment: Payment = member && raw?.payment === "monthly" ? "monthly" : "now";
  const pickupNotes = str(raw?.pickupNotes, 500) || undefined;
  return {
    input: {
      eventId, days, guardian, guestChildren, memberChildren,
      ...(pickupNotes ? { pickupNotes } : {}),
      photoConsent: raw?.photoConsent === true,
      payment,
    },
  };
}

// ── Event state ───────────────────────────────────────────────────────────────

/** Why signups for these days are refused right now, or null when they're open. */
export function signupRefusal(ev: EventDoc | undefined, chosen: string[], today: string, isAdmin: boolean): string | null {
  if (!ev) return "Evento não encontrado.";
  // An admin adds walk-ins on a closed or unpublished event, but never on a past day.
  if (!isAdmin) {
    if (!ev.published) return "Evento não encontrado.";
    if (!ev.registrationOpen) return "As inscrições para este evento estão fechadas.";
    if (ev.closesOn && ev.closesOn < today) return "As inscrições para este evento já fecharam.";
  }
  for (const date of chosen) {
    const day = ev.days.find(d => d.date === date);
    if (!day) return `O dia ${shortDate(date)} não faz parte deste evento.`;
    if (date < today) return `O dia ${shortDate(date)} já passou.`;
  }
  return null;
}

/** The event's days with `n` more seats taken on each chosen day, or the days that are full. */
export function takeSeats(days: EventDay[], chosen: string[], n: number): { days: EventDay[] } | { full: string[] } {
  const full = days.filter(d => chosen.includes(d.date) && seatsLeft(d) < n).map(d => d.date);
  if (full.length) return { full };
  return { days: days.map(d => chosen.includes(d.date) ? { ...d, taken: (d.taken ?? 0) + n } : d) };
}

export function releaseSeats(days: EventDay[], chosen: string[], n: number): EventDay[] {
  return days.map(d => chosen.includes(d.date) ? { ...d, taken: Math.max(0, (d.taken ?? 0) - n) } : d);
}

/**
 * Applies an admin's edit of the event's days while keeping the server's seat
 * counts. A day with seats taken can't be removed, and its date can't change
 * (it's matched by date). Returns an error message or the days to store.
 */
export function mergeDayEdits(current: EventDay[], edited: any[]): { error: string } | { days: EventDay[] } {
  const out: EventDay[] = [];
  const seen = new Set<string>();
  for (const e of edited ?? []) {
    const date = e?.date;
    if (!validIsoDate(date)) return { error: "Data inválida num dos dias." };
    if (seen.has(date)) return { error: `O dia ${shortDate(date)} aparece duas vezes.` };
    seen.add(date);
    const capacity = Math.floor(Number(e?.capacity));
    const price = Math.round(Number(e?.price) * 100) / 100;
    const memberPriceRaw = e?.memberPrice;
    const memberPrice = memberPriceRaw === undefined || memberPriceRaw === null || memberPriceRaw === "" ? undefined : Math.round(Number(memberPriceRaw) * 100) / 100;
    if (!Number.isFinite(capacity) || capacity < 0 || capacity > 500) return { error: `Capacidade inválida em ${shortDate(date)}.` };
    if (!Number.isFinite(price) || price < 0 || price > 1000) return { error: `Preço inválido em ${shortDate(date)}.` };
    if (memberPrice !== undefined && (!Number.isFinite(memberPrice) || memberPrice < 0 || memberPrice > 1000)) return { error: `Preço de cliente inválido em ${shortDate(date)}.` };
    const time = (v: unknown) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : undefined);
    const startTime = time(e?.startTime);
    const endTime = time(e?.endTime);
    out.push({
      date, capacity, price,
      ...(memberPrice !== undefined ? { memberPrice } : {}),
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endTime } : {}),
      taken: current.find(d => d.date === date)?.taken ?? 0,
    });
  }
  const dropped = current.filter(d => !seen.has(d.date) && (d.taken ?? 0) > 0);
  if (dropped.length) return { error: `Não é possível remover ${dropped.map(d => shortDate(d.date)).join(", ")}: já tem inscrições. Cancele-as primeiro.` };
  if (!out.length) return { error: "O evento precisa de pelo menos um dia." };
  return { days: out.sort((a, b) => a.date.localeCompare(b.date)) };
}

// ── Monthly bill ──────────────────────────────────────────────────────────────

/** yyyy-mm, from the month of the first chosen day, then the 11 months after it. */
export function periodCandidates(firstDay: string): string[] {
  const y = Number(firstDay.slice(0, 4));
  const m = Number(firstDay.slice(5, 7)) - 1;
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(y, m + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/**
 * The monthly bill a registration goes on: the event's month, or the first
 * month after it whose bill can still change. A bill can change while it's
 * `pending`, or cancelled by the billing sync itself (isRecomputable in
 * billing.ts); a month with no bill yet gets one. A paid, invoiced, failed or
 * in-progress (`processing`) bill is left alone. Null if none of the 12 can.
 */
export function pickBillingPeriod(candidates: string[], bills: Map<string, { status?: string; autoCancelled?: boolean } | undefined>): string | null {
  for (const p of candidates) {
    const b = bills.get(p);
    if (!b) return p;
    if (b.status === "pending" || (b.status === "cancelled" && b.autoCancelled === true)) return p;
  }
  return null;
}

// ── Line items ────────────────────────────────────────────────────────────────

export interface RegistrationChild { name: string; birthDate?: string; childId?: string; healthNotes?: string }

/** One line per child, frozen at signup: "Halloween — Maria Silva (31/10, 01/11)". */
export function registrationLines(eventName: string, days: Pick<EventDay, "date" | "price" | "memberPrice">[], chosen: string[], children: RegistrationChild[], tier: Tier): { title: string; amount: number }[] {
  const perChild = eventTotal(days, chosen, 1, tier);
  const dates = chosen.map(shortDate).join(", ");
  return children.map(c => ({ title: `${eventName} — ${c.name} (${dates})`, amount: perChild }));
}

/** subscriptionId of a registration's line on a bill (BillingLineItem.subscriptionId). */
export const eventLineId = (registrationId: string, childIndex: number) => `event:${registrationId}:${childIndex}`;
export const isEventLineOf = (subscriptionId: unknown, registrationId: string) =>
  typeof subscriptionId === "string" && subscriptionId.startsWith(`event:${registrationId}:`);

// ── Guest access token ────────────────────────────────────────────────────────

/** The secret in a registration's link (/eventos/inscricao/{id}?t=...): the only key a guest has. */
export const newAccessToken = () => randomBytes(24).toString("base64url");

export function tokenMatches(stored: unknown, given: unknown): boolean {
  if (typeof stored !== "string" || typeof given !== "string" || !stored || stored.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(given));
}

// ── Emails ────────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}

const PT_WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
/** "sexta-feira, 31/10 · 09:00–17:30" */
export function dayLine(day: Pick<EventDay, "date" | "startTime" | "endTime">): string {
  const wd = PT_WEEKDAYS[new Date(`${day.date}T12:00:00Z`).getUTCDay()];
  const time = day.startTime ? ` · ${day.startTime}${day.endTime ? `–${day.endTime}` : ""}` : "";
  return `${wd}, ${shortDate(day.date)}${time}`;
}

export function buildConfirmationEmail(opts: {
  companyName: string;
  guardianName: string;
  eventName: string;
  location?: string;
  days: Pick<EventDay, "date" | "startTime" | "endTime">[];
  childNames: string[];
  total: number;
  paidNote: string;   // "Pago por MB WAY." / "Incluído na mensalidade de Novembro 2026."
  link: string;
}): string {
  const e = escapeHtml;
  const daysHtml = opts.days.map(d => `<li style="font-size:14px;color:#374151;">${e(dayLine(d))}</li>`).join("");
  const kidsHtml = opts.childNames.map(n => `<li style="font-size:14px;color:#374151;">${e(n)}</li>`).join("");
  return `<!DOCTYPE html><html lang="pt"><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:24px;">${e(opts.companyName)}</h1>
  <p style="margin:8px 0 0;color:#c4b5fd;font-size:14px;">Inscrição confirmada — ${e(opts.eventName)}</p>
</td></tr>
<tr><td style="padding:32px 40px;">
  <p style="font-size:16px;color:#374151;">Olá${opts.guardianName ? `, <strong>${e(opts.guardianName)}</strong>` : ""},</p>
  <p style="font-size:14px;color:#6b7280;">A inscrição em <strong>${e(opts.eventName)}</strong> está confirmada.</p>
  <p style="margin:20px 0 4px;font-size:13px;color:#6b7280;">Dias</p>
  <ul style="margin:0;padding-left:18px;">${daysHtml}</ul>
  ${opts.location ? `<p style="margin:16px 0 0;font-size:14px;color:#374151;">📍 ${e(opts.location)}</p>` : ""}
  <p style="margin:20px 0 4px;font-size:13px;color:#6b7280;">Crianças</p>
  <ul style="margin:0;padding-left:18px;">${kidsHtml}</ul>
  <p style="margin:20px 0 0;font-size:14px;color:#374151;">Total: <strong>€${opts.total.toFixed(2)}</strong> (IVA incluído). ${e(opts.paidNote)}</p>
  <p style="text-align:center;margin:28px 0 0;">
    <a href="${e(opts.link)}" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Ver inscrição</a>
  </p>
</td></tr>
<tr><td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
  <p style="margin:0;font-size:12px;color:#9ca3af;">${e(opts.companyName)} · NIF 518942120 · Avenida da Guarda Inglesa, Lote E, Coimbra</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}
