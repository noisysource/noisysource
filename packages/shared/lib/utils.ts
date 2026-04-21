// @shared/lib/utils.ts
export const safeDocId = (x: unknown) =>
  String(x ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")     // strip diacritics
    .replace(/[^A-Za-z0-9._-]+/g, "_")   // Firestore-safe
    .slice(0, 200);