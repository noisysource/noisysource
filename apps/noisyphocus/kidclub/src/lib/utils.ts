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
