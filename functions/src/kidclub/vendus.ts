import { assertExternalCallsAllowed } from "../externalGuard";
import { reserveVendusClientCreation } from "./vendusClientCap";
import { realNif } from "./vendusClientLogic";

const BASE_URL = "https://www.vendus.pt/ws/v1.1";

// Stable Vendus product IDs for KidClub services
export const PRODUCT_STUDY = 286916222;    // Serviço de apoio ao ensino (NOR 23%)
export const PRODUCT_TRANSPORT = 286916284; // Serviço Transporte (RED 6%)
export const PRODUCT_ENROLLMENT_FEE = 287413994; // Taxa de Inscricão — €35, matches config/studyCenter.registrationFee
export const PRODUCT_INSURANCE = 287414358;      // Seguro — €25, matches config/studyCenter.insuranceFee

// Vendus payment method IDs (FR documents require a payments[] array)
export const PAYMENT_METHOD_MULTIBANCO = 286783130;
export const PAYMENT_METHOD_TRANSFERENCIA = 286783134; // used for MBWay, card, bank transfer

function apiKey(): string {
  const key = process.env.VENDUS_API_KEY;
  if (!key) throw new Error("VENDUS_API_KEY environment variable is not set");
  return key;
}

function registerId(): number {
  const id = process.env.VENDUS_REGISTER_ID;
  if (!id) throw new Error("VENDUS_REGISTER_ID environment variable is not set");
  return parseInt(id, 10);
}

/** One Vendus call; returns status and parsed body without judging them. */
async function send(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  assertExternalCallsAllowed("Vendus");
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as any;
  return { ok: res.ok, status: res.status, data };
}

function failure(method: string, path: string, status: number, data: unknown): Error {
  return new Error(`Vendus ${method} ${path} failed (${status}): ${JSON.stringify(data)}`);
}

/** One Vendus call; throws on any non-2xx. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { ok, status, data } = await send(method, path, body);
  if (!ok) throw failure(method, path, status, data);
  return data as T;
}

export interface VendusLineItem {
  id: number;       // Vendus product ID
  title: string;    // description override
  qty: number;
  gross_price: number;
}

export interface VendusClient {
  id?: number;      // use existing Vendus client ID
  name?: string;
  email?: string;
  fiscal_id?: string;
}

export interface VendusDocument {
  id: number;
  number: string;
  date: string;
  amount_gross?: string;
  amount_net?: string;
  hash?: string;
  atcud?: string;
  errors?: Array<{ code: string; message: string }>;
}

// No `external_reference` here, on purpose: Vendus prints a client's
// external_reference next to its name on every invoice (customers saw
// "Name (family:<id>)"). Clients are identified by the family doc's
// `vendusClientId` instead. Don't add it back.
export interface VendusClientPayload {
  name: string;
  email?: string;
  fiscal_id?: string;
  phone?: string;
  address?: string;
  postalcode?: string;
  city?: string;
  send_email?: "yes" | "no";
}

export interface VendusClientRecord {
  id: number;
  name: string;
  email: string;
  fiscal_id: string;
  external_reference: string;
}

/** True when a request() error is a Vendus 404 (e.g. the client was deleted). */
function isNotFound(err: any): boolean {
  return typeof err?.message === "string" && err.message.includes("failed (404)");
}

/** True when Vendus rejected a client write because the NIF is already on another client. */
function isDuplicateNif(err: any): boolean {
  return typeof err?.message === "string" && err.message.includes("duplicado");
}

/** Find client by NIF (fiscal_id). Returns null if not found. */
async function findClientByNif(fiscalId: string): Promise<VendusClientRecord | null> {
  try {
    const results = await request<VendusClientRecord[]>(
      "GET", `/clients/?fiscal_id=${encodeURIComponent(fiscalId)}`
    );
    if (!Array.isArray(results) || results.length === 0) return null;
    return results[0];
  } catch (err: any) {
    if (err.message?.includes("(404)")) return null;
    throw err;
  }
}

/**
 * Create a new Vendus client. Every creation goes through the daily cap first
 * (vendusClientCap.ts); over the cap, or if the counter can't be updated, this
 * throws without calling Vendus. `label` only identifies the caller in logs.
 */
export async function createClient(payload: VendusClientPayload, label?: string): Promise<VendusClientRecord> {
  assertExternalCallsAllowed("Vendus"); // don't count a call the guard would block anyway
  await reserveVendusClientCreation(label || payload.name || "(unnamed)");
  return request<VendusClientRecord>("POST", "/clients/", payload);
}

/** Update an existing Vendus client. */
export async function updateClient(id: number, payload: Partial<VendusClientPayload>): Promise<VendusClientRecord> {
  return request<VendusClientRecord>("PATCH", `/clients/${id}/`, payload);
}

