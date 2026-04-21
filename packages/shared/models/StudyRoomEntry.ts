import { Timestamp } from "firebase/firestore";

// @shared/models/StudyRoomEntry.ts
export type DaySelection = { day: string; hour: string; transport: boolean };

export type StudyStatus = "pending" | "confirmed" | "canceled" | "archived";

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
  note?: string;
  
  // Pricing
  monthlyPrice: number;
  basePrice?: number;
  transportFee?: number;
  total?: number;
  
  // Dates
  startDate: Date;
  endDate: Date;
  
  // Status
  status: StudyStatus;
  statusReason?: string;
  
  // Transport
  needsTransport: boolean;
  
  // History and tracking
  history?: SubscriptionVersion[];
  uploadedFiles?: UploadedFile[];
  statusHistory?: StatusChangeHistory[];
  entryHistory?: EntryChangeHistory[];
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  
  // Admin fields
  recalculatedMonthlyPrice?: number;
  isOutdated?: boolean;
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
  const s = (raw?.status as StudyStatus) ?? "pending";
  return s === "pending" || s === "confirmed" || s === "canceled" || s === "archived" ? s : "pending";
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
      transport: Boolean(d?.transport),
    }))
    : [],
  note: raw?.note ? String(raw.note) : undefined,
  monthlyPrice: Number(raw?.monthlyPrice ?? 0),
  basePrice: raw?.basePrice === undefined ? undefined : Number(raw.basePrice),
  transportFee: raw?.transportFee === undefined ? undefined : Number(raw.transportFee),
  total: raw?.total === undefined ? undefined : Number(raw.total),
  startDate: toDate(raw?.startDate),
  endDate: toDate(raw?.endDate),
  createdAt: toDate(raw?.createdAt),
  updatedAt: toDate(raw?.updatedAt ?? raw?.createdAt),
  status: normalizeStatus(raw),
  statusReason: raw?.statusReason ? String(raw.statusReason) : undefined,
  needsTransport: Boolean(raw?.needsTransport),
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
    note: input.note,
    monthlyPrice: input.monthlyPrice,
    basePrice: input.basePrice,
    transportFee: input.transportFee,
    total: input.total,
    startDate: input.startDate,
    endDate: input.endDate,
    createdAt: input.createdAt ?? new Date(),
    updatedAt: new Date(),
    needsTransport: input.needsTransport ?? false,
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
    note: input.note,
    monthlyPrice: input.monthlyPrice,
    basePrice: input.basePrice,
    transportFee: input.transportFee,
    total: input.total,
    startDate: input.startDate,
    endDate: input.endDate,
    createdAt: input.createdAt,
    updatedAt: new Date(),
    needsTransport: input.needsTransport,
    status,
    statusReason: input.statusReason,
    history: input.history,
    uploadedFiles: input.uploadedFiles,
    statusHistory: input.statusHistory,
    entryHistory: input.entryHistory,
  });
};
