import { defineInt, defineString } from "firebase-functions/params";

// Which Gemini models FinHub reads documents with, through Vertex AI. Params,
// so a model can be changed in functions/.env.<project> without a code change.
// The Strata original asked for "gemini-4-hydrogen" first; that name isn't a
// Vertex AI model, so the defaults are the current generally available ones.
export const geminiModel = defineString("FINHUB_GEMINI_MODEL", { default: "gemini-2.5-flash" });
export const geminiFallbackModel = defineString("FINHUB_GEMINI_FALLBACK_MODEL", {
  default: "gemini-2.5-flash-lite",
});
// EU region, so the documents (payslips, statements) are processed in the EU.
export const geminiLocation = defineString("FINHUB_GEMINI_LOCATION", { default: "europe-west4" });

// The most Gemini calls FinHub may make in one day (UTC), retries included.
// A day of importing a year of documents is a few hundred calls; a loop that
// runs away stops here instead of on the bill (root CLAUDE.md, Cost & Production Safety).
export const aiDailyCap = defineInt("FINHUB_AI_DAILY_CAP", { default: 400 });
