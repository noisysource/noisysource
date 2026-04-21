export function initials(name?: string): string {
  return (name || "")
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0]!.toUpperCase())
    .join("");
}

export function slugify(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Uppercases, trims, collapses spaces — useful for codes. */
export function normalizeCode(s: string): string {
  return (s || "").trim().replace(/\s+/g, "").toUpperCase();
}