import * as admin from "firebase-admin";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { createOrUpdateClient } from "./vendus";
import { vendusClientFieldsChanged } from "./vendusClientLogic";
import { appCol } from "./db";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/**
 * Syncs a family to Vendus as a client whenever their profile is saved.
 * Fires on create and update of /families/{familyId}.
 * Only runs when profileComplete is true and contact data is present, and
 * only when a synced field (profileComplete, nif, primaryContact
 * name/email/phone) changed — see vendusClientFieldsChanged.
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
    const clientNif: string = data.nif || "";

    if (!clientName && !clientEmail) return;

    // dev and prod currently share the exact same live Vendus account — no
    // sandbox exists yet. Creating "clients" there from every test family
    // write pollutes the real account's contact list with test data. Skip
    // until dev has its own sandbox VENDUS_API_KEY/VENDUS_REGISTER_ID.
    const currentProject = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
    if (currentProject === "kidclub-dev") {
      console.log(`Skipping Vendus client sync for family ${familyId} — no Vendus sandbox on ${currentProject}`);
      return;
    }

    try {
      const vendusClientId = await createOrUpdateClient(familyId, {
        name: clientName,
        email: clientEmail || undefined,
        ...(clientNif ? { fiscal_id: clientNif } : {}),
        ...(clientPhone ? { phone: clientPhone } : {}),
      });

      // Store back on the family doc (only if changed)
      if (data.vendusClientId !== vendusClientId) {
        await appCol("families").doc(familyId).update({ vendusClientId });
        console.log(`Synced family ${familyId} → Vendus client ${vendusClientId}`);
      }
    } catch (err) {
      // Non-fatal — invoice generation will retry client creation
      console.error(`Failed to sync family ${familyId} to Vendus:`, err);
    }
  }
);
