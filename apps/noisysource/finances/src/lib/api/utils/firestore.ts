import type { DocumentSnapshot } from "firebase/firestore";
import { asDate } from "./dates";

/** Safely read a date-like field from a doc data. */
export function readDateField(x: any, field: string): Date | undefined {
  return asDate(x?.[field]);
}

/** Helper to read createdAt if present. */
export function readCreatedAt(x: any): Date | undefined {
  return asDate(x?.createdAt);
}

/** Minimal mapper: {id, ...data} */
export function snapToModel<T = any>(d: DocumentSnapshot, map?: (raw: any, id: string) => T): T {
  const raw = d.data() as any;
  return map ? map(raw, d.id) : ({ id: d.id, ...(raw || {}) } as T);
}