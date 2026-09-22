import { Child, Family } from '@shared/models';

/**
 * Personal data about a child and their guardian — the fields that describe a
 * *person*, not a subscription.
 *
 * These live canonically on `children/{childId}` and
 * `families/{familyId}.primaryContact`. Subscription documents
 * (`transportationSubscriptions`, `studyroom`) also carry denormalized copies
 * (childName, contactEmail, schoolName, schoolYear, contactMobile/contactPhone),
 * and those copies have drifted in prod: for 5 of 10 children with both a
 * transport and a study subscription, the two documents disagreed on
 * schoolName, and two of the disagreeing values were street addresses rather
 * than schools.
 *
 * So: pages resolve personal data through here, from the canonical documents.
 * A subscription's own copies are only a fallback, for the one case where
 * there is nothing canonical to read — an admin-created subscription that no
 * parent has claimed yet, so it has no linked child or family.
 *
 * The copies on the subscription are NOT dead, and are deliberately still
 * written (see SubscriptionsAdminPage's EditForm): `functions/src/kidclub`
 * still reads `sub.childName` (billing line-item titles, notification emails)
 * and `sub.schoolName` (discountRecalc's auto_school rule, which drives the
 * 20% Colégio Bissaya Barreto transport discount). They are now written as a
 * mirror of the canonical value rather than edited independently per
 * subscription, which is what makes them stop drifting.
 */
export interface PersonalData {
  childName: string;
  schoolName?: string;
  schoolYear?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

/** The legacy per-subscription copies, whichever of the two shapes a doc uses. */
export interface SubscriptionPersonalFallback {
  childName?: string;
  schoolName?: string;
  schoolYear?: string;
  contactName?: string;
  contactEmail?: string;
  /** transport spells it contactMobile, study spells it contactPhone */
  contactMobile?: string;
  contactPhone?: string;
  email?: string;
  phone?: string;
}

const trim = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length ? s : undefined;
};

/**
 * Resolve the personal data to display for a subscription.
 *
 * Precedence is canonical-first and per-field: the child document, then the
 * family's primary contact (for guardian contact details, and only those),
 * then the subscription's own legacy copy. Per-field rather than
 * whole-object so a child record that is merely incomplete — no schoolYear,
 * say — still wins on the fields it does have, instead of the whole record
 * falling back to a subscription copy that may be the stale one.
 */
export function resolvePersonalData(
  child: Child | null | undefined,
  family: Family | null | undefined,
  fallback: SubscriptionPersonalFallback | null | undefined,
): PersonalData {
  const f = fallback ?? {};
  const childName =
    (child ? trim(`${child.firstName ?? ''} ${child.lastName ?? ''}`) : undefined) ??
    trim(f.childName) ??
    '';

  return {
    childName,
    schoolName: trim(child?.schoolName) ?? trim(f.schoolName),
    schoolYear: trim(child?.schoolYear) ?? trim(f.schoolYear),
    contactName: trim(family?.primaryContact?.name) ?? trim(f.contactName),
    // A child may carry its own contact details "if different from family"
    // (see the Child model), so those win over the family's primary contact.
    contactEmail:
      trim(child?.contactEmail) ??
      trim(family?.primaryContact?.email) ??
      trim(f.contactEmail) ??
      trim(f.email),
    contactPhone:
      trim(child?.contactPhone) ??
      trim(family?.primaryContact?.phone) ??
      trim(f.contactMobile) ??
      trim(f.contactPhone) ??
      trim(f.phone),
  };
}
