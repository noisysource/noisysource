// Pure helpers for the Vendus client sync (syncVendusClient.ts, vendus.ts),
// split out so they can be unit-tested without firebase-admin.

/** Hard ceiling on Vendus client creations (POST /clients/) per UTC day,
 *  across every caller. Real use is about one per new family (~41 families in
 *  total today); this only bites if something loops. It exists because one
 *  did: on 2026-10-11 syncVendusClient created 904 duplicate clients in ~7
 *  minutes for one family. */
export const DAILY_VENDUS_CLIENT_CREATE_CAP = 50;

type DocData = Record<string, any> | null | undefined;

/** The family fields syncVendusClient sends to Vendus. */
export interface VendusSyncFields {
  profileComplete: boolean;
  nif: string;
  name: string;
  email: string;
  phone: string;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

export function vendusSyncFields(data: DocData): VendusSyncFields {
  const contact = data?.primaryContact ?? {};
  return {
    profileComplete: !!data?.profileComplete,
    nif: str(data?.nif),
    name: str(contact.name),
    email: str(contact.email),
    phone: str(contact.phone),
  };
}

/**
 * True when a family write changed something the Vendus client sync sends,
 * or when there is no previous version (the doc was just created).
 *
 * A write that only touches other fields, in particular syncVendusClient's own
 * `vendusClientId` write-back, returns false, so the trigger doesn't re-fire
 * itself into a loop.
 */
export function vendusClientFieldsChanged(before: DocData, after: DocData): boolean {
  if (!before) return true;
  const a = vendusSyncFields(before);
  const b = vendusSyncFields(after);
  return (Object.keys(a) as (keyof VendusSyncFields)[]).some((k) => a[k] !== b[k]);
}
