import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { google } from "googleapis";
import { assertExternalCallsAllowed } from "./externalGuard";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// Secrets injected by Terraform
const SA_CLIENT_EMAIL = process.env.SA_CLIENT_EMAIL;
const SA_PRIVATE_KEY = process.env.SA_PRIVATE_KEY;

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

// Max emails actually sent in any 24h window. ~40 families; a full campaign
// plus the day's automatic notices fits several times over.
const DAILY_SEND_CAP = 300;

// Define a type for the data structure in emailOutbox for better type safety
interface EmailOutboxData {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

function buildAuthFromSecrets(senderEmail: string) {
  if (!SA_CLIENT_EMAIL || !SA_PRIVATE_KEY) {
    throw new Error("SA_CLIENT_EMAIL or SA_PRIVATE_KEY secret is not set.");
  }

  // The private key from Secret Manager might contain literal '\n' characters.
  const privateKey = SA_PRIVATE_KEY.replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email: SA_CLIENT_EMAIL,
    key: privateKey,
    scopes: GMAIL_SCOPES,
    subject: senderEmail, // Impersonate the sender email from config
  });
}

function encodeRFC822({
  from, to, subject, html, text,
}: { from: string; to: string; subject: string; html?: string; text?: string }) {
  const body = html
    ? [
      `From: ${from}`,
      `To: ${to}`,
      // RFC 2047 encoded-word syntax for UTF-8 subjects.
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      html,
    ].join("\r\n")
    : [
      `From: ${from}`,
      `To: ${to}`,
      // Also apply encoding for plain text emails
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      text ?? "",
    ].join("\r\n");
  return Buffer.from(body).toString("base64url");
}

export const sendEmailFromOutbox = onDocumentCreated(
  { document: "_apps/arcoiris/emailOutbox/{id}", region: "europe-west3", secrets: ["SA_CLIENT_EMAIL", "SA_PRIVATE_KEY"] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    // Lease the doc: queued -> processing
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(snap.ref);
      if ((cur.get("status") ?? "queued") !== "queued") throw new Error("already claimed");
      tx.update(snap.ref, {
        status: "processing",
        processingAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    const data = snap.data() as EmailOutboxData | undefined;

    // Validate required fields for the email
    if (
      !data ||
      typeof data.to !== "string" ||
      !data.to ||
      typeof data.subject !== "string" ||
      !data.subject
    ) {
      await snap.ref.update({
        status: "error",
        error: "Document is missing required fields: to, subject.",
      });
      console.error("Document missing required fields:", snap.id);
      return;
    }

    try {
      assertExternalCallsAllowed("Gmail send");

      // Optional kill switch
      const globalsDoc = await db.doc("_apps/arcoiris/settings/globals").get();
      const globals = globalsDoc.data() ?? {};

      if (globals.emailsEnabled === false) {
        await snap.ref.update({ status: "error", error: "Email sending is globally disabled." });
        return;
      }

      // Rolling 24h cap, whatever wrote to the outbox (a runaway loop, a
      // mistaken campaign). Well under Workspace's own ~2000/day. Over the cap
      // the email fails visibly and can be resent from the admin history.
      const since = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
      const sentLastDay = (await db.collection("_apps/arcoiris/emailOutbox")
        .where("sentAt", ">=", since).count().get()).data().count;
      if (sentLastDay >= DAILY_SEND_CAP) {
        await snap.ref.update({ status: "error", error: `Daily cap reached (${DAILY_SEND_CAP} emails in 24h). Resend later.` });
        console.error(`[sendEmailFromOutbox] daily cap reached (${sentLastDay}), not sending ${snap.id}`);
        return;
      }

      const senderEmail = globals.senderEmail as string | undefined;
      if (!senderEmail) {
        throw new Error("`senderEmail` is not configured in _apps/arcoiris/settings/globals document.");
      }

      // Auth
      const jwt = buildAuthFromSecrets(senderEmail);
      await jwt.authorize();

      const gmail = google.gmail({ version: "v1", auth: jwt });
      const raw = encodeRFC822({
        from: senderEmail,
        to: data.to,
        subject: data.subject,
        html: data.html,
        text: data.text,
      });

      await gmail.users.messages.send({ userId: "me", requestBody: { raw } });

      await snap.ref.update({
        status: "sent",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      // Make errors readable in Firestore and log the full error for debugging
      const errorMessage = err instanceof Error ? err.message : String(err);
      await snap.ref.update({
        status: "error",
        error: errorMessage,
      });
      console.error("Failed to send email for document:", snap.id, err);
    }
  }
);