import { Timestamp } from 'firebase/firestore';

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval?: number;         
  endDate?: Date;            
  dayOfMonth?: number;       
  dayOfWeek?: number;       
}

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
  recurrence?: RecurrenceRule;
  recurrenceSourceId?: string
  workerId?: string;
  workerName?: string;
  startTime?: Timestamp;
  endTime?: Timestamp;
  totalHours?: number;
  category?: string;
}