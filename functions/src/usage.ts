import { onCall } from "firebase-functions/v2/https";
import { MetricServiceClient } from "@google-cloud/monitoring";

// Free tier quotas (generous defaults, can be overridden by env vars)
const QUOTAS = {
  FIRESTORE_READS: Number(process.env.QUOTA_FIRESTORE_READS ?? 50_000),
  FIRESTORE_WRITES: Number(process.env.QUOTA_FIRESTORE_WRITES ?? 20_000),
  FUNCTIONS_INVOCATIONS: Number(process.env.QUOTA_FUNCTIONS_INVOCATIONS ?? 2_000_000),
  STORAGE_GB_MONTHS: Number(process.env.QUOTA_STORAGE_GB_MONTHS ?? 5),
  HOSTING_GB_MONTHS: Number(process.env.QUOTA_HOSTING_GB_MONTHS ?? 10),
  AUTH_USERS: Number(process.env.QUOTA_AUTH_USERS ?? 10_000),
};

// Google Cloud Monitoring metric names
const METRIC = {
  FS_READS: "firestore.googleapis.com/document/read_count",
  FS_WRITES: "firestore.googleapis.com/document/write_count",
  FS_DELETES: "firestore.googleapis.com/document/delete_count",
  FN_INVOCATIONS: "cloudfunctions.googleapis.com/function/execution_count",
  STORAGE_BYTES: "storage.googleapis.com/storage/total_bytes",
  HOSTING_BYTES: "firebasehosting.googleapis.com/storage/total_bytes",
  AUTH_NEW_USERS: "identitytoolkit.googleapis.com/user/create_count",
};

const client = new MetricServiceClient();

function monthWindowUTC(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end: now, label: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}` };
}

async function sumMetric(projectId: string, metricType: string, start: Date, end: Date): Promise<number> {
  try {
    const [series] = await client.listTimeSeries({
      name: client.projectPath(projectId),
      filter: `metric.type="${metricType}"`,
      interval: {
        startTime: { seconds: Math.floor(start.getTime() / 1000) },
        endTime: { seconds: Math.floor(end.getTime() / 1000) },
      },
      aggregation: {
        alignmentPeriod: { seconds: (end.getTime() - start.getTime()) / 1000 }, // Sum over the entire window
        perSeriesAligner: "ALIGN_SUM",
        crossSeriesReducer: "REDUCE_SUM",
      },
      view: "FULL",
    });

    let total = 0;
    for (const ts of series ?? []) {
      for (const p of ts.points ?? []) {
        total += Number(p.value?.int64Value ?? p.value?.doubleValue ?? 0);
      }
    }
    return total;
  } catch (error) {
    console.warn(`Could not fetch metric: ${metricType}`, error);
    return 0; // Return 0 if a metric fails, so the whole function doesn't fail
  }
}

export const getUsageSnapshot = onCall<unknown, any>(async () => {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!projectId) throw new Error("Missing project id");
  const { start, end, label } = monthWindowUTC();

  const [reads, writes, deletes, invocations, storageBytes, hostingBytes, newUsers] = await Promise.all([
    sumMetric(projectId, METRIC.FS_READS, start, end),
    sumMetric(projectId, METRIC.FS_WRITES, start, end),
    sumMetric(projectId, METRIC.FS_DELETES, start, end),
    sumMetric(projectId, METRIC.FN_INVOCATIONS, start, end),
    sumMetric(projectId, METRIC.STORAGE_BYTES, start, end),
    sumMetric(projectId, METRIC.HOSTING_BYTES, start, end),
    sumMetric(projectId, METRIC.AUTH_NEW_USERS, start, end),
  ]);

  // Note: Storage and Hosting are measured in Byte-Months. This is a simplification.
  // A more accurate reading would require more complex time-series analysis.
  const storageGb = storageBytes / (1024 * 1024 * 1024);
  const hostingGb = hostingBytes / (1024 * 1024 * 1024);

  return {
    month: label,
    window: { start: start.toISOString(), end: end.toISOString() },
    firestore: {
      reads,
      writes,
      deletes,
      free: { reads: QUOTAS.FIRESTORE_READS, writes: QUOTAS.FIRESTORE_WRITES },
    },
    functions: {
      invocations,
      free: QUOTAS.FUNCTIONS_INVOCATIONS,
    },
    storage: {
      gb: storageGb,
      free: { gb: QUOTAS.STORAGE_GB_MONTHS },
    },
    hosting: {
      gb: hostingGb,
      free: { gb: QUOTAS.HOSTING_GB_MONTHS },
    },
    auth: {
      newUsers,
      free: { users: QUOTAS.AUTH_USERS },
    },
    status: {
      firestoreReadsOk: reads <= QUOTAS.FIRESTORE_READS,
      firestoreWritesOk: writes <= QUOTAS.FIRESTORE_WRITES,
      functionsInvocationsOk: invocations <= QUOTAS.FUNCTIONS_INVOCATIONS,
      storageOk: storageGb <= QUOTAS.STORAGE_GB_MONTHS,
      hostingOk: hostingGb <= QUOTAS.HOSTING_GB_MONTHS,
      authOk: newUsers <= QUOTAS.AUTH_USERS,
    },
  };
});
