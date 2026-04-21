import { Timestamp } from "firebase/firestore";

type AnyDate = Date | string | { toDate?: () => Date } | { seconds: number, nanoseconds: number } | undefined | null;

/**
 * Robustly converts any date-like value from Firestore into a JavaScript Date object.
 * Handles Firestore Timestamps, plain objects with seconds/nanoseconds, ISO strings, and existing Date objects.
 */
export const toDate = (v: AnyDate): Date | null => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof (v as any).toDate === 'function') return (v as any).toDate();
  if (typeof (v as any).seconds === 'number' && typeof (v as any).nanoseconds === 'number') {
    return new Timestamp((v as any).seconds, (v as any).nanoseconds).toDate();
  }
  
  const d = new Date(v as any);
  if (!isNaN(d.getTime())) return d;

  return null;
};

/**
 * Recursively traverses an object and converts any Date objects to ISO strings.
 */
export function deepSerializeDates<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (obj instanceof Date) {
    return obj.toISOString() as any;
  }

  if (Array.isArray(obj)) {
    return obj.map(deepSerializeDates) as any;
  }

  if (typeof obj === 'object') {
    const newObj: { [key: string]: any } = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        newObj[key] = deepSerializeDates((obj as any)[key]);
      }
    }
    return newObj as T;
  }

  return obj;
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Recursively traverses an object and converts any ISO date strings to Date objects.
 */
export function deepReviveDates<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string' && ISO_DATE_REGEX.test(obj)) {
    return new Date(obj) as any;
  }

  if (Array.isArray(obj)) {
    return obj.map(deepReviveDates) as any;
  }

  if (typeof obj === 'object') {
    const newObj: { [key: string]: any } = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        newObj[key] = deepReviveDates((obj as any)[key]);
      }
    }
    return newObj as T;
  }

  return obj;
}