/** Read one Vendus client. Returns null on a 404 (e.g. deleted in Vendus). */
export async function getClient(id: number): Promise<VendusClientRecord | null> {
  try {
    return await request<VendusClientRecord>("GET", `/clients/${id}/`);
  } catch (err: any) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Create or update the Vendus client for a family. Returns the Vendus client ID.
 *
 * 1. `knownClientId` (the family doc's `vendusClientId`) set:
 *    - Payload has a NIF: read the known client first (one GET). If it holds a
 *      different NIF or none, don't touch it: go to step 2 as if there were no
 *      known client, and return the client that holds the NIF (the caller
 *      re-links the family). A NIF is never PATCHed onto a client that has
 *      another one or none (Renato, 2026-10-13): that client already has
 *      invoices without it, and Vendus may refuse the change anyway.
 *    - Otherwise PATCH it. If Vendus still says the NIF is a duplicate,
 *      re-link to the client holding it, or throw (never create here).
 *    - 404 (client deleted in Vendus), on the GET or the PATCH: go to step 2.
 *    - Any other error: throw, so a family that has a client never creates
 *      another one by accident.
 * 2. Payload has a NIF: look the client up by NIF and PATCH it if found.
 * 3. Otherwise create it (daily-capped, see createClient). If Vendus rejects a
 *    duplicate NIF, re-link the existing client found by NIF.
 *
 * Never sends `external_reference`: Vendus prints it on invoices.
 */
export async function createOrUpdateClient(
  familyId: string,
  payload: VendusClientPayload,
  knownClientId?: number | null,
): Promise<number> {
  // Belt and braces for untyped callers: VendusClientPayload has no
  // external_reference, and it must never reach Vendus.
  const { external_reference: _dropped, ...body } = payload as VendusClientPayload & { external_reference?: unknown };

  let patchKnown = !!knownClientId;
  if (knownClientId && body.fiscal_id) {
    const known = await getClient(knownClientId);
    if (!known) {
      console.warn(`[Vendus] client ${knownClientId} for family ${familyId} not found (404), looking it up again`);
      patchKnown = false;
    } else if (realNif(known.fiscal_id) !== realNif(body.fiscal_id)) {
      // e.g. family 8pPhu4JCvGUrpBxsaOeY (2026-10): linked to a NIF-less
      // client, then added a NIF. Find or create the client for that NIF.
      console.log(`[Vendus] client ${knownClientId} has NIF "${realNif(known.fiscal_id)}", not ${body.fiscal_id}; not changing it, finding the client for that NIF for family ${familyId}`);
      patchKnown = false;
    }
  }

  if (knownClientId && patchKnown) {
    try {
      await updateClient(knownClientId, body);
      return knownClientId;
    } catch (err: any) {
      if (body.fiscal_id && isDuplicateNif(err)) {
        // Shouldn't happen after the NIF check above; kept so a surprise
        // "duplicado" still re-links instead of failing.
        const byNif = await findClientByNif(body.fiscal_id);
        if (byNif && byNif.id !== knownClientId) {
          console.log(`[Vendus] NIF ${body.fiscal_id} is on client ${byNif.id}; re-linking family ${familyId} from client ${knownClientId}`);
          await updateClient(byNif.id, body);
          return byNif.id;
        }
        throw err;
      }
      if (!isNotFound(err)) throw err;
      console.warn(`[Vendus] client ${knownClientId} for family ${familyId} not found (404), looking it up again`);
    }
  }

  if (body.fiscal_id) {
    const byNif = await findClientByNif(body.fiscal_id);
    if (byNif) {
      await updateClient(byNif.id, body);
      return byNif.id;
    }
  }

  try {
    const created = await createClient(body, `family:${familyId}`);
    return created.id;
  } catch (err: any) {
    // Vendus rejects duplicate NIFs — find the existing client and re-link it
    if (body.fiscal_id && isDuplicateNif(err)) {
      console.log(`[Vendus] duplicate NIF ${body.fiscal_id}, looking up existing client`);
      const byNif = await findClientByNif(body.fiscal_id);
      if (byNif) {
        await updateClient(byNif.id, body);
        return byNif.id;
      }
    }
    throw err;
  }
}

/**
 * The Vendus client for a NIF, for a one-off event's guest, who has no family
 * doc to keep a vendusClientId on (adhocEvents.ts). Unlike createOrUpdateClient
 * it never PATCHes a client it finds: a guest typing a NIF that is already on a
 * client (a KidClub family's, say) must not rename or re-email that client.
 * Creating one goes through the daily cap (createClient).
 */
export async function findOrCreateClientByNif(payload: VendusClientPayload & { fiscal_id: string }, label: string): Promise<number> {
  const found = await findClientByNif(payload.fiscal_id);
  if (found) return found.id;
  try {
    return (await createClient(payload, label)).id;
  } catch (err: any) {
    if (isDuplicateNif(err)) {
      const again = await findClientByNif(payload.fiscal_id);
      if (again) return again.id;
    }
    throw err;
  }
}

export interface VendusTaxLine {
  id: number;
  title: string;
  value: number;      // tax rate, e.g. 23 or 6
  incidence: string;  // base amount (before tax), as decimal string
  total: string;      // tax amount, as decimal string
}

export interface VendusDocumentFull extends VendusDocument {
  taxes?: VendusTaxLine[];
}

const LIST_PAGE_SIZE = 50;
// 40 pages x 50 = 2000 FR documents in one range: far above a KidClub quarter.
// Hitting it throws rather than returning a short list, because a truncated
// list would silently understate getKidclubVatSummary's totals.
const LIST_MAX_PAGES = 40;

/**
 * Vendus's "no rows" answer to a list query: 404 with errors[].code "A001"
 * (body `{"errors":[{"code":"A001","message":"No data"}]}`, checked against
 * live Vendus 2026-10-25 on an empty range). Any other 404 is a real error.
 */
function isNoData(status: number, data: any): boolean {
  return status === 404 && Array.isArray(data?.errors) && data.errors.some((e: any) => e?.code === "A001");
}

/**
 * List FR documents dated dateFrom..dateTo (YYYY-MM-DD, both inclusive).
 * Handles Vendus pagination, capped at LIST_MAX_PAGES requests.
 *
 * The date filters are `since`/`until`. `date_from`/`date_to` are rejected
 * with 403 P001 "O campo date_from não é permitido" (checked against live
 * Vendus 2026-10-25). `per_page` is sent explicitly, because the
 * `rows.length < LIST_PAGE_SIZE` stop condition depends on it.
 *
 * An empty page comes back as 404 A001 (see isNoData), not as `[]`: that ends
 * the list, so a range with no FRs is `[]` and an exact multiple of 50 stops
 * on the empty page after it. Every other non-2xx throws.
 */
export async function listDocuments(dateFrom: string, dateTo: string): Promise<VendusDocument[]> {
  const all: VendusDocument[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      since: dateFrom,
      until: dateTo,
      type: "FR",
      per_page: String(LIST_PAGE_SIZE),
      page: String(page),
    });
    const path = `/documents/?${query.toString()}`;
    const { ok, status, data } = await send("GET", path);
    if (!ok) {
      if (isNoData(status, data)) return all;
      throw failure("GET", path, status, data);
    }
    const chunk = data as VendusDocument[] | { data?: VendusDocument[] };
    const rows = Array.isArray(chunk) ? chunk : (chunk as any).data ?? [];
    if (!rows.length) return all;
    all.push(...rows);
    if (rows.length < LIST_PAGE_SIZE) return all;
  }
  throw new Error(
    `[Vendus] listDocuments ${dateFrom}..${dateTo}: still full after ${LIST_MAX_PAGES} pages ` +
    `(${all.length} documents); stopping rather than returning a partial list`
  );
}

