/**
 * Camp sign-up rules, free of Firestore so they can be tested.
 *
 * - A seat is reserved by paying the deposit; payment always confirms.
 * - Until then a sign-up ("pending") holds its seats for HOLD_DAYS; unpaid past
 *   that, it goes to the waiting list and the seats are free again.
 * - A whole-week sign-up takes precedence over unpaid single-day sign-ups: it
 *   takes their held seat and they go to the waiting list. Only paid seats (and
 *   other weeks' holds) stop it. If a day of the week is taken that way, the
 *   week is booked as single days instead, under the single-day rules.
 * - A single day with no free seat, or with people already waiting for it,
 *   goes to the waiting list. When seats are free, everyone waiting for them
 *   is offered the seat at once and the first to pay gets it.
 */

export const HOLD_DAYS = 7;
/** Days after sign-up on which an unpaid sign-up gets a reminder. */
export const REMINDER_DAYS = [3, 5] as const;
export const DEPOSIT_RATE = 0.25;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CampSubStatus = "pending" | "confirmed" | "waitlisted" | "cancelled";

export interface SeatSub {
  id?: string;
  status: string;
  selectedDays: string[];
  /** Missing on sign-ups made before holds existed: those never held a seat. */
  holdExpiresAtMs?: number | null;
  subscriptionType?: string;
  createdAtMs?: number;
}

/** "week", or the older "full" (whole camp): sign-ups made of whole weeks. */
export const isWeekType = (t: string | undefined): boolean => t === "week" || t === "full";

export const holdExpiry = (fromMs: number): number => fromMs + HOLD_DAYS * DAY_MS;

/** Does this sign-up occupy its seats right now? */
export function holdsSeat(sub: SeatSub, nowMs: number): boolean {
  if (sub.status === "confirmed") return true;
  return sub.status === "pending" && !!sub.holdExpiresAtMs && sub.holdExpiresAtMs > nowMs;
}

/** Seats taken per camp day id. */
export function takenPerDay(subs: SeatSub[], nowMs: number): Record<string, number> {
  const taken: Record<string, number> = {};
  for (const sub of subs) {
    if (!holdsSeat(sub, nowMs)) continue;
    for (const dayId of sub.selectedDays ?? []) taken[dayId] = (taken[dayId] ?? 0) + 1;
  }
  return taken;
}

export function campAmounts(total: number): { totalAmount: number; depositAmount: number; balanceAmount: number } {
  const totalAmount = Math.round(total * 100) / 100;
  const depositAmount = Math.round(totalAmount * DEPOSIT_RATE * 100) / 100;
  return { totalAmount, depositAmount, balanceAmount: Math.round((totalAmount - depositAmount) * 100) / 100 };
}

/**
 * Which reminder, if any, an unpaid sign-up is due today. Only the latest one
 * that's due and not yet sent: a sign-up that missed day 3 gets the day-5
 * reminder alone, not both.
 */
