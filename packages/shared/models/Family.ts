
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
  nif?: string; // Portuguese tax ID
  billingAddress?: {
    street: string;
    city: string;
    postalCode: string;
    country?: string;
  };

  // Whether the family has completed the onboarding profile setup
  profileComplete?: boolean;

  // Payment preferences
  defaultPaymentMethod?: 'bank_transfer' | 'mbway';
  paymentTerms?: 'monthly' | 'quarterly' | 'annual';

  // Account status
  status: 'active' | 'inactive' | 'suspended';

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  notes?: string;
}
