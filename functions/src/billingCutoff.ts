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

// Deployed to kidclub-dev only. This is the single cross-project agent
// (comment at the top of infra/gcp/terraform/billing-cutoff.tf) — its
// Pub/Sub trigger topic and the budget that publishes to it are themselves
// only ever created in dev's Terraform state (manage_combined_budget is
// true only in env/kidclub-dev.tfvars). A copy deployed to any other
// project would resolve `topic:` below to a same-named topic THERE, which
// nothing publishes to, and would need its own service account anyway
// since GCP's iam.disableCrossProjectServiceAccountUsage org policy blocks
// a prod deploy from acting as this dev-project SA (hit deploying this via
// CI on 2026-09-21). Rather than stand up a second, permanently-untriggered
// copy just to satisfy that policy, skip exporting it outside dev entirely.
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;

export const billingCutoff = projectId !== "kidclub-dev" ? undefined : onMessagePublished(
  {
    topic: "billing-budget-cutoff-trigger",
    region: "europe-west3",
    // Must be set here, not just in Terraform's service_config: firebase
    // deploy doesn't read the Terraform-managed service account, and will
    // silently fall back to the default compute SA (which lacks
    // serviceusage.serviceUsageAdmin) if this isn't pinned explicitly.
    serviceAccount: "billing-cutoff-agent@kidclub-dev.iam.gserviceaccount.com",
  },
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
