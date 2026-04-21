export function cleanUndefined<T>(obj: T): T {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(cleanUndefined) as any;
  const out: any = {};
  for (const [k, v] of Object.entries(obj as any)) {
    if (v === undefined) continue;
    out[k] = cleanUndefined(v);
  }
  return out;
}

export function cleanUndefinedShallow<T>(obj: T): T {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out: any = {};
  for (const [k, v] of Object.entries(obj as any)) if (v !== undefined) out[k] = v;
  return out;
}