/**
 * payload.ts — what a save writes to Firestore, and how it compares with what's there.
 * Pure (no Firestore import), so the importer's preview logic is testable.
 */

/** Removes undefined at any depth (Firestore rejects it). Dates are kept as they are. */
export const stripUndefinedDeep = <T>(v: T): T => {
  if (Array.isArray(v)) return v.map(stripUndefinedDeep) as any;
  if (v instanceof Date) return v;
  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v as any)) {
      if (val === undefined) continue;
      out[k] = stripUndefinedDeep(val as any);
    }
    return out;
  }
  return v;
};

/** null → undefined at any depth, so a cleared field is left out rather than stored as null. */
export const nullsToUndefinedDeep = <T>(v: T): T => {
  if (Array.isArray(v)) return v.map(nullsToUndefinedDeep) as any;
  if (v instanceof Date) return v;
  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v as any)) {
      out[k] = val === null ? undefined : nullsToUndefinedDeep(val as any);
    }
    return out;
  }
  return v === null ? (undefined as any) : v;
};

/** Dates and Firestore Timestamps → ISO strings, object keys sorted: comparable as JSON. */
function canonical(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof (v as any).toDate === "function") return (v as any).toDate().toISOString();
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as any)[k];
      if (val !== undefined) out[k] = canonical(val);
    }
    return out;
  }
  return v;
}

export type PayloadDiff = {
  status: "create" | "update" | "unchanged";
  /** Top-level fields the write would change (all of them for a create). */
  changed: string[];
};

/**
 * Compares a payload with the stored document, field by field, as a merge write would apply it:
 * only the payload's fields count; fields the payload doesn't set (createdAt, a balance set by a
 * statement import, attachments) are left alone and ignored here.
 */
export function diffPayload(existing: Record<string, unknown> | undefined, payload: Record<string, unknown>): PayloadDiff {
  const keys = Object.keys(payload);
  if (!existing) return { status: "create", changed: keys };
  const changed = keys.filter(k => JSON.stringify(canonical(existing[k])) !== JSON.stringify(canonical(payload[k])));
  return { status: changed.length ? "update" : "unchanged", changed };
}
