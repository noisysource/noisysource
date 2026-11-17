/**
 * Camp sign-up rules, free of Firestore so they can be tested.
 *
 * A seat is reserved by paying the deposit. Until then a sign-up ("pending")
 * holds its seats for HOLD_DAYS; unpaid past that, it goes to the waiting list
 * and the seats are free again. A sign-up for a day that is already full goes
 * straight to the waiting list.
 */

export const HOLD_DAYS = 7;
/** Days after sign-up on which an unpaid sign-up gets a reminder. */
export const REMINDER_DAYS = [3, 5] as const;
export const DEPOSIT_RATE = 0.25;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CampSubStatus = "pending" | "confirmed" | "waitlisted" | "cancelled";

export interface SeatSub {
  status: string;
  selectedDays: string[];
  /** Missing on sign-ups made before holds existed: those never held a seat. */
  holdExpiresAtMs?: number | null;
}

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

/** Splits the days asked for into those with a free seat and those that are full. */
export function splitByAvailability(
  dayIds: string[],
  capacity: Record<string, number>,
  taken: Record<string, number>,
): { available: string[]; full: string[] } {
  const available: string[] = [];
  const full: string[] = [];
  for (const id of dayIds) ((taken[id] ?? 0) < (capacity[id] ?? 0) ? available : full).push(id);
  return { available, full };
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
