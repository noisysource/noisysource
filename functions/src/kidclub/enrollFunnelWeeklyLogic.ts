// Pure part of the weekly enrollment funnel email (enrollFunnelWeekly.ts), kept
// separate so it's testable without Firestore. Counts only: nothing built here
// may contain a name, an email, a child or any free text from a document.

export type Service = "study" | "transport";

export const SERVICES: Service[] = ["study", "transport"];
export const SERVICE_LABEL: Record<Service, string> = { study: "Sala de Estudo", transport: "Transporte" };

export const WINDOW_DAYS = 7;
export const NO_SUBSCRIPTION_WINDOW_DAYS = 30;
export const STALE_AFTER_DAYS = 14;

const DAY_MS = 86_400_000;

// A parent's own enrollment form writes no `source` at all. These mark documents
// a parent didn't create: `manual` and `admin_correction` are the admin's, and
// `web` is what ClaimSubscriptionsPage stamps on an admin-created subscription
// when the parent claims it, which also overwrites `manual`.
const NOT_CREATED_BY_PARENT = new Set(["manual", "admin_correction", "web"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "archived", "inactive"]); // normalizeSubStatus in the app
const MERGED_CHILD = "merged"; // listModel.ts in the app

/** Firestore Timestamp, Date, ISO string or millis. Old docs may have none of these. */
export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const v = value as { toDate?: () => Date };
  const date = typeof v.toDate === "function" ? v.toDate() : new Date(value as string | number | Date);
  return date instanceof Date && !isNaN(date.getTime()) ? date : null;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/** users/{uid}.roles only holds staff roles (Role in packages/shared): any of them set means staff. */
export function hasStaffRole(roles: unknown): boolean {
  return !!roles && typeof roles === "object" && Object.values(roles).some(v => v === true);
}

