import * as admin from "firebase-admin";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { appCol } from "./db";
import { ADMIN_EMAIL, APP_URL, emailWrapper } from "./notifications";
import { familyBillingInfo } from "./familyBilling";
import { ensurePartyDeposit, PartyDepositResult } from "./partyDeposit";
import { partyDate, partyPriceBreakdown, partyStatusEvent, PARTY_VAT_CODE } from "./partyDepositLogic";

// Party bookings (_apps/arcoiris/bookings): the admin is told about a new
// request; when the admin confirms one, the 50% deposit bill is created and the
// parent is emailed how to pay it; a rejected request emails the parent the
// reason. Same outbox and layout as the study room / transport notices in
// notifications.ts. No external call here: Firestore and the email outbox only.

if (!admin.apps.length) admin.initializeApp();

const PAID_STATUSES = new Set(["paid", "invoiced"]);

/** emailOutbox doc id of a booking's notice: at most one of each kind per
 *  booking, so a redelivered trigger event never emails twice. */
export const partyEmailId = (kind: "request" | "confirmed" | "rejected", bookingId: string) =>
  `party_${kind}_${bookingId}`;

function escapeHtml(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}

const eur = (n: number) => `€${n.toFixed(2)}`;

function fmtPartyDate(dateStr: unknown): string {
  const d = partyDate(dateStr);
  return d
    ? d.toLocaleDateString("pt-PT", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    : String(dateStr ?? "") || "—";
}

/** "sábado, 21 de novembro de 2026 às 15:00" */
function whenText(b: FirebaseFirestore.DocumentData): string {
  return `${fmtPartyDate(b.date)}${b.time ? ` às ${b.time}` : ""}`;
}

function extrasText(b: FirebaseFirestore.DocumentData): string {
  const extras: string[] = Array.isArray(b.extras) ? b.extras : [];
  return extras.map(name => {
    const q = Number(b.extrasDetail?.[name] ?? 1);
    return q > 1 ? `${q} × ${name}` : name;
  }).join(", ");
}

const row = (label: string, value: string) =>
  `<tr><td style="padding:6px 0;color:#6b7280;width:140px;vertical-align:top;">${label}</td><td style="padding:6px 0;">${value}</td></tr>`;

const button = (href: string, label: string) =>
  `<p style="text-align:center;margin-top:24px;">
      <a href="${href}" style="background:#4f46e5;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">${label}</a>
    </p>`;

// ── Email templates ───────────────────────────────────────────────────────────

export function buildPartyRequestAdminEmail(b: FirebaseFirestore.DocumentData): string {
  const price = partyPriceBreakdown(b.total);
  const extras = extrasText(b);
  const body = `
    <p style="font-size:16px;color:#374151;">Novo pedido de reserva — <strong>Festa de aniversário</strong></p>
    <table style="width:100%;font-size:14px;color:#374151;margin:16px 0;border-collapse:collapse;">
      ${row("Criança", `<strong>${escapeHtml(b.childName) || "—"}</strong>${b.childAge ? ` (${escapeHtml(b.childAge)} anos)` : ""}`)}
      ${row("Festa", escapeHtml(b.partyType) || "—")}
      ${row("Data", escapeHtml(whenText(b)))}
      ${row("Crianças", escapeHtml(b.numKids ?? "—"))}
      ${extras ? row("Extras", escapeHtml(extras)) : ""}
      ${row("Total", `<strong>${eur(price.total)}</strong> com IVA <span style="color:#6b7280;">(sem IVA ${eur(price.subtotal)} · IVA ${PARTY_VAT_CODE}% ${eur(price.vat)})</span>`)}
      ${row("Sinal (50%)", `${eur(price.deposit)} com IVA`)}
      ${row("Encarregado", escapeHtml(b.parentName) || "—")}
      ${row("Email", escapeHtml(b.email) || "—")}
    </table>
    <p style="font-size:13px;color:#6b7280;">Ao confirmar a reserva, o sinal é lançado automaticamente nos pagamentos da família e o encarregado recebe um email para o pagar.</p>
    ${button(`${APP_URL}/admin/parties`, "Ver reservas")}`;
  return emailWrapper("Novo pedido — Festa", body);
}

export function buildPartyConfirmedEmail(
  bookingId: string,
  b: FirebaseFirestore.DocumentData,
  deposit: Pick<PartyDepositResult, "total" | "status"> | null,
): string {
  // The bill's own amount when there is one (a deposit created before a price
  // change keeps its amount); otherwise what the party page will bill.
  const amount = deposit ? deposit.total : partyPriceBreakdown(b.total).deposit;
  const paid = !!deposit && PAID_STATUSES.has(deposit.status);
  const partyUrl = `${APP_URL}/client/parties/${encodeURIComponent(bookingId)}`;
  const name = escapeHtml(String(b.parentName ?? "").trim());
  const payBlock = paid
    ? `<p style="font-size:14px;color:#374151;">O sinal de <strong>${eur(amount)}</strong> já está pago. O valor restante é pago no dia da festa.</p>
    ${button(partyUrl, "Ver reserva")}`
    : `<p style="font-size:14px;color:#374151;">Para garantir a data, só falta pagar o sinal de 50%: <strong>${eur(amount)}</strong> (IVA incluído). O valor restante é pago no dia da festa.</p>
    ${button(partyUrl, "Pagar sinal")}
    ${deposit ? `<p style="font-size:13px;color:#6b7280;margin-top:20px;">Também encontra este pagamento na sua área de cliente, em Pagamentos.</p>` : ""}`;
  const body = `
    <p style="font-size:16px;color:#374151;">Olá${name ? `, <strong>${name}</strong>` : ""},</p>
    <p style="font-size:16px;color:#374151;">A festa de <strong>${escapeHtml(b.childName) || "aniversário"}</strong> está confirmada!</p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:24px 0;">
      <p style="margin:0;font-size:14px;color:#166534;line-height:1.6;">
        🎈 ${escapeHtml(b.partyType) || "Festa"}<br/>
        📅 ${escapeHtml(whenText(b))}<br/>
        👧 ${escapeHtml(b.numKids ?? "—")} crianças
      </p>
    </div>
    ${payBlock}`;
  return emailWrapper("Festa confirmada", body);
}

export function buildPartyRejectedEmail(b: FirebaseFirestore.DocumentData): string {
  const reason = String(b.statusReason ?? "").trim();
  const reasonBlock = reason
    ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:24px 0;"><p style="margin:0;font-size:14px;color:#991b1b;">Motivo: ${escapeHtml(reason)}</p></div>`
    : "";
  const name = escapeHtml(String(b.parentName ?? "").trim());
  const body = `
    <p style="font-size:16px;color:#374151;">Olá${name ? `, <strong>${name}</strong>` : ""},</p>
    <p style="font-size:16px;color:#374151;">Lamentamos, mas não foi possível confirmar a festa de <strong>${escapeHtml(b.childName) || "aniversário"}</strong> para ${escapeHtml(whenText(b))}.</p>
    ${reasonBlock}
    <p style="font-size:14px;color:#6b7280;">Pode fazer um novo pedido para outra data na sua área de cliente. Se tiver dúvidas, entre em contacto connosco por email ou telefone.</p>
    ${button(`${APP_URL}/client/parties/new`, "Fazer novo pedido")}`;
  return emailWrapper("Reserva de festa", body);
}

// ── Outbox ────────────────────────────────────────────────────────────────────

/** Queues one email under a fixed id. create() fails if it already exists, so
 *  a second run for the same notice queues nothing. Returns whether it queued. */
async function queueEmailOnce(
  id: string,
  mail: { to: string; subject: string; html: string },
  meta: { bookingId: string; familyId?: string; billingId?: string },
): Promise<boolean> {
  try {
    await appCol("emailOutbox").doc(id).create({
      ...mail,
      status: "queued",
      bookingId: meta.bookingId,
      familyId: meta.familyId || null,
      ...(meta.billingId ? { billingId: meta.billingId } : {}),
      tags: ["party"],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (err: any) {
    if (err?.code === 6 || /already exists/i.test(err?.message ?? "")) {
      console.log(`[party] email ${id} already queued, not queuing again`);
      return false;
    }
    throw err;
  }
}

/** The parent's email: the booking's, else the family's primary contact. */
async function parentEmail(b: FirebaseFirestore.DocumentData): Promise<string> {
  if (typeof b.email === "string" && b.email.trim()) return b.email.trim();
  if (!b.familyId) return "";
  return (await familyBillingInfo(String(b.familyId))).contactEmail.trim();
}

// ── Triggers ──────────────────────────────────────────────────────────────────

export const onPartyBookingCreated = onDocumentCreated(
  { document: "_apps/arcoiris/bookings/{bookingId}", region: "europe-west3" },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    const bookingId = event.params.bookingId;
    await queueEmailOnce(partyEmailId("request", bookingId), {
      to: ADMIN_EMAIL,
      subject: `Novo pedido — Festa: ${data.childName ?? ""}`,
      html: buildPartyRequestAdminEmail(data),
    }, { bookingId, familyId: data.familyId });
  },
);

export const onPartyBookingStatusNotify = onDocumentUpdated(
  { document: "_apps/arcoiris/bookings/{bookingId}", region: "europe-west3" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    const kind = partyStatusEvent(before.status, after.status);
    if (!kind) return; // status unchanged (an edit), or a transition nobody is told about
    const bookingId = event.params.bookingId;

    if (kind === "confirmed") {
      // Bill first: the email quotes its amount. If it fails, the parent is
      // still told (the party page creates the bill through createPartyDeposit),
      // and the error is rethrown so the run shows as failed in the logs.
      let deposit: PartyDepositResult | null = null;
      let billError: unknown = null;
      try {
        deposit = await ensurePartyDeposit(bookingId, after, "onPartyBookingStatusNotify");
      } catch (err) {
        billError = err;
        console.error(`[party] booking ${bookingId} confirmed but its deposit bill could not be created:`, err);
      }

      const to = await parentEmail(after);
      if (to) {
        await queueEmailOnce(partyEmailId("confirmed", bookingId), {
          to,
          subject: `Festa confirmada — ${after.childName ?? ""}`,
          html: buildPartyConfirmedEmail(bookingId, after, deposit),
        }, { bookingId, familyId: after.familyId, billingId: deposit?.billingId });
      } else {
        console.warn(`[party] booking ${bookingId} confirmed, but neither the booking nor the family has an email: parent not notified`);
      }
      if (billError) throw billError;
      return;
    }

    // pending → rejected. No bill.
    const to = await parentEmail(after);
    if (!to) {
      console.warn(`[party] booking ${bookingId} rejected, but neither the booking nor the family has an email: parent not notified`);
      return;
    }
    await queueEmailOnce(partyEmailId("rejected", bookingId), {
      to,
      subject: `Reserva de festa — ${after.childName ?? ""}`,
      html: buildPartyRejectedEmail(after),
    }, { bookingId, familyId: after.familyId });
  },
);
