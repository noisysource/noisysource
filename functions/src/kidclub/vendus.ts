import { assertExternalCallsAllowed } from "../externalGuard";
import { reserveVendusClientCreation } from "./vendusClientCap";

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  if (!res.ok) throw new Error(`Vendus ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
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

export interface VendusClientPayload {
  name: string;
  email?: string;
  fiscal_id?: string;
  phone?: string;
  address?: string;
  postalcode?: string;
  city?: string;
  external_reference?: string;
  send_email?: "yes" | "no";
}

export interface VendusClientRecord {
  id: number;
  name: string;
  email: string;
  fiscal_id: string;
  external_reference: string;
}

/** Find client by external_reference (Firebase family ID). Returns null if not found. */
export async function findClientByRef(externalRef: string): Promise<VendusClientRecord | null> {
  try {
    const results = await request<VendusClientRecord[]>(
      "GET", `/clients/?external_reference=${encodeURIComponent(externalRef)}`
    );
    if (!Array.isArray(results) || results.length === 0) return null;
    return results[0];
  } catch (err: any) {
    if (err.message?.includes("(404)")) return null;
    throw err;
  }
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
 * throws without calling Vendus.
 */
export async function createClient(payload: VendusClientPayload): Promise<VendusClientRecord> {
  assertExternalCallsAllowed("Vendus"); // don't count a call the guard would block anyway
  await reserveVendusClientCreation(payload.external_reference || payload.name || "(unnamed)");
  return request<VendusClientRecord>("POST", "/clients/", payload);
}

/** Update an existing Vendus client. */
export async function updateClient(id: number, payload: Partial<VendusClientPayload>): Promise<VendusClientRecord> {
  return request<VendusClientRecord>("PATCH", `/clients/${id}/`, payload);
}

/**
 * Create or update a Vendus client by Firebase family ID, keyed in Vendus by
 * external_reference "family:<familyId>" (set on create and on the NIF re-link).
 * Falls back to NIF lookup when creation fails with duplicate NIF.
 * Returns the Vendus client ID.
 */
export async function createOrUpdateClient(familyId: string, payload: VendusClientPayload): Promise<number> {
  const ref = `family:${familyId}`;

  const existing = await findClientByRef(ref);
  if (existing) {
    await updateClient(existing.id, payload);
    return existing.id;
  }

  try {
    // Always tag the new client with the family ref, so the findClientByRef
    // above finds it next time. Without it, every call for a family with no
    // NIF created another client (2026-10-11 prod loop: 904 in ~7 minutes).
    const created = await createClient({ ...payload, external_reference: ref });
    return created.id;
  } catch (err: any) {
    // Vendus rejects duplicate NIFs — find the existing client and re-link it
    if (payload.fiscal_id && err.message?.includes("duplicado")) {
      console.log(`[Vendus] duplicate NIF ${payload.fiscal_id}, looking up existing client`);
      const byNif = await findClientByNif(payload.fiscal_id);
      if (byNif) {
        await updateClient(byNif.id, { ...payload, external_reference: ref });
        return byNif.id;
      }
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

/** List FR documents in a date range. Handles Vendus pagination automatically. */
export async function listDocuments(dateFrom: string, dateTo: string): Promise<VendusDocument[]> {
  const all: VendusDocument[] = [];
  let page = 1;
  while (true) {
    const chunk = await request<VendusDocument[] | { data?: VendusDocument[] }>(
      "GET", `/documents/?date_from=${dateFrom}&date_to=${dateTo}&type=FR&page=${page}`
    );
    const rows = Array.isArray(chunk) ? chunk : (chunk as any).data ?? [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < 50) break;
    page++;
  }
  return all;
}

/** Fetch a single document with full tax breakdown. */
export async function getDocumentFull(id: number): Promise<VendusDocumentFull> {
  return request<VendusDocumentFull>("GET", `/documents/${id}/`);
}

export async function createInvoice(
  client: VendusClient,
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
    client,
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
