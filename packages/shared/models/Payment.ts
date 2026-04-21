import { Timestamp } from 'firebase/firestore';

/**
 * Payment status types
 */
export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded' | 'cancelled';

/**
 * Payment method types
 */
export type PaymentMethod = 'bank_transfer' | 'credit_card' | 'debit_card' | 'cash' | 'check' | 'other';

/**
 * Payment record
 */
export interface Payment {
  id: string;
  userId: string;
  
  // Invoice reference
  invoiceId: string;
  
  // Payment details
  amount: number;
  currency: string; // e.g., "EUR"
  status: PaymentStatus;
  method: PaymentMethod;
  
  // Transaction details
  transactionId?: string; // External payment gateway transaction ID
  paymentDate: Date;
  processedDate?: Date;
  
  // Payment method details (optional, store minimally)
  paymentMethodDetails?: {
    last4?: string; // Last 4 digits of card
    bankName?: string;
    reference?: string; // Bank reference number
  };
  
  // Notes
  notes?: string;
  
  // Refund information (if applicable)
  refundAmount?: number;
  refundDate?: Date;
  refundReason?: string;
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  
  // Who processed/created this (for admin tracking)
  createdBy?: string;
}












