import * as admin from "firebase-admin";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { createOrUpdateClient } from "./vendus";
import { appCol } from "./db";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/**
 * Syncs a family to Vendus as a client whenever their profile is saved.
 * Fires on create and update of /families/{familyId}.
 * Only runs when profileComplete is true and contact data is present.
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

    // Only sync complete profiles
    if (!data.profileComplete) return;

    const contact = data.primaryContact ?? {};
    const clientName: string = contact.name || "";
    const clientEmail: string = contact.email || "";
    const clientPhone: string = contact.phone || "";
    const clientNif: string = data.nif || "";

    if (!clientName && !clientEmail) return;

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