/** `capped`: a read limit was hit, so the real number may be higher. */
export interface Counted {
  count: number;
  capped: boolean;
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export interface AuthAccount {
  uid: string;
  email?: string;
  createdAt: Date | null;
}

export function countNewAccounts(
  accounts: AuthAccount[], staff: Set<string>, adminEmail: string, now: Date, capped = false,
): Counted {
  const since = daysAgo(now, WINDOW_DAYS);
  const count = accounts.filter(a =>
    !!a.createdAt && a.createdAt >= since &&
    !staff.has(a.uid) &&
    (a.email ?? "").toLowerCase() !== adminEmail.toLowerCase()
  ).length;
  return { count, capped };
}

// ─── Families and children ───────────────────────────────────────────────────

export interface FamilyRow {
  profileComplete?: boolean;
  primaryContact?: { userId?: string };
  createdAt?: unknown;
}

export function countProfilesCompleted(families: FamilyRow[], staff: Set<string>, now: Date, capped = false): Counted {
  const since = daysAgo(now, WINDOW_DAYS);
  const count = families.filter(f => {
    const createdAt = toDate(f.createdAt);
    return !!createdAt && createdAt >= since && f.profileComplete === true &&
      !staff.has(f.primaryContact?.userId ?? "");
  }).length;
  return { count, capped };
}

export interface ChildRow {
  familyId?: string;
  userId?: string;
  status?: string;
  createdAt?: unknown;
}

// No userId: created by the admin and not claimed yet, not a parent's action.
const isParentChild = (c: ChildRow, staff: Set<string>) =>
  !!c.userId && !staff.has(c.userId) && c.status !== MERGED_CHILD;

/** Read window is the 30-day one; this counts the last 7 days of it. */
export function countChildrenAdded(children: ChildRow[], staff: Set<string>, now: Date, limitHit = false): Counted {
  const since = daysAgo(now, WINDOW_DAYS);
  const inWindow = children.filter(c => {
    const createdAt = toDate(c.createdAt);
    return !!createdAt && createdAt >= since;
  });
  return {
    count: inWindow.filter(c => isParentChild(c, staff)).length,
    capped: limitHit && inWindow.length === children.length,
  };
}

/** Families whose subscriptions have to be checked: those with a parent's child in the 30-day window. */
export function familiesWithRecentChild(children: ChildRow[], staff: Set<string>, now: Date): string[] {
  const since = daysAgo(now, NO_SUBSCRIPTION_WINDOW_DAYS);
  const ids = new Set<string>();
  for (const c of children) {
    const createdAt = toDate(c.createdAt);
    if (c.familyId && createdAt && createdAt >= since && isParentChild(c, staff)) ids.add(c.familyId);
  }
  return [...ids];
}

export interface SubscriptionRow {
  familyId?: string;
  status?: string;
  canceled?: boolean;
}

const isCancelled = (s: SubscriptionRow) => s.canceled === true || CANCELLED_STATUSES.has(s.status ?? "");

export function countWithoutSubscription(familyIds: string[], subscriptions: SubscriptionRow[]): number {
  const withSubscription = new Set(subscriptions.filter(s => !isCancelled(s)).map(s => s.familyId));
  return familyIds.filter(id => !withSubscription.has(id)).length;
}

// ─── Parent enrollment requests ──────────────────────────────────────────────

export interface RequestRow {
  userId?: string;
  source?: string;
  createdAt?: unknown;
}

export interface RequestSummary {
  /** Newest request created by a parent among the docs read; null if none. */
  lastAt: Date | null;
  /** The newest docs were read, not all of them, so "none found" isn't "none exist". */
  limitHit: boolean;
  lastWeek: Record<Service, Counted>;
}

export function isParentRequest(r: RequestRow, staff: Set<string>): boolean {
  return !!r.userId && !staff.has(r.userId) && !NOT_CREATED_BY_PARENT.has(r.source ?? "");
}

export function summarizeRequests(
  byService: Record<Service, { rows: RequestRow[]; limitHit: boolean }>, staff: Set<string>, now: Date,
): RequestSummary {
  const since = daysAgo(now, WINDOW_DAYS);
  let lastAt: Date | null = null;
  const lastWeek = {} as Record<Service, Counted>;
  for (const service of SERVICES) {
    const { rows, limitHit } = byService[service];
    let inWindow = 0;
    let count = 0;
    for (const row of rows) {
      const createdAt = toDate(row.createdAt);
      if (!createdAt) continue;
      const parent = isParentRequest(row, staff);
      if (parent && (!lastAt || createdAt > lastAt)) lastAt = createdAt;
      if (createdAt >= since) {
        inWindow++;
        if (parent) count++;
      }
    }
    lastWeek[service] = { count, capped: limitHit && inWindow === rows.length };
  }
  return { lastAt, limitHit: SERVICES.some(s => byService[s].limitHit), lastWeek };
}

// ─── Form activity (clientEvents, written by the app's src/lib/clientEvents.ts) ─

export interface FormEventRow {
  userId?: string;
  impersonatingFamilyId?: string | null;
  event?: string;
  service?: string;
  data?: {
    studyDays?: number;
    transportDays?: number;
    tripsMissingAddress?: number;
    submitEnabled?: boolean;
    seconds?: number;
    reason?: string;
  };
}

export interface FormSummary {
  opened: number;
  submitted: number;
  left: number;
  /** Opened, but neither a submit nor a leave was recorded (the tab died in the background, say). */
  noExitRecorded: number;
  blocked: Record<string, number>;
  leftStates: { label: string; count: number }[];
  medianSecondsBeforeLeaving: number | null;
}

export const BLOCK_REASON_LABEL: Record<string, string> = {
  not_ready: "formulário por carregar ou inválido",
  duplicate_study: "já inscrito na Sala de Estudo",
  duplicate_transport: "já inscrito no Transporte",
};

/** Where a parent stood when they left, most telling first. */
export function leftState(data: FormEventRow["data"] = {}): string {
  const study = data.studyDays ?? 0;
  const transport = data.transportDays ?? 0;
  if (study + transport === 0) return "sem dias escolhidos";
  if ((data.tripsMissingAddress ?? 0) > 0) return "viagens sem morada";
  if (data.submitEnabled) return "pronto a enviar, não enviou";
  if (transport === 0) return "só Sala de Estudo, sem viagens";
  return "botão desativado, outro motivo";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Parents only: not staff accounts, not an admin acting for a family. */
export function summarizeForms(events: FormEventRow[], staff: Set<string>): Record<Service, FormSummary> {
  const out = {} as Record<Service, FormSummary>;
  for (const service of SERVICES) {
    const rows = events.filter(e =>
      e.service === service && !e.impersonatingFamilyId && !staff.has(e.userId ?? ""));
    const count = (name: string) => rows.filter(e => e.event === name).length;
    const leftRows = rows.filter(e => e.event === "enroll_left");

    const states = new Map<string, number>();
    for (const e of leftRows) states.set(leftState(e.data), (states.get(leftState(e.data)) ?? 0) + 1);
    const blocked: Record<string, number> = {};
    for (const e of rows.filter(r => r.event === "enroll_blocked")) {
      const reason = e.data?.reason ?? "";
      const key = reason in BLOCK_REASON_LABEL ? reason : "other";
      blocked[key] = (blocked[key] ?? 0) + 1;
    }

    const opened = count("enroll_form_opened");
    const submitted = count("enroll_submitted");
    out[service] = {
      opened,
      submitted,
      left: leftRows.length,
      noExitRecorded: Math.max(0, opened - submitted - leftRows.length),
      blocked,
      leftStates: [...states.entries()]
        .map(([label, n]) => ({ label, count: n }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      medianSecondsBeforeLeaving: median(
        leftRows.map(e => e.data?.seconds).filter((s): s is number => typeof s === "number")),
    };
  }
  return out;
}

// ─── The email ───────────────────────────────────────────────────────────────

/** null means that read failed: the email says so instead of showing a wrong 0. */
export interface FunnelReport {
  now: Date;
  requests: RequestSummary | null;
  newAccounts: Counted | null;
  profilesCompleted: Counted | null;
  childrenAdded: Counted | null;
  forms: { byService: Record<Service, FormSummary>; capped: boolean } | null;
  familiesWithoutSubscription: Counted | null;
  adminUrl: string;
  /** Plain sentences for the end of the email (a failed staff lookup, say). */
  warnings?: string[];
}

const esc = (s: unknown) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const lisbonDate = (d: Date) => d.toLocaleDateString("pt-PT", {
  timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "numeric",
});

const UNAVAILABLE = "indisponível (erro de leitura)";
const shown = (c: Counted | null) => c ? `${c.count}${c.capped ? "+" : ""}` : UNAVAILABLE;

const agoText = (days: number) => days === 0 ? "hoje" : days === 1 ? "há 1 dia" : `há ${days} dias`;

const TD = 'style="padding:4px 8px"';
const TH = 'style="padding:4px 8px;text-align:left"';

function lastRequestBlock(r: FunnelReport): { line: string; warning: string | null; subject: string } {
  if (!r.requests) {
    return {
      line: UNAVAILABLE,
      warning: "ATENÇÃO: não foi possível ler os pedidos de inscrição desta semana.",
      subject: "[KidClub] ATENÇÃO: relatório semanal de inscrições incompleto",
    };
  }
  if (!r.requests.lastAt) {
    return {
      line: r.requests.limitHit ? "nenhum entre os pedidos mais recentes" : "nenhum encontrado",
      warning: "ATENÇÃO: não foi encontrado nenhum pedido criado por um encarregado. Confirme que as inscrições estão a funcionar.",
      subject: "[KidClub] ATENÇÃO: nenhum pedido de inscrição encontrado",
    };
  }
  const days = Math.floor((r.now.getTime() - r.requests.lastAt.getTime()) / DAY_MS);
  const ago = agoText(days);
  const stale = days > STALE_AFTER_DAYS;
  return {
    line: `${lisbonDate(r.requests.lastAt)} (${ago})`,
    warning: stale
      ? `ATENÇÃO: passaram mais de ${STALE_AFTER_DAYS} dias sem nenhum pedido criado por um encarregado. Confirme que as inscrições estão a funcionar.`
      : null,
    subject: stale
      ? `[KidClub] ATENÇÃO: último pedido de inscrição ${ago}`
      : `[KidClub] Inscrições: último pedido ${ago}`,
  };
}

function formsTable(forms: NonNullable<FunnelReport["forms"]>): string {
  const row = (label: string, cell: (f: FormSummary) => string | number) =>
    `<tr><td ${TD}>${esc(label)}</td>${SERVICES.map(s => `<td ${TD}>${esc(cell(forms.byService[s]))}</td>`).join("")}</tr>`;
  const states = (f: FormSummary) =>
    f.leftStates.map(s => `${s.count} ${s.label}`).join("; ") || "–";
  const blocked = (f: FormSummary) => {
    const total = Object.values(f.blocked).reduce((a, b) => a + b, 0);
    if (total === 0) return 0;
    const parts = Object.entries(f.blocked).map(([k, n]) => `${n} ${BLOCK_REASON_LABEL[k] ?? "outro motivo"}`);
    return `${total} (${parts.join("; ")})`;
  };
  return `<table style="border-collapse:collapse" border="1" cellspacing="0">
<tr><th ${TH}></th>${SERVICES.map(s => `<th ${TH}>${esc(SERVICE_LABEL[s])}</th>`).join("")}</tr>
${row("Abertos", f => f.opened)}
${row("Enviados", f => f.submitted)}
${row("Saíram sem enviar", f => f.left)}
${row("Estado ao sair", states)}
${row("Tempo mediano antes de sair", f => f.medianSecondsBeforeLeaving === null ? "–" : `${f.medianSecondsBeforeLeaving} s`)}
${row("Sem saída registada", f => f.noExitRecorded)}
${row("Tentativas de envio bloqueadas", blocked)}
</table>
<p style="color:#666;font-size:12px">"Sem saída registada": o formulário foi aberto, mas não há registo de envio nem de saída (por exemplo, o telemóvel fechou o separador em segundo plano).${forms.capped ? " Atingido o limite de leitura: os números podem ser mais altos." : ""}</p>`;
}

/** Always returns an email, also when every number is 0: silence must not be ambiguous. */
export function buildFunnelEmail(r: FunnelReport): { subject: string; html: string } {
  const top = lastRequestBlock(r);
  const countRow = (label: string, value: Counted | null) =>
    `<tr><td ${TD}>${esc(label)}</td><td ${TD}><b>${esc(shown(value))}</b></td></tr>`;
  const warnings = (r.warnings ?? []).map(w => `<p style="color:#b00020">${esc(w)}</p>`).join("");

  const html = `<div style="font-family:Arial,sans-serif;font-size:13px">
<p style="font-size:16px"><b>Último pedido de inscrição criado por um encarregado:</b> ${esc(top.line)}</p>
${top.warning ? `<p style="background:#fdecea;color:#b00020;font-weight:bold;padding:8px">${esc(top.warning)}</p>` : ""}
<h3 style="margin-bottom:4px">Últimos ${WINDOW_DAYS} dias</h3>
<table style="border-collapse:collapse" border="1" cellspacing="0">
${countRow("Contas novas", r.newAccounts)}
${countRow("Perfis completos (famílias criadas nestes dias)", r.profilesCompleted)}
${countRow("Crianças adicionadas", r.childrenAdded)}
${SERVICES.map(s => countRow(`Pedidos de inscrição: ${SERVICE_LABEL[s]}`, r.requests?.lastWeek[s] ?? null)).join("\n")}
</table>
<h3 style="margin-bottom:4px">Formulário de inscrição, últimos ${WINDOW_DAYS} dias</h3>
${r.forms ? formsTable(r.forms) : `<p>${UNAVAILABLE}</p>`}
<h3 style="margin-bottom:4px">Famílias sem inscrição</h3>
<p><b>${esc(shown(r.familiesWithoutSubscription))}</b> com uma criança criada nos últimos ${NO_SUBSCRIPTION_WINDOW_DAYS} dias e sem inscrição ativa ou pendente.
<a href="${esc(r.adminUrl)}">Ver em Famílias e inscrições</a> ("Mostrar famílias sem inscrições"; famílias só com inscrições canceladas contam aqui, mas não aparecem nesse filtro).</p>
${warnings}
<p style="color:#666;font-size:12px">Só contagens. Não inclui contas da equipa nem inscrições criadas pelo admin. Um pedido feito pelo admin a agir em nome de uma família não se distingue do de um encarregado.</p>
</div>`;
  return { subject: top.subject, html };
}
