const BASE_URL = "https://www.vendus.pt/ws/v1.1";

// Stable Vendus product IDs for KidClub services
export const PRODUCT_STUDY = 286916222;    // Serviço de apoio ao ensino (NOR 23%)
export const PRODUCT_TRANSPORT = 286916284; // Serviço Transporte (RED 6%)

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

/** Create a new Vendus client. */
export async function createClient(payload: VendusClientPayload): Promise<VendusClientRecord> {
  return request<VendusClientRecord>("POST", "/clients/", payload);
}

/** Update an existing Vendus client. */
export async function updateClient(id: number, payload: Partial<VendusClientPayload>): Promise<VendusClientRecord> {
  return request<VendusClientRecord>("PATCH", `/clients/${id}/`, payload);
}

/**
 * Create or update a Vendus client by Firebase family ID.
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
    const created = await createClient(payload);
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
