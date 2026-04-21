export type PlannedEventStatus = 'draft' | 'approved' | 'converted';

export interface PlannedEvent {
  id: string;
  label: string;
  amount: number;
  type: 'income' | 'expense';
  currency: string;
  date: Date;
  accountId: string;
  createdBy: string;
  createdAt: Date;
  note?: string;
  status: PlannedEventStatus;
  recurrenceSourceId?: string;
}