import * as admin from "firebase-admin";
import { appCol } from "./db";
import { dayKey } from "./invoicePdfLogic";
import { DAILY_VENDUS_CLIENT_CREATE_CAP } from "./vendusClientLogic";

// Daily counter: _apps/arcoiris/rateLimits/vendusClientCreate_{YYYY-MM-DD} = { count, updatedAt }.
// Same collection and pattern as invoicePdf.ts. No client rule matches
// `rateLimits`, so it is server-only (deny by default; the Admin SDK bypasses rules).
const counterDoc = (day: string) => appCol("rateLimits").doc(`vendusClientCreate_${day}`);

/**
 * Reserve one Vendus client creation against today's cap (UTC day). Throws once
 * the cap is hit, and also if the counter transaction itself fails, so the
 * caller never reaches Vendus (fail closed). Every attempt counts, including
 * ones Vendus then rejects (e.g. a duplicate NIF).
 */
export async function reserveVendusClientCreation(label: string): Promise<void> {
  const day = dayKey(new Date());
  const ref = counterDoc(day);
  const count = await admin.firestore().runTransaction(async (tx) => {
    const current = ((await tx.get(ref)).data()?.count as number | undefined) ?? 0;
    if (current >= DAILY_VENDUS_CLIENT_CREATE_CAP) return null;
    tx.set(ref, { count: current + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return current + 1;
  });

  if (count === null) {
    const msg =
      `[Vendus] daily client-creation cap reached (${DAILY_VENDUS_CLIENT_CREATE_CAP}/day, ${day} UTC) - ` +
      `refusing to create a Vendus client for ${label}. Likely a loop: check syncVendusClient logs. ` +
      `Counter: _apps/arcoiris/rateLimits/vendusClientCreate_${day}.`;
    console.error(msg);
    throw new Error(msg);
  }
  console.log(`[Vendus] client creation ${count}/${DAILY_VENDUS_CLIENT_CREATE_CAP} today (${label})`);
}
