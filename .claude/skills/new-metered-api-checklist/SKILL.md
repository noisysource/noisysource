---
name: new-metered-api-checklist
description: Use before writing the first call to a new external metered API (Google Maps/Places/Routes, Netatmo, Tuya, Vendus, EasyPay, or any other paid third-party API), or when a task involves adding a new external API integration.
---

# New metered-API integration checklist

This codebase had a real ~€500 surprise charge from an uncapped, unrelated Google API (Routes), and a related retry-loop bug already showed up once in the domotics bridge. Both of those are why this exists. The goal: a mistake costs a disabled feature, never surprise money. Work through this before or while writing the integration, not after.

1. **Set a hard cap at the provider, not just an alert.** A GCP budget alert (or equivalent) that arrives after the spend isn't enough — set an actual quota/cap that makes the call fail once exceeded. Do this before the first real call ships, not as a follow-up.
2. **Add an explicit max-retry/backoff in code.** Any loop, poll, or retry against the API needs a hard ceiling — no unbounded `while` or recursive retry. This is the exact bug class that caused the €500 incident and the domotics bridge issue.
3. **Add a per-run or per-day call cap in code where feasible**, on top of the provider-side quota — don't rely on the provider limit alone.
4. **Never call it in a tight loop or on every keystroke without debounce** — this specific pattern (autocomplete/search-as-you-type hitting a metered API per keystroke) is called out by name in the kidclub agent's rules for a reason.
5. **Credentials**: never hardcode the API token/secret into a command, a settings file, or an "always allow" permission rule — reference it via an env var or `firebase functions:secrets`. A token inline in a shell command becomes an auto-approved, remembered secret.
6. **If it's a billing/invoicing API (Vendus, EasyPay)**, use sandbox-first-billing instead of (or in addition to) this checklist — that skill covers the sandbox-vs-live distinction specifically.
7. **Note the new integration and its cap/quota decisions in the relevant app's `STATUS.md`** — the next person picking this up cold needs to know a cap exists and what it's set to, not just that the feature works.
