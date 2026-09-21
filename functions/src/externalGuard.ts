// Hard circuit breaker: kidclub-dev must never be able to reach real
// external systems (Vendus, EasyPay, Gmail send), even though its secrets
// currently hold the SAME live credentials as prod (confirmed 2026-09-21 -
// no sandbox distinction was ever wired up, despite CLAUDE.md's
// sandbox-first-billing rule). Deliberately blunt: "broken in dev" is
// preferable to "real invoice/charge/email sent from a test." This is a
// stopgap, not the real fix - see apps/noisyphocus/kidclub/STATUS.md for
// what actually fixing this looks like (real Vendus/EasyPay sandbox
// credentials in kidclub-dev, EASYPAY_SANDBOX=true there).
const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const ALLOWED_PROJECT = "rainbow-prod-2454b";

export function assertExternalCallsAllowed(system: string): void {
  if (PROJECT_ID !== ALLOWED_PROJECT) {
    throw new Error(
      `[external-guard] Blocked a real ${system} call from project "${PROJECT_ID ?? "(unknown)"}" ` +
      `- only ${ALLOWED_PROJECT} may reach live external systems right now. ` +
      "See apps/noisyphocus/kidclub/STATUS.md for why and how to fix this properly."
    );
  }
}
