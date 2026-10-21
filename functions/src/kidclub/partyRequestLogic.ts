// Pure logic for party requests made from the public site, without an account
// (requestPartyBooking in partyPublic.ts). No Firestore here, so it's unit
// tested in partyRequestLogic.test.ts.
import { createHash, timingSafeEqual } from "crypto";
import { partyPriceBreakdown } from "./partyDepositLogic";

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Price ─────────────────────────────────────────────────────────────────────
// Mirrors computePartyPrice in packages/shared/models/partyPricing.ts, which the
// booking pages show: functions/ can't import @shared at runtime (see the note
// at the top of billing.ts). partyPricingParity.test.ts checks both agree. The
// server prices a public request itself and never trusts a total sent by the page.

export interface PartyConfigLike {
  partyTypes: { name: string; basePrice: unknown; includedKids: unknown; pricePerExtraChild: unknown }[];
  extras: { name: string; price: unknown; perUnit?: boolean; unitLabel?: string }[];
}

export interface PartySelectionLike {
  partyType: string;
  numKids: number;
  extras?: string[];
  extrasDetail?: Record<string, number>;
}

function extraQty(sel: Pick<PartySelectionLike, "extras" | "extrasDetail">, name: string): number {
  if (!sel.extras?.includes(name)) return 0;
  const q = Number(sel.extrasDetail?.[name]);
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
}

/** Before-IVA subtotal (what Booking.total stores), or null for an unknown party type. */
export function partySubtotal(config: PartyConfigLike, sel: PartySelectionLike): number | null {
  const pt = config.partyTypes.find(p => p.name === sel.partyType);
  if (!pt) return null;
  const basePrice = Number(pt.basePrice) || 0;
  const includedKids = Number(pt.includedKids) || 0;
  const pricePerExtraChild = Number(pt.pricePerExtraChild) || 0;
  const extraKids = Math.max(0, (Number(sel.numKids) || 0) - includedKids);
  const extraKidsAmount = round2(extraKids * pricePerExtraChild);
  // Same order of additions as the shared function, so float rounding matches too.
  const lineAmounts: number[] = [];
  for (const name of sel.extras ?? []) {
    const ex = config.extras.find(e => e.name === name);
    if (!ex) continue;
    lineAmounts.push(round2((Number(ex.price) || 0) * extraQty(sel, name)));
  }
  return round2(basePrice + extraKidsAmount + lineAmounts.reduce((s, a) => s + a, 0));
}

// ── Request validation ────────────────────────────────────────────────────────

export interface PartyRequest {
  parentName: string;
  email: string;
  phone: string;
  /** '' when not given. 9 digits otherwise. */
  nif: string;
  childName: string;
  /** 0 when not given. */
  childAge: number;
  partyType: string;
  date: string;
  time: string;
  numKids: number;
  extras: string[];
  extrasDetail: Record<string, number>;
  notes: string;
  /** Before IVA, computed here from the config. */
  total: number;
}

export type PartyRequestCheck = { ok: true; value: PartyRequest } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_DAYS_AHEAD = 730;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const normalizeEmail = (raw: unknown) => (typeof raw === "string" ? raw.trim().toLowerCase() : "");

/** "YYYY-MM-DD" of `now` in Lisbon, so "today" is the club's today. */
export function lisbonToday(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Europe/Lisbon" });
}

/**
 * Checks a request from the public party form and prices it. Errors are in
 * Portuguese: the page shows them as they are.
 */
