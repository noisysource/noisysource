import * as admin from "firebase-admin";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { appCol } from "./db";

if (!admin.apps.length) admin.initializeApp();

const COMPANY_NAME = "Arco-Íris da Pequenada";
const ADMIN_EMAIL = "admin@kidclub.pt";
const APP_URL = "https://kidclub.pt";

const DAY_PT: Record<string, string> = {
  monday: "2ª feira", tuesday: "3ª feira", wednesday: "4ª feira",
  thursday: "5ª feira", friday: "6ª feira", saturday: "Sábado", sunday: "Domingo",
};

async function queueEmail(to: string, subject: string, html: string): Promise<void> {
  await appCol("emailOutbox").add({
    to,
    subject,
    html,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Email layout ──────────────────────────────────────────────────────────────

function emailWrapper(headerSub: string, body: string): string {
  return `<!DOCTYPE html><html lang="pt"><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;text-align:center;">
  <h1 style="margin:0;color:#fff;font-size:24px;">${COMPANY_NAME}</h1>
  <p style="margin:8px 0 0;color:#c4b5fd;font-size:14px;">${headerSub}</p>
</td></tr>
<tr><td style="padding:32px 40px;">${body}</td></tr>
<tr><td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
  <p style="margin:0;font-size:12px;color:#9ca3af;">${COMPANY_NAME} · NIF 518942120 · Avenida da Guarda Inglesa, Lote E, Coimbra</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

function buildNewStudyRoomAdminEmail(data: FirebaseFirestore.DocumentData): string {
  const days = (data.days ?? [])
    .map((d: any) => `${DAY_PT[d.day] ?? d.day} às ${d.hour}`)
    .join(", ");
  const body = `
    <p style="font-size:16px;color:#374151;">Nova inscrição recebida — <strong>Sala de Estudo</strong></p>
    <table style="width:100%;font-size:14px;color:#374151;margin:16px 0;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#6b7280;width:120px;">Criança</td><td style="padding:6px 0;"><strong>${data.childName ?? "—"}</strong></td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Escola</td><td style="padding:6px 0;">${[data.schoolName, data.schoolYear].filter(Boolean).join(" · ") || "—"}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Dias</td><td style="padding:6px 0;">${days || "—"}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Mensalidade</td><td style="padding:6px 0;"><strong>€${(data.monthlyPrice ?? 0).toFixed(2)}/mês</strong></td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;">${data.email ?? "—"}</td></tr>
    </table>
    <p style="text-align:center;margin-top:24px;">
      <a href="${APP_URL}/admin/subscriptions" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Ver inscrições</a>
    </p>`;
  return emailWrapper("Nova inscrição — Sala de Estudo", body);
}

function buildNewTransportAdminEmail(data: FirebaseFirestore.DocumentData): string {
  const schedule = (data.schedule ?? [])
    .map((s: any) => `${DAY_PT[s.dayOfWeek] ?? s.dayOfWeek} às ${s.pickupTime} — ${s.pickupLocation}`)
    .join("<br/>");
  const body = `
    <p style="font-size:16px;color:#374151;">Nova inscrição recebida — <strong>Transporte</strong></p>
    <table style="width:100%;font-size:14px;color:#374151;margin:16px 0;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#6b7280;width:120px;">Criança</td><td style="padding:6px 0;"><strong>${data.childName ?? "—"}</strong></td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Horário</td><td style="padding:6px 0;">${schedule || "—"}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Mensalidade</td><td style="padding:6px 0;"><strong>€${(data.monthlyFee ?? 0).toFixed(2)}/mês</strong></td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;">${data.contactEmail ?? "—"}</td></tr>
    </table>
    <p style="text-align:center;margin-top:24px;">
      <a href="${APP_URL}/admin/subscriptions" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Ver inscrições</a>
    </p>`;
  return emailWrapper("Nova inscrição — Transporte", body);
}

function buildApprovalEmail(childName: string, serviceType: string, clientUrl: string): string {
  const body = `
    <p style="font-size:16px;color:#374151;">A inscrição de <strong>${childName}</strong> foi aprovada!</p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:24px 0;">
      <p style="margin:0;font-size:14px;color:#166534;">✅ Serviço: <strong>${serviceType}</strong><br/>A inscrição está agora ativa e pode gerir os detalhes na sua área de cliente.</p>
    </div>
    <p style="text-align:center;margin-top:24px;">
      <a href="${clientUrl}" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Ver inscrição</a>
    </p>`;
  return emailWrapper(`Inscrição aprovada — ${serviceType}`, body);
}

function buildRejectionEmail(childName: string, serviceType: string, reason: string): string {
  const reasonBlock = reason
    ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:24px 0;"><p style="margin:0;font-size:14px;color:#991b1b;">Motivo: ${reason}</p></div>`
    : "";
  const body = `
    <p style="font-size:16px;color:#374151;">Não foi possível aprovar a inscrição de <strong>${childName}</strong> em ${serviceType}.</p>
    ${reasonBlock}
    <p style="font-size:14px;color:#6b7280;">Se tiver dúvidas, entre em contacto connosco por email ou telefone.</p>`;
  return emailWrapper(`Inscrição — ${serviceType}`, body);
}

// ── Triggers ──────────────────────────────────────────────────────────────────

export const onStudyroomCreated = onDocumentCreated(
  { document: "_apps/arcoiris/studyroom/{entryId}", region: "europe-west3" },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    await queueEmail(
      ADMIN_EMAIL,
      `Nova inscrição — Sala de Estudo: ${data.childName ?? ""}`,
      buildNewStudyRoomAdminEmail(data),
    );
  },
);

export const onTransportCreated = onDocumentCreated(
  { document: "_apps/arcoiris/transportationSubscriptions/{subId}", region: "europe-west3" },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    await queueEmail(
      ADMIN_EMAIL,
      `Nova inscrição — Transporte: ${data.childName ?? ""}`,
      buildNewTransportAdminEmail(data),
    );
  },
);

export const onStudyroomStatusNotify = onDocumentUpdated(
  { document: "_apps/arcoiris/studyroom/{entryId}", region: "europe-west3" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after || before.status === after.status) return;

    const clientEmail: string | undefined = after.email || after.contactEmail;
    if (!clientEmail) return;
    const subId = event.params.entryId;

    if (before.status === "pending" && ["active", "confirmed"].includes(after.status)) {
      await queueEmail(
        clientEmail,
        `Inscrição aprovada — Sala de Estudo: ${after.childName ?? ""}`,
        buildApprovalEmail(after.childName ?? "", "Sala de Estudo", `${APP_URL}/client/study/${subId}`),
      );
      return;
    }

    if (before.status === "pending" && after.status === "cancelled") {
      await queueEmail(
        clientEmail,
        `Inscrição — Sala de Estudo: ${after.childName ?? ""}`,
        buildRejectionEmail(after.childName ?? "", "Sala de Estudo", after.statusReason ?? ""),
      );
    }
  },
);

export const onTransportStatusNotify = onDocumentUpdated(
  { document: "_apps/arcoiris/transportationSubscriptions/{subId}", region: "europe-west3" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after || before.status === after.status) return;

    const clientEmail: string | undefined = after.contactEmail;
    if (!clientEmail) return;
    const subId = event.params.subId;

    if (before.status === "pending" && after.status === "active") {
      await queueEmail(
        clientEmail,
        `Inscrição aprovada — Transporte: ${after.childName ?? ""}`,
        buildApprovalEmail(after.childName ?? "", "Transporte", `${APP_URL}/client/transport/${subId}`),
      );
      return;
    }

    if (before.status === "pending" && after.status === "cancelled") {
      await queueEmail(
        clientEmail,
        `Inscrição — Transporte: ${after.childName ?? ""}`,
        buildRejectionEmail(after.childName ?? "", "Transporte", after.statusReason ?? ""),
      );
    }
  },
);
