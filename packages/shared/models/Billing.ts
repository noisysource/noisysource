import { Timestamp } from 'firebase/firestore';

export type BillingPaymentMethod = 'mbway' | 'multibanco' | 'card' | 'subscription';

export type BillingStatus =
  | 'pending'     // billing record created, payment not yet initiated
  | 'processing'  // payment initiated with Easypay, awaiting confirmation
  | 'paid'        // Easypay confirmed payment
  | 'invoiced'    // Vendus invoice created and emailed
  | 'failed'      // payment failed or expired
  | 'dry-run';    // test record, no real payment

export interface BillingLineItem {
  title: string;
  amount: number;
}

export interface BillingRecord {
  id: string;
  familyId: string;
  userId: string;

  periodLabel: string;
  periodStart: Timestamp;
  periodEnd: Timestamp;
  dueDate: Timestamp;

  total: number;
  lineItems: BillingLineItem[];

  billingName: string;
  billingEmail: string;

  paymentMethod: BillingPaymentMethod;

  status: BillingStatus;

  // Easypay
  easypayId?: string;

  // Multibanco
  multibancoEntity?: string;
  multibancoReference?: string;
  multibancoExpiry?: Timestamp;

  // Card / pay-by-link
  paymentLink?: string;

  // Outcome
  paidAt?: Timestamp;
  invoiceNumber?: string;
  vendusId?: number;
  atcud?: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}
