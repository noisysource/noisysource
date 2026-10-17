import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { appCol } from "./db";
import { ADMIN_EMAIL } from "./notifications";
import { buildDigest, parentFacing, ClientErrorReport } from "./clientErrorsDigestLogic";

const ADMIN_URL = "https://kidclub.pt/admin/client-errors";
const READ_LIMIT = 500; // one bounded read per day, whatever the volume

// Daily email to the admin listing parent actions that failed in the last 24h
// (written by the app's src/lib/clientErrors.ts). Sends nothing on a quiet day.
export const clientErrorsDigest = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Europe/Lisbon", region: "europe-west3" },
  async () => {
    const since = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    const snap = await appCol("clientErrors")
      .where("createdAt", ">=", since)
      .orderBy("createdAt", "desc")
      .limit(READ_LIMIT)
      .get();

    const reports: ClientErrorReport[] = snap.docs.map(d => {
      const x = d.data();
      return { ...x, createdAt: x.createdAt?.toDate?.() } as ClientErrorReport;
    });
    const digest = buildDigest(parentFacing(reports), ADMIN_URL);
    console.log(`[clientErrorsDigest] ${snap.size} report(s) in 24h, ${digest ? "emailing" : "nothing to send"}`);
    if (!digest) return;

    await appCol("emailOutbox").add({
      to: ADMIN_EMAIL,
      subject: digest.subject,
      html: digest.html,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  },
);
