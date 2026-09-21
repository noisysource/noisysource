import { Timestamp } from 'firebase/firestore';

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval?: number;         
  endDate?: Date;            
  dayOfMonth?: number;       
  dayOfWeek?: number;       
}

// Orthogonal to `eventKind`:
// - `tier` says whether the underlying subscription/booking is COMMITTED
//   (active/confirmed) or still PIPELINE (pending — could convert, could
//   cancel; not yet real).
// - `eventKind` says whether the money has actually landed (`effective`) or
//   is merely expected (`planned`).
// An `effective` event should only ever exist for something that was
// `committed` — pipeline money can't be "effective", it isn't real yet.
export type FinancialEventTier = 'committed' | 'pipeline';

export interface FinancialEvent {
  id: string;
  label: string;
  amount: number;
  type: 'income' | 'expense';
  currency: string;
  date: Timestamp;
  accountId: string;
  createdBy: string;
  effective: boolean;
  createdAt: Date;
  eventKind?: 'effective' | 'planned' | 'recurring';
  // Formalizes the deterministic-ID pattern already used ad hoc (e.g.
  // `study_${entry.id}_${dateStr}`) — which Firestore collection/document
  // this event was generated from, so an `effective` event emitted later
  // (e.g. from a paid `billing` record) can be traced back to the
  // `planned`/committed event it corresponds to via the same `sourceId`.
  // Optional for backward-compat with legacy events (e.g. driver/teacher
  // wage forecasts) written before this field existed — new event-generating
  // code should always set both.
  sourceCollection?: string;
  sourceId?: string;
  tier?: FinancialEventTier;
  recurrence?: RecurrenceRule;
  recurrenceSourceId?: string
  workerId?: string;
  workerName?: string;
  startTime?: Timestamp;
  endTime?: Timestamp;
  totalHours?: number;
  category?: string;
}