/**
 * Normalize a person's name for fuzzy matching: lowercase, strip accents, collapse whitespace.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Subscription status model: pending (awaiting a decision) / active (live) /
 * cancelled. Collapsed from a larger set (planned, offered, confirmed) that
 * used status as a hidden workflow-gate axis — see CLAUDE.md history. Legacy
 * Firestore docs may still literally hold those old string values until
 * touched; normalize on every read so all UI surfaces agree on what they mean:
 *   - confirmed, offered -> active (admin had already decided yes; the old
 *     "parent must still confirm" step is now handled by clientReviewPending,
 *     not a status gate)
 *   - planned -> pending (was staff-internal "in progress, not yet decided")
 *   - cancelled, canceled, archived, inactive -> cancelled
 *   - anything else (including pending, suspended) -> pending
 */
export type SubStatus = 'pending' | 'active' | 'cancelled';

/**
 * Canonical form of an email used as a lookup key.
 *
 * A parent's account is linked to their subscriptions purely by email —
 * there is no other join — and Firestore's `==` is case-sensitive, so a
 * single capital letter anywhere in the address silently hides every
 * subscription from the client while the admin list still shows it. That
 * is not hypothetical: one subscription stored "Teresasplazevedo@..."
 * against an account of "teresasplazevedo@...", and the parent saw nothing.
 *
 * Apply this on BOTH sides — every write that persists an address, and
 * every query that matches one — because normalising only the query still
 * misses rows already stored with capitals.
 */
export function normalizeEmail(raw: string | undefined | null): string {
  return (raw ?? '').trim().toLowerCase();
}

export function normalizeSubStatus(raw: string | undefined | null): SubStatus {
  if (raw === 'active' || raw === 'confirmed' || raw === 'offered') return 'active';
  if (raw === 'cancelled' || raw === 'canceled' || raw === 'archived' || raw === 'inactive') return 'cancelled';
  return 'pending';
}

/**
 * Calculate age from date of birth
 */
export function calculateAge(dateOfBirth: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = today.getMonth() - dateOfBirth.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dateOfBirth.getDate())) {
    age--;
  }
  
  return age;
}

/**
 * A subscription's startDate/endDate as a LOCAL calendar day.
 *
 * The two collections disagree on how these are stored — transport keeps a
 * "YYYY-MM-DD" string, study keeps a Firestore Timestamp — and `new Date(str)`
 * parses a date-only string as **UTC midnight**. Portugal is UTC+1 for most of
 * the school year, so "2026-10-15" became 01:00 local, and comparing it against
 * a local midnight from date-fns made the subscription's own first day look
 * like it was before the start. The start day silently vanished from the
 * parent's trip list.
 *
 * This is the same bug class as `toIsoDate()` in BillingAdminPage (fixed in
 * eb905ed) and as the eventModifications timestamps in the Phase 2 migration.
 * The backend already solved it once in `coerceDate(raw, "start" | "end")` in
 * functions/src/kidclub/reservationEvents.ts; this mirrors that contract on the
 * client, including "end" meaning end-of-day so the last served day is
 * inclusive.
 */
export function coerceSubscriptionDate(raw: unknown, kind: 'start' | 'end'): Date | null {
  if (!raw) return null;
  if (typeof (raw as { toDate?: unknown })?.toDate === 'function') {
    const d = (raw as { toDate: () => Date }).toDate();
    return isNaN(d.getTime()) ? null : d;
  }
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'string') {
    // The explicit time is what forces LOCAL parsing instead of UTC.
    const suffix = kind === 'end' ? 'T23:59:59' : 'T00:00:00';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}${suffix}`) : new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'number') {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof (raw as { seconds?: unknown })?.seconds === 'number') {
    const d = new Date((raw as { seconds: number }).seconds * 1000);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}
