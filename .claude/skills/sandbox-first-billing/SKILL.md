---
name: sandbox-first-billing
description: Use whenever working on Vendus or EasyPay integration code, or anything that creates invoices, documents, or payments.
---

# Sandbox-first for billing integrations

Vendus and EasyPay both have sandbox/test environments. Any dev or staging work must use them, never the live endpoints, so test activity never pollutes real invoices or moves real money.

1. Check which environment variable selects sandbox vs. live for the integration you're touching (per `.env.staging` / `.env.production` conventions in the relevant app) before writing or running any code that calls Vendus or EasyPay.
2. Never hardcode a live API token into a shell command, a script, or a Claude Code permission/allow-list entry — reference it via `firebase functions:secrets` or an env var. A live token that ends up in `.claude/settings.local.json` or similar is a standing credential leak, not just a one-off convenience.
3. If you must verify against the live endpoint (e.g. confirming a real invoice renders correctly), say so explicitly, do the minimum necessary calls, and flag it to Renato rather than looping/retrying against the live API.
4. Known open item (see NOTES.md): some invoices were created as type FT instead of FR. If your task touches invoice creation, double-check the invoice type being set matches the intended type before deploying.