/** Fetch a single document with full tax breakdown. */
export async function getDocumentFull(id: number): Promise<VendusDocumentFull> {
  return request<VendusDocumentFull>("GET", `/documents/${id}/`);
}

/**
 * Issue a Fatura-Recibo. `client` null: no `client` field at all, so Vendus
 * issues it to "Consumidor final" (families without a NIF). Verified on live
 * Vendus 2026-10-13: a test-mode FR with no client returned 201 with
 * `client: null`, and no client was created.
 */
export async function createInvoice(
  client: VendusClient | null,
  items: VendusLineItem[],
  date: string,
  paymentMethodId: number,
  amount: number,
  notes?: string,
): Promise<VendusDocument> {
  return request<VendusDocument>("POST", "/documents/", {
    type: "FR",
    date,
    register_id: registerId(),
    ...(client ? { client } : {}),
    items,
    payments: [{ id: paymentMethodId, amount }],
    ...(notes ? { notes } : {}),
  });
}

/**
 * Download a document's PDF. Documented in the Vendus v1.1 spec
 * (https://www.vendus.pt/ws/v1.1/api.jsonapi, GET /documents/{id}): "To obtain
 * a pdf version, just add .pdf extension to the document's id" — the API's
 * general "append the format to the endpoint name" convention.
 *
 * One attempt, hard timeout, no retry: callers cache the result (see
 * invoicePdf.ts) so each invoice is fetched from Vendus once.
 */
export async function getDocumentPdf(id: number, timeoutMs = 15000): Promise<Buffer> {
  assertExternalCallsAllowed("Vendus");
  const path = `/documents/${id}.pdf`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`Vendus GET ${path} failed (${res.status}): ${buf.toString("utf8", 0, 300)}`);
  }
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error(`Vendus GET ${path} did not return a PDF (content-type=${res.headers.get("content-type")}): ${buf.toString("utf8", 0, 300)}`);
  }
  return buf;
}