export function checkPartyRequest(raw: any, config: PartyConfigLike, now: Date): PartyRequestCheck {
  const fail = (error: string): PartyRequestCheck => ({ ok: false, error });
  const parentName = str(raw?.parentName, 120);
  const email = normalizeEmail(raw?.email).slice(0, 200);
  const phoneDigits = str(raw?.phone, 30).replace(/[^\d+]/g, "");
  const nif = str(raw?.nif, 20).replace(/\s/g, "");
  const childName = str(raw?.childName, 120);
  const childAgeRaw = raw?.childAge;
  const partyType = str(raw?.partyType, 120);
  const date = str(raw?.date, 10);
  const time = str(raw?.time, 5);
  const numKids = Math.floor(Number(raw?.numKids));
  const notes = str(raw?.notes, 1000);

  if (!parentName) return fail("Indique o seu nome.");
  if (!EMAIL_RE.test(email)) return fail("Indique um email válido.");
  if (phoneDigits.replace(/\D/g, "").length < 9) return fail("Indique um telemóvel válido.");
  if (nif && !/^\d{9}$/.test(nif)) return fail("O NIF tem 9 dígitos.");
  if (!childName) return fail("Indique o nome da criança.");
  let childAge = 0;
  if (childAgeRaw !== undefined && childAgeRaw !== null && childAgeRaw !== "") {
    childAge = Math.floor(Number(childAgeRaw));
    if (!Number.isFinite(childAge) || childAge < 1 || childAge > 18) return fail("A idade da criança deve estar entre 1 e 18 anos.");
  }

  if (!config.partyTypes.some(p => p.name === partyType)) return fail("Escolha o tipo de festa.");
  if (!DATE_RE.test(date) || isNaN(new Date(date).getTime())) return fail("Escolha a data da festa.");
  const today = lisbonToday(now);
  if (date < today) return fail("A data da festa já passou.");
  const maxDate = new Date(new Date(today).getTime() + MAX_DAYS_AHEAD * 86400000).toISOString().slice(0, 10);
  if (date > maxDate) return fail("Só aceitamos pedidos até dois anos de antecedência.");
  if (!TIME_RE.test(time)) return fail("Escolha a hora da festa.");
  if (!Number.isFinite(numKids) || numKids < 1 || numKids > 200) return fail("Indique o número de crianças convidadas.");

  // Only extras that exist in the config, with a quantity between 1 and 999.
  const rawExtras: unknown[] = Array.isArray(raw?.extras) ? raw.extras.slice(0, 50) : [];
  const extras: string[] = [];
  const extrasDetail: Record<string, number> = {};
  for (const e of rawExtras) {
    if (typeof e !== "string" || extras.includes(e)) continue;
    if (!config.extras.some(x => x.name === e)) continue;
    const q = Math.floor(Number(raw?.extrasDetail?.[e] ?? 1));
    if (!Number.isFinite(q) || q < 1) continue;
    extras.push(e);
    extrasDetail[e] = Math.min(999, q);
  }

  const total = partySubtotal(config, { partyType, numKids, extras, extrasDetail });
  if (total === null) return fail("Escolha o tipo de festa.");

  return {
    ok: true,
    value: {
      parentName, email, phone: phoneDigits, nif, childName, childAge,
      partyType, date, time, numKids, extras, extrasDetail, notes, total,
    },
  };
}

// ── Limits ────────────────────────────────────────────────────────────────────
// The public form needs no account, so it caps itself: every request queues two
// emails (admin + parent) on the same Gmail account, and its daily cap (300 in
// SendEmailFromOutbox.ts) also carries the billing emails.

/** Requests per email address per 24h. */
export const MAX_REQUESTS_PER_EMAIL_PER_DAY = 3;
/** Public requests from everyone per 24h. Normal volume is a few per week. */
export const MAX_PUBLIC_REQUESTS_PER_DAY = 20;
/** MB WAY requests started from one booking link per hour. */
export const MAX_LINK_PAYMENTS_PER_HOUR = 5;

/** Timestamps (ms) within the last `windowMs` of `now`, kept for the next check. */
export function recentAttempts(attempts: unknown, now: number, windowMs: number): number[] {
  return (Array.isArray(attempts) ? attempts : [])
    .map(Number)
    .filter(t => Number.isFinite(t) && t > now - windowMs && t <= now);
}

// ── Booking link ─────────────────────────────────────────────────────────────
// Every party email links to /festas/reserva/<bookingId>?t=<token>, where the
// parent sees the request and pays the deposit without an account. The token
// lives in partyLinks/{bookingId}, which no client can read (firestore.rules).

export function partyLinkUrl(appUrl: string, bookingId: string, token: string): string {
  return `${appUrl}/festas/reserva/${encodeURIComponent(bookingId)}?t=${encodeURIComponent(token)}`;
}

/** Constant-time comparison of a token from a link with the stored one. */
export function tokenMatches(given: unknown, stored: unknown): boolean {
  if (typeof given !== "string" || typeof stored !== "string" || !given || !stored) return false;
  // Hash both so the comparison is constant-time even when the lengths differ.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(stored).digest();
  return timingSafeEqual(a, b);
}

// ── What the public booking page gets ────────────────────────────────────────

const PAID = new Set(["paid", "invoiced"]);

/**
 * The booking as the public page shows it. Only what the parent typed or needs
 * to pay: no ids of other docs, no admin notes, no email.
 */
export function publicBookingView(
  b: FirebaseFirestore.DocumentData,
  deposit: { total: number; status: string } | null,
) {
  const price = partyPriceBreakdown(b.total);
  const extras: string[] = Array.isArray(b.extras) ? b.extras : [];
  return {
    status: (["pending", "confirmed", "rejected"].includes(b.status) ? b.status : "pending") as "pending" | "confirmed" | "rejected",
    statusReason: b.status === "rejected" ? String(b.statusReason ?? "") : "",
    parentName: String(b.parentName ?? ""),
    childName: String(b.childName ?? ""),
    partyType: String(b.partyType ?? ""),
    date: String(b.date ?? ""),
    time: String(b.time ?? ""),
    numKids: Number(b.numKids ?? 0),
    extras: extras.map(name => ({ name, qty: Number(b.extrasDetail?.[name] ?? 1) })),
    subtotal: price.subtotal,
    vat: price.vat,
    total: price.total,
    /** The bill's amount once it exists; until then what it will be. */
    depositAmount: deposit ? deposit.total : price.deposit,
    /** none: no bill yet · pending/failed: payable · processing: waiting for MB WAY · paid. */
    depositStatus: !deposit ? "none" : PAID.has(deposit.status) ? "paid" : deposit.status,
    phone: String(b.phone ?? ""),
  };
}
