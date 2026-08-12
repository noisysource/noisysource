import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall } from "firebase-functions/v2/https";
import { createInvoice, createOrUpdateClient, VendusLineItem, VendusClient, PRODUCT_STUDY, PRODUCT_TRANSPORT, PAYMENT_METHOD_TRANSFERENCIA } from "./vendus";
import { appCol } from "./db";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const NIB = "PT50 0010 0000 64563890001 83";
const COMPANY_PHONE = "+351 912 517 488";
const COMPANY_NAME = "Arco-Íris da Pequenada";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActiveSub {
  id: string;
  familyId: string;
  userId: string;
  childId: string;
  childName: string;
  monthlyFee?: number;
  monthlyPrice?: number;
  days?: Array<{ day: string }>;
  schedule?: Array<{ dayOfWeek: string }>;
  type: "study" | "transport";
}

interface FamilyGroup {
  familyId: string;
  userId: string;
  study: ActiveSub[];
  transport: ActiveSub[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function periodForDate(date: Date): { label: string; start: Date; end: Date; isoDate: string } {
  const y = date.getFullYear();
  const m = date.getMonth(); // 0-based
  const start = new Date(y, m, 1);
  const end = new Date(y, m + 1, 0); // last day of month
  const months = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];
  return {
    label: `${months[m]} ${y}`,
    start,
    end,
    isoDate: `${y}-${String(m + 1).padStart(2, "0")}-01`,
  };
}

function dayLabel(day: string): string {
  const map: Record<string, string> = {
    monday: "2ª", tuesday: "3ª", wednesday: "4ª", thursday: "5ª", friday: "6ª",
  };
  return map[day] ?? day;
}

async function getActiveSubs(): Promise<FamilyGroup[]> {
  const [studySnap, transportSnap] = await Promise.all([
    appCol("studyroom").where("status", "==", "active").get(),
    appCol("transportationSubscriptions").where("status", "==", "active").get(),
  ]);

  const byFamily: Record<string, FamilyGroup> = {};

  const ensureFamily = (familyId: string, userId: string) => {
    if (!byFamily[familyId]) {
      byFamily[familyId] = { familyId, userId, study: [], transport: [] };
    }
  };

  for (const doc of studySnap.docs) {
    const d = doc.data();
    ensureFamily(d.familyId, d.userId ?? "");
    byFamily[d.familyId].study.push({ id: doc.id, type: "study", ...d } as ActiveSub);
  }
  for (const doc of transportSnap.docs) {
    const d = doc.data();
    ensureFamily(d.familyId, d.userId ?? "");
    byFamily[d.familyId].transport.push({ id: doc.id, type: "transport", ...d } as ActiveSub);
  }

  return Object.values(byFamily);
}

// ── Invoice generation for a single family ───────────────────────────────────

async function generateForFamily(group: FamilyGroup, period: ReturnType<typeof periodForDate>, dryRun = false): Promise<void> {
  const { familyId, userId, study, transport } = group;

  // Get family contact details
  const famSnap = await appCol("families").doc(familyId).get();
  if (!famSnap.exists) {
    console.warn(`Family ${familyId} not found, skipping`);
    return;
  }
  const fam = famSnap.data()!;
  const contact = fam.primaryContact ?? {};
  const clientName: string = contact.name ?? "Família";
  const clientEmail: string = contact.email ?? "";
  const clientNif: string = fam.nif ?? "999999990"; // consumer NIF if not set

  // Build Vendus line items using existing product IDs
  const items: VendusLineItem[] = [];
  let subtotal = 0;

  for (const sub of study) {
    const amount = sub.monthlyPrice ?? 0;
    const daysStr = (sub.days ?? []).map((d) => dayLabel(d.day)).join(", ");
    items.push({
      id: PRODUCT_STUDY,
      title: `Sala de Estudo — ${sub.childName}${daysStr ? ` (${daysStr})` : ""} — ${period.label}`,
      qty: 1,
      gross_price: amount,
    });
    subtotal += amount;
  }

  for (const sub of transport) {
    const amount = sub.monthlyFee ?? 0;
    const daysStr = (sub.schedule ?? []).map((s) => dayLabel(s.dayOfWeek)).join(", ");
    items.push({
      id: PRODUCT_TRANSPORT,
      title: `Transporte Escolar — ${sub.childName}${daysStr ? ` (${daysStr})` : ""} — ${period.label}`,
      qty: 1,
      gross_price: amount,
    });
    subtotal += amount;
  }

  if (items.length === 0 || subtotal === 0) {
    console.log(`No billable items for family ${familyId}, skipping`);
    return;
  }

  // Dry-run: write a preview invoice to Firestore, skip Vendus + email
  if (dryRun) {
    const dueDate = new Date(period.start);
    dueDate.setDate(8);
    await appCol("invoices").add({
      familyId,
      userId,
      status: "dry-run",
      periodLabel: period.label,
      periodStart: admin.firestore.Timestamp.fromDate(period.start),
      periodEnd: admin.firestore.Timestamp.fromDate(period.end),
      issueDate: admin.firestore.Timestamp.fromDate(period.start),
      dueDate: admin.firestore.Timestamp.fromDate(dueDate),
      subtotal,
      total: subtotal,
      currency: "EUR",
      lineItems: items.map((i) => ({ title: i.title, amount: i.gross_price })),
      billingName: clientName,
      billingEmail: clientEmail,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }

  // Ensure the family has a Vendus client record
  let vendusClientId: number | null = fam.vendusClientId ?? null;
  if (!vendusClientId) {
    vendusClientId = await createOrUpdateClient(familyId, {
      name: clientName,
      email: clientEmail,
      ...(clientNif !== "999999990" ? { fiscal_id: clientNif } : {}),
    });
    await appCol("families").doc(familyId).update({ vendusClientId });
  }

  const vendusClient: VendusClient = { id: vendusClientId };

  // Create invoice in Vendus
  let vendusDoc: Awaited<ReturnType<typeof createInvoice>>;
  try {
    vendusDoc = await createInvoice(vendusClient, items, period.isoDate, PAYMENT_METHOD_TRANSFERENCIA, subtotal, `Período: ${period.label}`);
    if (vendusDoc.errors?.length) {
      throw new Error(vendusDoc.errors.map((e) => e.message).join("; "));
    }
  } catch (err) {
    console.error(`Vendus error for family ${familyId}:`, err);
    // Store failed invoice for retry
    await appCol("invoices").add({
      familyId,
      userId,
      status: "error",
      vendusError: String(err),
      periodLabel: period.label,
      periodStart: admin.firestore.Timestamp.fromDate(period.start),
      periodEnd: admin.firestore.Timestamp.fromDate(period.end),
      subtotal,
      total: subtotal,
      currency: "EUR",
      lineItems: items.map((i) => ({ title: i.title, amount: i.gross_price })),
      billingName: clientName,
      billingEmail: clientEmail,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }

  const invoiceNumber = vendusDoc.number;
  const dueDate = new Date(period.start);
  dueDate.setDate(8); // due by the 8th

  // Store invoice in Firestore
  const invoiceRef = await appCol("invoices").add({
    familyId,
    userId,
    vendusId: vendusDoc.id,
    invoiceNumber,
    atcud: vendusDoc.atcud ?? null,
    status: "pending",
    issueDate: admin.firestore.Timestamp.fromDate(period.start),
    dueDate: admin.firestore.Timestamp.fromDate(dueDate),
    periodLabel: period.label,
    periodStart: admin.firestore.Timestamp.fromDate(period.start),
    periodEnd: admin.firestore.Timestamp.fromDate(period.end),
    subtotal,
    total: subtotal,
    currency: "EUR",
    lineItems: items.map((i) => ({ title: i.title, amount: i.gross_price })),
    billingName: clientName,
    billingEmail: clientEmail,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Queue email
  if (clientEmail) {
    await appCol("emailOutbox").add({
      to: clientEmail,
      subject: `Fatura ${invoiceNumber} — ${COMPANY_NAME} — ${period.label}`,
      html: buildInvoiceEmail({
        clientName,
        invoiceNumber,
        periodLabel: period.label,
        issueDate: period.isoDate,
        dueDate: `${period.start.getFullYear()}-${String(period.start.getMonth() + 1).padStart(2, "0")}-08`,
        items,
        subtotal,
      }),
      status: "queued",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Queued invoice email for ${clientEmail} — ${invoiceNumber}`);
  }
}

// ── Email template ────────────────────────────────────────────────────────────

function buildInvoiceEmail(opts: {
  clientName: string;
  invoiceNumber: string;
  periodLabel: string;
  issueDate: string;
  dueDate: string;
  items: VendusLineItem[];
  subtotal: number;
}): string {
  const { clientName, invoiceNumber, periodLabel, issueDate, dueDate, items, subtotal } = opts;

  const lineItemsHtml = items.map((item) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;">${item.title}</td>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#374151;text-align:right;white-space:nowrap;">€${item.gross_price.toFixed(2)}</td>
    </tr>`).join("");

  const formatDate = (iso: string) => {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };

  return `<!DOCTYPE html>
<html lang="pt">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

      <!-- Header -->
      <tr>
        <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px 40px;text-align:center;">
          <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">${COMPANY_NAME}</h1>
          <p style="margin:8px 0 0;color:#c4b5fd;font-size:14px;">Fatura do mês de ${periodLabel}</p>
        </td>
      </tr>

      <!-- Body -->
      <tr><td style="padding:32px 40px;">

        <p style="margin:0 0 24px;font-size:16px;color:#374151;">Olá, <strong>${clientName}</strong>,</p>
        <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
          Segue em anexo a fatura referente aos serviços do mês de <strong>${periodLabel}</strong>.
        </p>

        <!-- Invoice info -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;background:#f8f7ff;border-radius:8px;padding:16px;">
          <tr>
            <td style="font-size:13px;color:#6b7280;">Número de fatura</td>
            <td style="font-size:13px;color:#1f2937;text-align:right;font-weight:600;">${invoiceNumber}</td>
          </tr>
          <tr>
            <td style="font-size:13px;color:#6b7280;padding-top:6px;">Data de emissão</td>
            <td style="font-size:13px;color:#1f2937;text-align:right;padding-top:6px;">${formatDate(issueDate)}</td>
          </tr>
          <tr>
            <td style="font-size:13px;color:#6b7280;padding-top:6px;">Data de vencimento</td>
            <td style="font-size:13px;color:#e11d48;text-align:right;font-weight:600;padding-top:6px;">${formatDate(dueDate)}</td>
          </tr>
        </table>

        <!-- Line items -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
          <tr>
            <th style="text-align:left;font-size:12px;color:#9ca3af;text-transform:uppercase;padding-bottom:8px;border-bottom:2px solid #e5e7eb;">Descrição</th>
            <th style="text-align:right;font-size:12px;color:#9ca3af;text-transform:uppercase;padding-bottom:8px;border-bottom:2px solid #e5e7eb;">Valor</th>
          </tr>
          ${lineItemsHtml}
        </table>

        <!-- Total -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
          <tr>
            <td style="padding:16px;background:#4f46e5;border-radius:8px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="color:#c4b5fd;font-size:14px;">Total a pagar (IVA incluído)</td>
                  <td style="color:#ffffff;font-size:24px;font-weight:700;text-align:right;">€${subtotal.toFixed(2)}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Payment instructions -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#f0fdf4;padding:16px;border-bottom:1px solid #e5e7eb;">
              <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#166534;">Transferência Bancária (NIB)</p>
              <p style="margin:0;font-size:15px;font-family:monospace;color:#15803d;letter-spacing:1px;">${NIB}</p>
              <p style="margin:6px 0 0;font-size:12px;color:#6b7280;">Referência: <strong>${invoiceNumber}</strong> — Nome: <strong>${clientName}</strong></p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px;">
              <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#1d4ed8;">MB Way</p>
              <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">
                Para pagar via MB Way, contacte-nos pelo <strong>${COMPANY_PHONE}</strong> indicando o seu número de telemóvel e o número de fatura <strong>${invoiceNumber}</strong>.
              </p>
            </td>
          </tr>
        </table>


        <p style="margin:0;font-size:13px;color:#9ca3af;line-height:1.6;">
          Em caso de dúvidas, contacte-nos através de <a href="mailto:geral.arcoirisdapequenada@gmail.com" style="color:#4f46e5;">geral.arcoirisdapequenada@gmail.com</a> ou ${COMPANY_PHONE}.
        </p>

      </td></tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">${COMPANY_NAME} · NIF 518942120 · Rua do Peneireiro, Nº 33, 3040-716 Coimbra</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

// ── Scheduled function: runs 1st of each month at 01:00 Lisbon time ──────────

export const generateMonthlyInvoices = onSchedule(
  {
    schedule: "0 1 1 * *",
    timeZone: "Europe/Lisbon",
    region: "europe-west3",
    secrets: ["VENDUS_API_KEY", "VENDUS_REGISTER_ID"],
  },
  async () => {
    const now = new Date();
    const period = periodForDate(now);
    console.log(`Generating invoices for period: ${period.label}`);

    const groups = await getActiveSubs();
    console.log(`Found ${groups.length} families with active subscriptions`);

    const results = await Promise.allSettled(
      groups.map((group) => generateForFamily(group, period))
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      console.error(`${failed.length} families failed:`, failed);
    }
    console.log(`Done. ${results.length - failed.length}/${results.length} invoices generated.`);
  }
);

// ── Admin callable: trigger generation manually for a given month ─────────────

export const triggerInvoiceGeneration = onCall(
  {
    region: "europe-west3",
    secrets: ["VENDUS_API_KEY", "VENDUS_REGISTER_ID"],
  },
  async (request) => {
    // Only owners can trigger manually
    const uid = request.auth?.uid;
    if (!uid) throw new Error("Unauthenticated");

    const userDoc = await db.collection("users").doc(uid).get();
    const roles = userDoc.data()?.roles ?? {};
    if (!roles.owner && !roles.rainbowAdmin) {
      throw new Error("Unauthorized");
    }

    // Optional: override year/month (defaults to current month); dryRun skips Vendus + email
    const { year, month, dryRun = false } = request.data ?? {};
    const date = year && month ? new Date(year, month - 1, 1) : new Date();
    const period = periodForDate(date);

    console.log(`Manual trigger: generating invoices for ${period.label}${dryRun ? " (DRY RUN)" : ""}`);
    const groups = await getActiveSubs();
    const results = await Promise.allSettled(
      groups.map((group) => generateForFamily(group, period, dryRun))
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    return { generated: results.length - failed, failed, period: period.label };
  }
);
