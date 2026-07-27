// Easypay v2 API client
// Docs: https://api.prod.easypay.pt/docs
// Credentials come from Firebase secrets: EASYPAY_ACCOUNT_ID, EASYPAY_API_KEY

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

async function post<T>(path: string, body: unknown): Promise<T> {
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
  phone?: string; // required for MBWay
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

export interface EasypayWebhookPayload {
  event: string; // "payment_success" | "payment_failed" | "payment_expired"
  payment: {
    id: string;
    value: number;
    status: string; // "paid" | "failed" | "expired"
    method: string;
  };
}

// ── MBWay single payment ──────────────────────────────────────────────────────

export async function createMbwayPayment(
  customer: EasypayCustomer,
  value: number,
  descriptive: string,
): Promise<EasypaySingleResponse> {
  return post<EasypaySingleResponse>("/single", {
    type: "sale",
    capture: { descriptive },
    customer,
    payment: { type: "sale", capture_now: true, currency: "EUR", value },
    method: "mbw",
  });
}

// ── Multibanco reference ──────────────────────────────────────────────────────

export async function createMultibancoPayment(
  customer: EasypayCustomer,
  value: number,
  descriptive: string,
  expiryDate: string, // "YYYY-MM-DD HH:MM"
): Promise<EasypaySingleResponse> {
  return post<EasypaySingleResponse>("/single", {
    type: "sale",
    capture: { descriptive },
    customer,
    payment: {
      type: "sale",
      currency: "EUR",
      value,
      expiration_time: expiryDate,
    },
    method: "mb",
  });
}

// ── Card pay-by-link ──────────────────────────────────────────────────────────

export async function createCardPayment(
  customer: EasypayCustomer,
  value: number,
  descriptive: string,
): Promise<EasypaySingleResponse> {
  return post<EasypaySingleResponse>("/single", {
    type: "sale",
    capture: { descriptive },
    customer,
    payment: { type: "sale", capture_now: true, currency: "EUR", value },
    method: "cc",
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
