import * as admin from "firebase-admin";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { createOrUpdateClient } from "./vendus";
import { familyInvoiceNif, vendusClientFieldsChanged, vendusSkipWriteback, vendusSyncWriteback } from "./vendusClientLogic";
import { appCol } from "./db";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/**
 * Syncs a family to Vendus as a client whenever their profile is saved.
 * Fires on create and update of /families/{familyId}.
 * Only runs when profileComplete is true, contact data is present and the
 * family has a NIF, and only when a synced field (profileComplete, nif,
 * primaryContact name/email/phone) changed — see vendusClientFieldsChanged.
 * Families without a NIF never get a Vendus client: their invoices go to
 * "Consumidor final" (Renato, option B, 2026-10-13).
 * A failure is stored on the family as `vendusSyncError: { message, at }`
 * (admin badge); the next successful sync deletes it.
 */
export const syncVendusClient = onDocumentWritten(
  {
    document: "_apps/arcoiris/families/{familyId}",
    region: "europe-west3",
    secrets: ["VENDUS_API_KEY", "VENDUS_REGISTER_ID"],
  },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return; // deletion — nothing to do

    const data = after.data()!;
    const { familyId } = event.params;

    // Only react to changes in what we send to Vendus. In particular, our own
    // vendusClientId write-back below (and billing.ts's) re-fires this trigger;
    // without this check that was an infinite create-client loop (2026-10-11).
    const before = event.data?.before;
    if (!vendusClientFieldsChanged(before?.exists ? before.data() : undefined, data)) return;

    // Only sync complete profiles
    if (!data.profileComplete) return;

    const contact = data.primaryContact ?? {};
    const clientName: string = contact.name || "";
    const clientEmail: string = contact.email || "";
    const clientPhone: string = contact.phone || "";

    if (!clientName && !clientEmail) return;

    const sentinels = {
      del: admin.firestore.FieldValue.delete(),
      now: admin.firestore.FieldValue.serverTimestamp(),
    };

    // No NIF: no Vendus client, no Vendus call. Only a stale vendusSyncError
    // is cleared (not a synced field, so that write doesn't re-sync).
    const clientNif = familyInvoiceNif(data);
    if (!clientNif) {
      console.log(`Skipping Vendus client sync for family ${familyId} — no NIF, invoiced as Consumidor final`);
      const cleared = vendusSkipWriteback(data, sentinels.del);
      if (cleared) {
        await appCol("families").doc(familyId).update(cleared).catch((err) =>
          console.error(`Failed to clear vendusSyncError on family ${familyId}:`, err));
      }
      return;
    }

    // dev and prod currently share the exact same live Vendus account — no
    // sandbox exists yet. Creating "clients" there from every test family
    // write pollutes the real account's contact list with test data. Skip
    // until dev has its own sandbox VENDUS_API_KEY/VENDUS_REGISTER_ID.
    const currentProject = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
    if (currentProject === "kidclub-dev") {
      console.log(`Skipping Vendus client sync for family ${familyId} — no Vendus sandbox on ${currentProject}`);
      return;
    }

    let outcome: { clientId: number } | { error: unknown };
    try {
      // A family whose Vendus client already holds this NIF only PATCHes it;
      // see createOrUpdateClient for when it re-links or creates instead
      // (e.g. a NIF added to a family linked to a NIF-less client).
      const knownClientId = Number(data.vendusClientId) || null;
      const clientId = await createOrUpdateClient(familyId, {
        name: clientName,
        email: clientEmail || undefined,
        fiscal_id: clientNif,
        ...(clientPhone ? { phone: clientPhone } : {}),
      }, knownClientId);
      outcome = { clientId };
    } catch (err) {
      // Non-fatal, but recorded on the family as vendusSyncError so the admin
      // sees it (badge in Inscrições); otherwise invoices could keep going out
      // to the wrong client, e.g. without a NIF the family added later.
      console.error(`Failed to sync family ${familyId} to Vendus:`, err);
      outcome = { error: err };
    }

    // Write back only what changed. vendusClientId / vendusSyncError aren't
    // synced fields, so this write's own trigger run exits early (no loop).
    const update = vendusSyncWriteback(data, outcome, sentinels);
    if (!update) return;
    try {
      await appCol("families").doc(familyId).update(update);
      if ("vendusClientId" in update) console.log(`Synced family ${familyId} → Vendus client ${update.vendusClientId}`);
    } catch (err) {
      console.error(`Failed to record Vendus sync result on family ${familyId}:`, err);
    }
  }
);
