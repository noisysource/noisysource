import { onMessagePublished } from "firebase-functions/v2/pubsub";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { google } from "googleapis";

if (!admin.apps.length) admin.initializeApp();

// Deliberately narrow: only the discretionary metered APIs that caused the
// ~€500 Routes API incident, never core services (Firestore, Hosting, Auth,
// Functions) — the site must stay up even if this fires.
const MANAGED_PROJECTS = ["kidclub-dev", "rainbow-prod-2454b"];
const DISCRETIONARY_SERVICES = ["places.googleapis.com", "routes.googleapis.com"];

interface BillingBudgetNotification {
  budgetDisplayName?: string;
  costAmount?: number;
  budgetAmount?: number;
  currencyCode?: string;
  alertThresholdExceeded?: number;
}

async function disableDiscretionaryServices(): Promise<string[]> {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const authClient = await auth.getClient();
  const serviceusage = google.serviceusage({ version: "v1", auth: authClient as any });

  const disabled: string[] = [];
  for (const project of MANAGED_PROJECTS) {
    for (const service of DISCRETIONARY_SERVICES) {
      try {
        await serviceusage.services.disable({ name: `projects/${project}/services/${service}` });
        disabled.push(`${project}/${service}`);
      } catch (err: any) {
        // Already disabled (common — Routes is normally off), or a transient
        // error. Log and keep going so one failure doesn't block the rest.
        logger.warn(`[billingCutoff] disable failed for ${project}/${service}: ${err.message ?? err}`);
      }
    }
  }
  return disabled;
}

async function notifyRenato(costAmount: number, budgetAmount: number, currency: string, disabled: string[]) {
  const db = admin.firestore();
  await db.collection("_apps/arcoiris/emailOutbox").add({
    to: "admin@kidclub.pt",
    subject: `[Billing cutoff fired] Spend hit ${currency}${budgetAmount} — Places/Routes disabled`,
    html: `
      <p>The combined dev+prod billing budget crossed ${currency}${budgetAmount} (currently ${currency}${costAmount}).</p>
      <p>Discretionary metered APIs disabled just now:</p>
      <ul>${disabled.map((d) => `<li>${d}</li>`).join("") || "<li>(none — already disabled)</li>"}</ul>
      <p>Core services (Firestore, Hosting, Auth, Functions) were <strong>not</strong> touched — the site stays up.</p>
      <p>These stay disabled until manually re-enabled in the GCP Console, once spend and root cause are reviewed.</p>
    `,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

export const billingCutoff = onMessagePublished(
  { topic: "billing-budget-cutoff-trigger", region: "europe-west3" },
  async (event) => {
    const data = (event.data.message.json ?? {}) as BillingBudgetNotification;
    const costAmount = data.costAmount ?? 0;
    const budgetAmount = data.budgetAmount ?? 0;
    const currency = data.currencyCode === "EUR" ? "€" : `${data.currencyCode ?? ""} `;

    logger.info("[billingCutoff] budget notification received", { costAmount, budgetAmount });

    // Billing budgets publish on every recalculation, not just threshold
    // crossings — this includes the 60%/€30 informational alert (which
    // Renato already gets natively via the budget's default IAM-recipient
    // email) and routine updates well under budget. Only act at the actual
    // €50 hard line.
    if (budgetAmount <= 0 || costAmount < budgetAmount) return;

    const disabled = await disableDiscretionaryServices();
    await notifyRenato(costAmount, budgetAmount, currency, disabled);
  },
);
