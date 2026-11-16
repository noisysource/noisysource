import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { requireOwnerOrAgent } from "../auth";
import { parseEnergyDay, parseTariff } from "./energyBill";
import { buildEnergyBillReport, parseBillRange } from "./energyBillReport";

/**
 * What the Energia page shows for a range of days: kWh, the three bills, the
 * savings. Read-only, for Atlas (and the owner): it can read `domotics_energy`
 * and the tariff itself, but the bill maths lives here, and this keeps Atlas
 * from growing a second copy of it.
 *
 * No external API: one range query (at most 400 small documents) and one
 * document read per call.
 */
export const domoticsEnergyBill = onCall<{ from: string; to: string }>(async ({ auth, data }) => {
  requireOwnerOrAgent(auth);
  const range = parseBillRange(data);
  if ("error" in range) throw new HttpsError("invalid-argument", range.error);

  const db = admin.firestore();
  const id = admin.firestore.FieldPath.documentId();
  const [energy, tariff] = await Promise.all([
    db.collection("domotics_energy").where(id, ">=", range.from).where(id, "<=", range.to).get(),
    db.doc("domotics_config/tariff").get(),
  ]);
  return buildEnergyBillReport(
    energy.docs.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.id)).map(d => parseEnergyDay(d.id, d.data())),
    parseTariff(tariff.data()),
    range,
    Date.now(),
  );
});
