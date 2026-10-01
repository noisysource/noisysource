import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { google } from "googleapis";
import { assertExternalCallsAllowed } from "./externalGuard";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// Service account that has Workspace domain-wide delegation for Gmail send.
// Set per project in functions/.env.<projectId>. No key: the function's own
// runtime identity asks IAM to sign the delegation JWT as this account, which
// needs roles/iam.serviceAccountTokenCreator on it. The org policy blocks
// service-account keys, and a copied key is what broke email in Aug 2026.
const GMAIL_SENDER_SA = process.env.GMAIL_SENDER_SA;

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";

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

// Keyless domain-wide delegation: IAM signs the JWT (sub = senderEmail) as
// GMAIL_SENDER_SA, then we exchange it for a Gmail access token.
async function buildGmailAuth(senderEmail: string) {
  if (!GMAIL_SENDER_SA) {
    throw new Error("GMAIL_SENDER_SA is not set (functions/.env.<projectId>).");
  }

  const iam = google.iamcredentials({
    version: "v1",
    auth: new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }),
  });
  const now = Math.floor(Date.now() / 1000);
  const { data } = await iam.projects.serviceAccounts.signJwt({
    name: `projects/-/serviceAccounts/${GMAIL_SENDER_SA}`,
    requestBody: {
      payload: JSON.stringify({
        iss: GMAIL_SENDER_SA,
        sub: senderEmail, // Impersonate the sender email from config
        scope: GMAIL_SCOPES.join(" "),
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    },
  });
  if (!data.signedJwt) throw new Error("IAM signJwt returned no signedJwt.");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: data.signedJwt,
    }),
  });
  const token = await res.json() as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !token.access_token) {
    throw new Error(`Gmail token exchange failed: ${token.error ?? res.status}: ${token.error_description ?? ""}`);
  }

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: token.access_token });
  return auth;
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
  { document: "_apps/arcoiris/emailOutbox/{id}", region: "europe-west3" },
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
      const auth = await buildGmailAuth(senderEmail);

      const gmail = google.gmail({ version: "v1", auth });
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