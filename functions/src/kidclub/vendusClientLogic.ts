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

/** The NIF of AT's "Consumidor final". Stored on a family it means "no NIF"
 *  (the dev seed family has it); on a Vendus client it means the client has
 *  no NIF of its own. */
export const CONSUMIDOR_FINAL_NIF = "999999990";

/** A NIF with the spaces people type into it stripped; "" when there is none
 *  (missing, blank, or the Consumidor final NIF). */
export function realNif(v: unknown): string {
  const nif = str(v).replace(/\s+/g, "");
  return nif === CONSUMIDOR_FINAL_NIF ? "" : nif;
}

/**
 * The NIF a family's invoices carry, or null when the family has none.
 *
 * Without a NIF the invoice is issued to "Consumidor final", with no Vendus
 * client at all, and the family is never synced to Vendus (Renato, option B,
 * 2026-10-13). Only `nif` decides: the profile pages delete it when the parent
 * ticks "Não pretendo NIF na fatura" (`nifOptOut`), which is UI-only.
 *
 * No checksum here, on purpose: the forms already validate it, and a stored
 * invalid NIF keeps failing at Vendus with a visible error (invoiceError /
 * vendusSyncError), rather than silently turning into Consumidor final.
 */
export function familyInvoiceNif(data: DocData): string | null {
  return realNif(data?.nif) || null;
}

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

/** Longest Vendus error message kept on the family doc. */
export const VENDUS_SYNC_ERROR_MAX_LENGTH = 500;

/**
 * What syncVendusClient writes back on the family doc after calling Vendus,
 * or null when nothing changed (no write, so no extra trigger run).
 *
 * - Success: `vendusClientId` if it differs, and delete `vendusSyncError` if
 *   present (so the admin badge clears).
 * - Failure: `vendusSyncError: { message, at }`, shown as a badge in the admin.
 *
 * Neither field is a synced field (see vendusSyncFields), so this write
 * re-fires the trigger but vendusClientFieldsChanged returns false: no loop.
 * `del` / `now` are the Firestore FieldValue.delete() / serverTimestamp()
 * sentinels, passed in to keep this file free of firebase-admin.
 */
export function vendusSyncWriteback(
  data: DocData,
  outcome: { clientId: number } | { error: unknown },
  sentinels: { del: unknown; now: unknown },
): Record<string, unknown> | null {
  if ("error" in outcome) {
    const e = outcome.error;
    const message = (e instanceof Error ? e.message : String(e)).slice(0, VENDUS_SYNC_ERROR_MAX_LENGTH);
    return { vendusSyncError: { message, at: sentinels.now } };
  }
  const update: Record<string, unknown> = {};
  if (data?.vendusClientId !== outcome.clientId) update.vendusClientId = outcome.clientId;
  if (data?.vendusSyncError !== undefined) update.vendusSyncError = sentinels.del;
  return Object.keys(update).length ? update : null;
}

/**
 * What syncVendusClient writes on a family it skips because it has no NIF:
 * only the deletion of a stale `vendusSyncError` (that family has no Vendus
 * client to get wrong any more, so the badge would be misleading), else
 * nothing. `vendusClientId` is left alone: an old NIF-less client is simply
 * no longer used (see createOrUpdateClient for a NIF added later).
 */
export function vendusSkipWriteback(data: DocData, del: unknown): Record<string, unknown> | null {
  return data?.vendusSyncError !== undefined ? { vendusSyncError: del } : null;
}
