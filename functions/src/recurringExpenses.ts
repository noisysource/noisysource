import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';

// Inlined from @shared/models to avoid runtime module resolution issues in Cloud Functions
interface Expense {
  id?: string;
  description: string;
  amount: number;
  category: string;
  notes?: string;
  date: Timestamp | Date;
  createdAt: Timestamp | Date;
  isRecurring?: boolean;
  recurrenceFrequency?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  recurrenceEndDate?: Timestamp | Date;
}

// Real deployment is us-central1 (verified via `firebase functions:list`), not
// Terraform's europe-west3, which is an inert placeholder for this function —
// see functions/src/OrgDataTools.ts's comment for the full story.
export const createRecurringExpenses = onSchedule({ schedule: 'every 24 hours', region: 'us-central1' }, async (context) => {
  const db = admin.firestore();
  const expensesRef = db.collection('expenses');

  const recurringExpensesSnapshot = await expensesRef
    .where('isRecurring', '==', true)
    .get();

  const batch = db.batch();
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Normalize to start of day

  for (const doc of recurringExpensesSnapshot.docs) {
    const expense = doc.data() as Expense;

    if (expense.category === 'Salários') {
      console.log(`Skipping recurring expense ${expense.id} because it is a salary.`);
      continue;
    }

    if (!expense.recurrenceFrequency || !expense.date) {
      console.warn(`Skipping recurring expense ${expense.id} due to missing frequency or date.`);
      continue;
    }

    const lastOccurrenceDate = expense.date instanceof Timestamp ? expense.date.toDate() : new Date(expense.date);
    lastOccurrenceDate.setHours(0, 0, 0, 0); // Normalize to start of day

    let nextOccurrenceDate = new Date(lastOccurrenceDate);
    let shouldCreateNew = false;

    switch (expense.recurrenceFrequency) {
      case 'daily':
        nextOccurrenceDate.setDate(lastOccurrenceDate.getDate() + 1);
        shouldCreateNew = nextOccurrenceDate.getTime() <= today.getTime();
        break;
      case 'weekly':
        nextOccurrenceDate.setDate(lastOccurrenceDate.getDate() + 7);
        shouldCreateNew = nextOccurrenceDate.getTime() <= today.getTime();
        break;
      case 'monthly':
        nextOccurrenceDate.setMonth(lastOccurrenceDate.getMonth() + 1);
        shouldCreateNew = nextOccurrenceDate.getTime() <= today.getTime();
        break;
      case 'yearly':
        nextOccurrenceDate.setFullYear(lastOccurrenceDate.getFullYear() + 1);
        shouldCreateNew = nextOccurrenceDate.getTime() <= today.getTime();
        break;
    }

    // Check recurrence end date
    if (expense.recurrenceEndDate) {
      const endDate = expense.recurrenceEndDate instanceof Timestamp ? expense.recurrenceEndDate.toDate() : new Date(expense.recurrenceEndDate);
      endDate.setHours(0, 0, 0, 0); // Normalize to start of day
      if (nextOccurrenceDate.getTime() > endDate.getTime()) {
        console.log(`Recurring expense ${expense.id} has reached its end date.`);
        // Optionally, you might want to set isRecurring to false here
        // batch.update(doc.ref, { isRecurring: false });
        continue;
      }
    }

    if (shouldCreateNew) {
      const newExpense: Omit<Expense, 'id'> = {
        description: expense.description,
        amount: expense.amount,
        category: expense.category,
        notes: expense.notes,
        date: Timestamp.fromDate(nextOccurrenceDate),
        createdAt: Timestamp.now(),
        isRecurring: true,
        recurrenceFrequency: expense.recurrenceFrequency,
        recurrenceEndDate: expense.recurrenceEndDate,
      };
      batch.set(expensesRef.doc(), newExpense);

      // Update the original expense's date to the new occurrence date
      batch.update(doc.ref, { date: Timestamp.fromDate(nextOccurrenceDate) });
      console.log(`Created new instance for recurring expense ${expense.id} for date ${nextOccurrenceDate.toISOString().split('T')[0]}`);
    }
  }

  await batch.commit();
  console.log('Recurring expense check completed.');
});
