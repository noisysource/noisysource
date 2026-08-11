import type { InsuranceDoc } from "@shared/models/Insurance";
import type { NotificationSeverity } from "@shared/models/AppNotification";
import { api } from "./api";

const ENTITY_IDS = ["private", "noisysource", "noisyphocus"] as const;

function daysUntil(dateStr: string): number {
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((d.getTime() - now.getTime()) / 86400000);
}

function renewalSeverity(days: number): NotificationSeverity | null {
  if (days < 0) return null;
  if (days <= 14) return "urgent";
  if (days <= 60) return "warning";
  if (days <= 90) return "info";
  return null;
}

export async function runInsuranceRenewalNotifications(): Promise<void> {
  const savedEntity = api.entityId;
  try {
    for (const entityId of ENTITY_IDS) {
      api.setEntity(entityId);
      let insurances: InsuranceDoc[];
      try {
        insurances = await api.insurances.list() as InsuranceDoc[];
      } catch {
        continue;
      }

      for (const ins of insurances) {
        if (!ins.active || !ins.renewalDate) continue;
        const days = daysUntil(ins.renewalDate);
        const severity = renewalSeverity(days);
        if (!severity) continue;

        const daysText = days === 0 ? "hoje" : `em ${days} dia${days !== 1 ? "s" : ""}`;
        await api.notifications.upsert(`ins_renewal_${ins.id}`, {
          type: "insurance_renewal",
          severity,
          title: `Renovação: ${ins.name}`,
          body: `${ins.insurer} — renova ${daysText} (${ins.renewalDate})`,
          entityId,
          referenceId: ins.id,
          referenceType: "insurance",
          linkTo: `/${entityId}/insurances`,
          dueDate: ins.renewalDate,
        });
      }
    }
  } finally {
    api.setEntity(savedEntity);
  }
}
