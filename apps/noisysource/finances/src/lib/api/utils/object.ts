// Lightweight utils you can grow later
export const isObj = (v: any) => v && typeof v === "object" && !Array.isArray(v);

// Firestore Timestamp-like = has toDate()
export const isTimestampLike = (v: any) => !!(v && typeof v?.toDate === "function");

// Convert Firestore Timestamps & Dates into ISO strings (JSON-safe)
export function deepSerializeDates(x: any): any {
  if (isTimestampLike(x)) return x.toDate().toISOString();
  if (x instanceof Date)  return x.toISOString();
  if (Array.isArray(x))   return x.map(deepSerializeDates);
  if (isObj(x)) {
    const out: any = {};
    for (const [k, v] of Object.entries(x)) out[k] = deepSerializeDates(v);
    return out;
  }
  return x;
}