export function reminderDue(createdAtMs: number, nowMs: number, lastReminderDay: number | undefined): number | null {
  const age = Math.floor((nowMs - createdAtMs) / DAY_MS);
  const due = [...REMINDER_DAYS].reverse().find((d) => age >= d);
  if (!due || (lastReminderDay ?? 0) >= due) return null;
  return due;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Day ids this child (same family, same name) is already signed up for. */
export function alreadySignedUpDays(
  existing: { status: string; familyId?: string; childName?: string; selectedDays: string[] }[],
  familyId: string,
  childName: string,
  dayIds: string[],
): string[] {
  const wanted = new Set(dayIds);
  const clash = new Set<string>();
  for (const sub of existing) {
    if (sub.status === "cancelled" || sub.familyId !== familyId || norm(sub.childName ?? "") !== norm(childName)) continue;
    for (const id of sub.selectedDays ?? []) if (wanted.has(id)) clash.add(id);
  }
  return [...clash];
}

/** "2026-12-22" → "22/12/2026" */
export function fmtDatePt(d: string): string {
  const [y, m, day] = String(d).split("-");
  return y && m && day ? `${day}/${m}/${y}` : String(d);
}

/** Monday (YYYY-MM-DD) of the week a date is in. */
export function weekKey(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

export interface PlanDay { date: string; capacity: number; active: boolean }

/** Weeks (by Monday) the selection touches without taking every open day of the camp in them. */
export function incompleteWeeks(days: Record<string, PlanDay>, selected: string[]): string[] {
  const chosen = new Set(selected);
  const touched = new Set(selected.map((id) => weekKey(days[id].date)));
  const incomplete = new Set<string>();
  for (const [id, day] of Object.entries(days)) {
    const wk = weekKey(day.date);
    if (day.active && touched.has(wk) && !chosen.has(id)) incomplete.add(wk);
  }
  return [...incomplete].sort();
}

/** People waiting per day. */
export function waitingPerDay(subs: SeatSub[]): Record<string, number> {
  const waiting: Record<string, number> = {};
  for (const sub of subs) {
    if (sub.status !== "waitlisted") continue;
    for (const id of sub.selectedDays ?? []) waiting[id] = (waiting[id] ?? 0) + 1;
  }
  return waiting;
}

/**
 * Seats a whole-week sign-up can't take: paid ones, other weeks' holds, and
 * single-day holds that can't be moved (`unbumpable`: a payment is in flight).
 */
export function firmPerDay(subs: SeatSub[], nowMs: number, unbumpable: Set<string> = new Set()): Record<string, number> {
  return takenPerDay(
    subs.filter((s) => s.status === "confirmed" || isWeekType(s.subscriptionType) || (!!s.id && unbumpable.has(s.id))),
    nowMs,
  );
}

export interface SignupPlan {
  /** Held as a whole-week sign-up. */
  weekDays: string[];
  /** Held as a single-day sign-up. */
  dayDays: string[];
  /** Waiting list. */
  waitDays: string[];
  /** Unpaid single-day holds a week takes over: that sign-up loses that day. */
  bumps: { subId: string; dayId: string }[];
  /** Weeks (by Monday) asked for as a week but booked as single days. */
  downgradedWeeks: string[];
}

export function planSignup(input: {
  type: string;
  selected: string[];
  days: Record<string, PlanDay>;
  subs: SeatSub[];
  nowMs: number;
  unbumpable?: Set<string>;
}): SignupPlan {
  const { type, selected, days, subs, nowMs } = input;
  const unbumpable = input.unbumpable ?? new Set<string>();
  const taken = takenPerDay(subs, nowMs);
  const firm = firmPerDay(subs, nowMs, unbumpable);
  const waiting = waitingPerDay(subs);
  const plan: SignupPlan = { weekDays: [], dayDays: [], waitDays: [], bumps: [], downgradedWeeks: [] };

  const asSingleDay = (id: string) => {
    const free = (taken[id] ?? 0) < days[id].capacity && !(waiting[id] > 0);
    (free ? plan.dayDays : plan.waitDays).push(id);
  };

  if (!isWeekType(type)) {
    selected.forEach(asSingleDay);
    return plan;
  }

  const byWeek = new Map<string, string[]>();
  for (const id of selected) {
    const wk = weekKey(days[id].date);
    byWeek.set(wk, [...(byWeek.get(wk) ?? []), id]);
  }
  const bumped = new Set<string>(); // `${subId}|${dayId}`
  for (const [wk, ids] of [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (ids.some((id) => (firm[id] ?? 0) >= days[id].capacity)) {
      plan.downgradedWeeks.push(wk);
      ids.forEach(asSingleDay);
      continue;
    }
    for (const id of ids) {
      plan.weekDays.push(id);
      let over = (taken[id] ?? 0) - days[id].capacity + 1;
      if (over <= 0) continue;
      // Newest unpaid single-day holds lose the seat first.
      const holders = subs
        .filter((s) => s.id && !isWeekType(s.subscriptionType) && s.status === "pending" && holdsSeat(s, nowMs)
          && !unbumpable.has(s.id) && s.selectedDays.includes(id) && !bumped.has(`${s.id}|${id}`))
        .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
      for (const h of holders) {
        if (over <= 0) break;
        plan.bumps.push({ subId: h.id!, dayId: id });
        bumped.add(`${h.id}|${id}`);
        over--;
      }
    }
  }
  return plan;
}

/**
 * Waiting-list offers to open and to close. A waiting sign-up is offered its
 * seats (a deposit bill; first to pay gets them) while every one of its days
 * has a free seat, and the offer is withdrawn when one fills up.
 */
export function waitlistOfferChanges(
  subs: (SeatSub & { offerOpen?: boolean })[],
  days: Record<string, PlanDay>,
  nowMs: number,
): { open: string[]; close: string[] } {
  const taken = takenPerDay(subs, nowMs);
  const open: string[] = [];
  const close: string[] = [];
  for (const sub of subs) {
    if (sub.status !== "waitlisted" || !sub.id) continue;
    const allFree = sub.selectedDays.length > 0 && sub.selectedDays.every((id) => days[id]?.active && (taken[id] ?? 0) < days[id].capacity);
    if (allFree && !sub.offerOpen) open.push(sub.id);
    if (!allFree && sub.offerOpen) close.push(sub.id);
  }
  return { open, close };
}
