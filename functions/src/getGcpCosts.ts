import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { google } from "googleapis";

const BQ_PROJECT = "rainbow-prod-2454b";
const BQ_DATASET = "billing_export";
const BQ_TABLE = "gcp_billing_export_v1_012710_30B4D5_DCC57E";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface GcpProjectCost {
  projectId: string;
  projectName: string;
  costEur: number;
}

export interface GcpCostData {
  totalCostEur: number;
  byProject: GcpProjectCost[];
  period: string;      // "2026-08"
  fetchedAt: number;   // epoch ms
  configured: boolean; // false = BigQuery export not yet set up
}

export const getGcpCosts = onCall(
  { region: "europe-west3" },
  async (): Promise<GcpCostData> => {
    const db = admin.firestore();
    const cacheRef = db.collection("_meta").doc("gcpCosts");

    // Try cache — swallow Firestore errors so IAM issues don't break the function
    try {
      const cached = await cacheRef.get();
      if (cached.exists) {
        const data = cached.data() as GcpCostData;
        if (Date.now() - data.fetchedAt < CACHE_TTL_MS) return data;
      }
    } catch {
      // Cache unavailable — proceed without it
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const monthStart = `${year}-${month}-01`;
    const period = `${year}-${month}`;

    try {
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/bigquery.readonly"],
      });
      const authClient = await auth.getClient() as any;
      const bq = google.bigquery({ version: "v2", auth: authClient });

      const query = `
        SELECT
          COALESCE(project.id, CONCAT('svc:', service.id), 'account') AS project_id,
          COALESCE(MAX(project.name), project.id, MAX(service.description), MAX(service.id), 'account') AS project_name,
          ROUND(SUM(cost + IFNULL(
            (SELECT SUM(c.amount) FROM UNNEST(credits) c), 0
          )), 4) AS net_cost
        FROM \`${BQ_PROJECT}.${BQ_DATASET}.${BQ_TABLE}\`
        WHERE DATE(usage_start_time) >= '${monthStart}'
          AND currency = 'EUR'
        GROUP BY project_id
        ORDER BY net_cost DESC
      `;

      const res = await bq.jobs.query({
        projectId: BQ_PROJECT,
        requestBody: { query, useLegacySql: false, timeoutMs: 30000 },
      });

      const rows = res.data.rows ?? [];
      const byProject: GcpProjectCost[] = rows.map((row: any) => ({
        projectId: row.f[0].v ?? "unknown",
        projectName: row.f[1].v ?? "unknown",
        costEur: parseFloat(row.f[2].v ?? "0"),
      }));

      const totalCostEur = byProject.reduce((s, p) => s + p.costEur, 0);
      const data: GcpCostData = { totalCostEur, byProject, period, fetchedAt: Date.now(), configured: true };
      try { await cacheRef.set(data); } catch { /* cache write failure is non-fatal */ }
      return data;

    } catch (err: any) {
      const msg: string = err.message ?? "";
      const code = err.code ?? err.status ?? 0;
      // Not found = export not configured; permission denied = SA not yet granted BigQuery access
      if (code === 404 || code === 403 || msg.includes("Not found") || msg.includes("notFound") || msg.includes("accessDenied") || msg.includes("Permission denied")) {
        return { totalCostEur: 0, byProject: [], period, fetchedAt: Date.now(), configured: false };
      }
      console.error("getGcpCosts error:", err);
      throw new HttpsError("internal", `Failed to fetch GCP costs: ${msg}`);
    }
  },
);
