import { z } from 'zod';

export const ExpenseSchema = z.object({
  id: z.string().optional(),
  description: z.string(),
  amount: z.number(),
  date: z.any(), // TODO: revisit this to use a custom zod type for Timestamp
  category: z.string(),
  notes: z.string().optional(),
  isRecurring: z.boolean().optional(),
  recurrenceFrequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional(),
  recurrenceEndDate: z.any().optional(), // TODO: revisit this
  createdAt: z.any().optional(), // TODO: revisit this
  updatedAt: z.any().optional(), // TODO: revisit this
});

export type Expense = z.infer<typeof ExpenseSchema>;