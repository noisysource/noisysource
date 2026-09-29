// Hard circuit breaker for real external systems (Vendus, EasyPay, Gmail send).
//
// Prod (rainbow-prod-2454b) reaches the live systems. Every other project is
// blocked, unless that system's sandbox flag is set for it — set per project in
// functions/.env.<projectId> (committed; it holds no secrets). With the flag on,
// the client talks to the provider's sandbox (see easypay.ts / vendus.ts), so
// even if a project's secrets still held live credentials, nothing real could
// happen: the sandbox endpoint rejects live keys.
//
// Prod must never run with a sandbox flag: parents would "pay" into a test
// account and receive test invoices. That is refused too.
//
// Gmail has no sandbox, so it stays prod-only.
const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const ALLOWED_PROJECT = "rainbow-prod-2454b";

const SANDBOX_FLAGS: Record<string, string> = {
  EasyPay: "EASYPAY_SANDBOX",
};

export function isSandbox(system: string): boolean {
  const flag = SANDBOX_FLAGS[system];
  return !!flag && process.env[flag] === "true";
}

export function assertExternalCallsAllowed(system: string): void {
  const sandbox = isSandbox(system);
  if (PROJECT_ID === ALLOWED_PROJECT) {
    if (sandbox) {
      throw new Error(`[external-guard] ${SANDBOX_FLAGS[system]}=true on ${ALLOWED_PROJECT} — prod must use the live ${system} account.`);
    }
    return;
  }
  if (sandbox) return;
  throw new Error(
    `[external-guard] Blocked a real ${system} call from project "${PROJECT_ID ?? "(unknown)"}" ` +
    `- only ${ALLOWED_PROJECT} may reach live external systems` +
    (SANDBOX_FLAGS[system] ? `, or set ${SANDBOX_FLAGS[system]}=true in functions/.env.${PROJECT_ID} to use the sandbox.` : ".")
  );
}
