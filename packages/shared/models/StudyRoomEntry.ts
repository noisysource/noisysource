import { Timestamp } from "firebase/firestore";

// @shared/models/StudyRoomEntry.ts
import { WeekPattern } from './weekPattern';
export type { WeekPattern };
export type DaySelection = { day: string; hour: string };

// Collapsed to 3 states (pending / active / cancelled) — legacy Firestore
// docs may still hold "confirmed"/"canceled"/"archived"; normalizeStatus()
// below maps them so every consumer only ever sees these three.
export type StudyStatus = "pending" | "active" | "cancelled";

export interface SubscriptionVersion {
  days: DaySelection[];
  basePrice: number;
  transportFee?: number;
  total: number;
  changedAt: Timestamp;
  changeReason: string;
}

export interface UploadedFile {
  name: string;
  url: string;
  uploadedAt: Timestamp;
}

export interface StatusChangeHistory {
  status: StudyStatus;
  reason?: string;
  timestamp: Timestamp;
}

export interface EntryChangeHistory {
  field: string;
  oldValue: any;
  newValue: any;
  reason: string;
  timestamp: Timestamp;
  changedBy?: string;
}

/**
 * Study Room Subscription - linked to Family and Child
 */
export interface StudyRoomEntry {
  id: string;
  familyId: string; // Required - links to Family
  childId: string; // Required - links to Child
  
  // Child information (denormalized for quick access)
  childName: string;
  childAge?: number;
  
  // School information
  schoolYear: string;
  schoolName: string;
  
  // Schedule
  days: DaySelection[];
  weekPattern: WeekPattern;
  note?: string;

  // Pricing
  monthlyPrice: number;
  basePrice?: number;
  total?: number;
  returningStudent?: boolean;
  appliedDiscounts?: import('./Discount').AppliedDiscount[];
  /** Admin overrides of automatic discounts, by rule id. See DiscountOverrides. */
  discountOverrides?: import('./Discount').DiscountOverrides;
  
  // Dates
  startDate: Date;
  endDate: Date;
  
  // Status
  status: StudyStatus;
  statusReason?: string;
  
  // History and tracking
  history?: SubscriptionVersion[];
  uploadedFiles?: UploadedFile[];
  statusHistory?: StatusChangeHistory[];
  entryHistory?: EntryChangeHistory[];

  // Two-way in-app review flags (no email). clientReviewPending: set whenever
  // admin changes this subscription while it's linked to a family — cleared
  // when the client views it. adminReviewPending: set whenever a client-
  // initiated change happens (e.g. a cancel request) — cleared when admin
  // views it. lastClientAction records *what* the client did, so the admin
  // badge can say what to do next instead of one generic "review needed".
  clientReviewPending?: boolean;
  clientReviewedAt?: Date;
  adminReviewPending?: boolean;
  adminReviewedAt?: Date;
  lastClientAction?: 'confirmed' | 'cancelRequested' | 'edited' | 'rejected';

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  
  // Admin fields
  recalculatedMonthlyPrice?: number;
  isOutdated?: boolean;

  // Billing bookkeeping — set once by the billing function itself, never by
  // any client form, when the one-time registration+insurance fee has been
  // billed for this child (on this subscription or their transport one,
  // whichever came first). Deliberately lives on the subscription, not the
  // Child document, so it resets every school year: next year's enrollment
  // is a fresh subscription doc with no such flag.
  enrollmentFeeBilled?: boolean;
}

/** If you have a create/edit form, use this shape when saving */
export type StudyRoomSave = Omit<StudyRoomEntry, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

/* ---------------- Helpers for Firestore ---------------- */

type AnyDate = Date | string | { toDate?: () => Date } | undefined | null;

const toDate = (v: AnyDate): Date => {
  if (v && typeof (v as any).toDate === "function") return (v as any).toDate();
  const d = new Date(v as any);
  return isNaN(d.getTime()) ? new Date() : d;
};

export const normalizeStatus = (raw: any): StudyStatus => {
  const s = raw?.status;
  if (s === "active" || s === "confirmed" || s === "offered") return "active";
  if (s === "cancelled" || s === "canceled" || s === "archived" || s === "inactive") return "cancelled";
  return "pending";
};

export const fromStudyDoc = (raw: any, id: string): StudyRoomEntry => ({
  id,
  familyId: String(raw?.familyId ?? ""),
  childId: String(raw?.childId ?? ""),
  childName: String(raw?.childName ?? ""),
  childAge: raw?.childAge ? Number(raw.childAge) : undefined,
  schoolYear: String(raw?.schoolYear ?? ""),
  schoolName: String(raw?.schoolName ?? ""),
  days: Array.isArray(raw?.days)
    ? raw.days.map((d: any) => ({
      day: String(d?.day ?? ""),
      hour: String(d?.hour ?? ""),
    }))
    : [],
  weekPattern: (raw?.weekPattern ?? 'all') as WeekPattern,
  note: raw?.note ? String(raw.note) : undefined,
  monthlyPrice: Number(raw?.monthlyPrice ?? 0),
  basePrice: raw?.basePrice === undefined ? undefined : Number(raw.basePrice),
  total: raw?.total === undefined ? undefined : Number(raw.total),
  startDate: toDate(raw?.startDate),
  endDate: toDate(raw?.endDate),
  createdAt: toDate(raw?.createdAt),
  updatedAt: toDate(raw?.updatedAt ?? raw?.createdAt),
  status: normalizeStatus(raw),
  statusReason: raw?.statusReason ? String(raw.statusReason) : undefined,
  history: raw?.history || [],
  uploadedFiles: raw?.uploadedFiles || [],
  statusHistory: raw?.statusHistory || [],
  entryHistory: raw?.entryHistory || [],
});

/** Never write undefined to Firestore */
const stripUndef = <T extends Record<string, any>>(o: T): T => {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
};

export const toStudyDoc = (input: Partial<StudyRoomSave>) => {
  const status = normalizeStatus(input);
  return stripUndef({
    familyId: input.familyId,
    childId: input.childId,
    childName: input.childName,
    childAge: input.childAge,
    schoolYear: input.schoolYear,
    schoolName: input.schoolName,
    days: Array.isArray(input.days) ? input.days : [],
    weekPattern: input.weekPattern ?? 'all',
    note: input.note,
    monthlyPrice: input.monthlyPrice,
    basePrice: input.basePrice,
    total: input.total,
    startDate: input.startDate,
    endDate: input.endDate,
    createdAt: input.createdAt ?? new Date(),
    updatedAt: new Date(),
    status,
    statusReason: input.statusReason,
    history: input.history || [],
    uploadedFiles: input.uploadedFiles || [],
    statusHistory: input.statusHistory || [],
    entryHistory: input.entryHistory || [],
  });
};

export const toStudyDocPartial = (input: Partial<StudyRoomSave>) => {
  const status = input.status ? normalizeStatus(input) : undefined;
  return stripUndef({
    familyId: input.familyId,
    childId: input.childId,
    childName: input.childName,
    childAge: input.childAge,
    schoolYear: input.schoolYear,
    schoolName: input.schoolName,
    days: input.days,
    weekPattern: input.weekPattern,
    note: input.note,
    monthlyPrice: input.monthlyPrice,
    basePrice: input.basePrice,
    total: input.total,
    startDate: input.startDate,
    endDate: input.endDate,
    createdAt: input.createdAt,
    updatedAt: new Date(),
    status,
    statusReason: input.statusReason,
    history: input.history,
    uploadedFiles: input.uploadedFiles,
    statusHistory: input.statusHistory,
    entryHistory: input.entryHistory,
  });
};
