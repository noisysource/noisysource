import { Timestamp } from 'firebase/firestore';

/**
 * Represents a family/account that groups all children and their subscriptions
 * All subscriptions and invoices are linked to the family account
 */
export interface Family {
  id: string;
  
  // Primary contact (parent/guardian)
  primaryContact: {
    name: string;
    email: string;
    phone: string;
    userId: string; // Links to Firebase Auth user
  };
  
  // Billing information
  billingAddress?: {
    street: string;
    city: string;
    postalCode: string;
    country?: string;
  };
  
  // Payment preferences
  defaultPaymentMethod?: string;
  paymentTerms?: 'monthly' | 'quarterly' | 'annual';
  
  // Account status
  status: 'active' | 'inactive' | 'suspended';
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  notes?: string;
}
