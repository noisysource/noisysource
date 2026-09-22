// Easypay v2 API client
// Docs: https://api.prod.easypay.pt/docs
// Credentials come from Firebase secrets: EASYPAY_ACCOUNT_ID, EASYPAY_API_KEY

import { assertExternalCallsAllowed } from "../externalGuard";

const EASYPAY_BASE = process.env.EASYPAY_SANDBOX === "true"
  ? "https://api.test.easypay.pt/2.0"
  : "https://api.prod.easypay.pt/2.0";

function easypayHeaders(): Record<string, string> {
  const accountId = process.env.EASYPAY_ACCOUNT_ID;
  const apiKey = process.env.EASYPAY_API_KEY;
  if (!accountId || !apiKey) throw new Error("Easypay credentials not configured");
  return {
    "Content-Type": "application/json",
    "AccountId": accountId,
    "ApiKey": apiKey,
  };
}

function webhookUrl(): string | undefined {
  return process.env.EASYPAY_WEBHOOK_URL || undefined;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  assertExternalCallsAllowed("EasyPay");
  console.log(`[Easypay] POST ${path} body:`, JSON.stringify(body));
  const res = await fetch(`${EASYPAY_BASE}${path}`, {
    method: "POST",
    headers: easypayHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Easypay ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EasypayCustomer {
  name: string;
  email: string;
  phone?: string;           // national number only, e.g. "912517488"
  phone_indicative?: string; // country code, e.g. "351"
}

export interface EasypaySingleResponse {
  id: string;
  method: {
    // MBWay: alias, status
    alias?: string;
    status?: string;
    // Multibanco: entity, reference, last_four (expiry)
    entity?: string;
    reference?: string;
    // Card: url
    url?: string;
  };
}

// EasyPay v2 sends two webhook calls per payment to the notification_url:
//   Call 1 (capture status): { id, type: "capture", status: "success"|"failed"|"expired" }
//   Call 2 (payment details): { id, value, method, transaction: { type: "capture", values: { paid } } }
export interface EasypayWebhookPayload {
  id?: string;            // payment UUID (actual v2 format)
  type?: string;          // "capture" | "sale"
  status?: string;        // "success" | "failed" | "expired"
  value?: string | number;
  method?: string;
  transaction?: {
    id: string;
    type: string;
    values?: { paid?: string | number };
  };
}

// ── MBWay single payment ──────────────────────────────────────────────────────

function extractNationalPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  // Strip 351 country code if present
  if (digits.startsWith("351") && digits.length > 9) return digits.slice(3);
  return digits;
}

export async function createMbwayPayment(
  customer: EasypayCustomer,
  value: number,
  descriptive: string,
): Promise<EasypaySingleResponse> {
  const formattedCustomer = {
    ...customer,
    phone: customer.phone ? extractNationalPhone(customer.phone) : undefined,
    phone_indicative: "351",
  };
  const url = webhookUrl();
  return post<EasypaySingleResponse>("/single", {
    type: "sale",
    value,
    currency: "EUR",
    capture: { descriptive },
    customer: formattedCustomer,
    payment: { type: "sale", capture_now: true },
    method: "mbw",
    ...(url ? { notification_url: url } : {}),
  });
}

// ── Multibanco reference ──────────────────────────────────────────────────────

export async function createMultibancoPayment(
  customer: EasypayCustomer,
  value: number,
  descriptive: string,
  expiryDate: string, // "YYYY-MM-DD HH:MM"
): Promise<EasypaySingleResponse> {
  const url = webhookUrl();
  return post<EasypaySingleResponse>("/single", {
    type: "sale",
    value,
    currency: "EUR",
    capture: { descriptive },
    customer,
    payment: {
      type: "sale",
      expiration_time: expiryDate,
    },
    method: "mb",
    ...(url ? { notification_url: url } : {}),
  });
}

// ── Card pay-by-link ──────────────────────────────────────────────────────────

export async function createCardPayment(
  customer: EasypayCustomer,
  value: number,
  descriptive: string,
): Promise<EasypaySingleResponse> {
  const url = webhookUrl();
  return post<EasypaySingleResponse>("/single", {
    type: "sale",
    value,
    currency: "EUR",
    capture: { descriptive },
    customer,
    payment: { type: "sale", capture_now: true },
    method: "cc",
    ...(url ? { notification_url: url } : {}),
  });
}

// ── Subscription (recurring mandate) ─────────────────────────────────────────

export interface EasypaySubscriptionResponse {
  id: string;
  status: string;
}

export async function createSubscription(
  customer: EasypayCustomer,
  value: number,
  descriptive: string,
  startDate: string, // "YYYY-MM-DD"
): Promise<EasypaySubscriptionResponse> {
  return post<EasypaySubscriptionResponse>("/subscription", {
    method: "mbw", // or "cc" for card
    customer,
    value,
    currency: "EUR",
    frequency: "1M",
    max_captures: 0, // indefinite
    start_time: startDate,
    capture: {
      descriptive,
      capture_now: false,
    },
  });
}
