import { addDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { FinancialEvent, RecurrenceFrequency } from '@shared/models';

interface CreateRecurringEventsOptions {
  label: string;
  amount: number;
  type: 'income' | 'expense';
  currency: string;
  accountId: string;
  createdBy: string;
  startDate: Date;
  endDate?: Date;
  frequency: RecurrenceFrequency;
  dayOfMonth?: number;
}

export const createRecurringEvents = async (options: CreateRecurringEventsOptions) => {
  const {
    label,
    amount,
    type,
    currency,
    accountId,
    createdBy,
    startDate,
    endDate,
    frequency,
    dayOfMonth,
  } = options;

  const recurrenceRef = await addDoc(collection(db, 'recurrenceMetadata'), {
    label,
    amount,
    type,
    currency,
    accountId,
    createdBy,
    startDate,
    endDate,
    frequency,
    dayOfMonth,
    createdAt: new Date(),
  });

  const events: Omit<FinancialEvent, 'id'>[] = [];
  let current = new Date(startDate);
  const until = endDate ? new Date(endDate) : new Date(startDate.getFullYear() + 1, 0, 1);

  while (current <= until) {
    const plannedDate = new Date(current);
    const existingEventsQuery = query(
      collection(db, 'financialEvents'),
      where('date', '==', plannedDate),
      where('amount', '==', amount),
      where('accountId', '==', accountId),
      where('type', '==', type),
      where('eventKind', 'in', ['planned', 'effective'])
    );
    const existingEventsSnap = await getDocs(existingEventsQuery);
    const alreadyExists = !existingEventsSnap.empty;

    if (!alreadyExists) {
      const plannedEvent: Omit<FinancialEvent, 'id'> = {
        label,
        amount,
        type,
        currency,
        date: plannedDate,
        accountId,
        createdBy,
        effective: false,
        createdAt: new Date(),
        eventKind: 'planned',
        recurrenceSourceId: recurrenceRef.id,
      };

      events.push(plannedEvent);
    }

    if (frequency === 'monthly') {
      current.setMonth(current.getMonth() + 1);
      if (dayOfMonth) current.setDate(dayOfMonth);
    } else if (frequency === 'yearly') {
      current.setFullYear(current.getFullYear() + 1);
    } else {
      break;
    }
  }

  const batch = events.map(e => addDoc(collection(db, 'financialEvents'), e));
  await Promise.all(batch);
};