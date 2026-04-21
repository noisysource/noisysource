import { Timestamp } from 'firebase/firestore';

/**
 * Invoice status types
 */
export type InvoiceStatus = 'draft' | 'pending' | 'paid' | 'overdue' | 'cancelled' | 'refunded';

/**
 * Invoice line item
 */
export interface InvoiceLineItem {
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
    childId?: string; // Which child this line item is for
    childName?: string; // Denormalized for display
    subscriptionType: 'study' | 'transport' | 'party';
    subscriptionId?: string; // Optional reference to subscription
}

/**
 * Family Invoice - aggregates all services for all children
 * One invoice per billing period per family
 */
export interface Invoice {
    id: string;
    familyId: string; // Links to Family account

    // Invoice details
    invoiceNumber: string; // e.g., "INV-2024-001"
    status: InvoiceStatus;
    issueDate: Date;
    dueDate: Date;
    paidDate?: Date;

    // Billing period
    periodStart: Date;
    periodEnd: Date;

    // Financial details
    subtotal: number;
    tax?: number;
    taxRate?: number; // e.g., 0.23 for 23% VAT
    total: number;
    currency: string; // e.g., "EUR"

    // Line items - all services for all children
    lineItems: InvoiceLineItem[];

    // Grouped line items by child (for UI presentation)
    lineItemsByChild: Record<string, InvoiceLineItem[]>; // key = childId

    // Subscription references included in this invoice
    subscriptionItems: Array<{
        subscriptionType: 'study' | 'transport' | 'party';
        subscriptionId: string;
        childId: string;
        childName: string;
    }>;

    // Billing information (from Family account)
    billingName: string;
    billingEmail: string;
    billingPhone?: string;
    billingAddress?: {
        street?: string;
        city?: string;
        postalCode?: string;
        country?: string;
    };

    // Payment reference
    paymentId?: string; // Link to Payment document

    // Metadata
    notes?: string;
    createdAt: Date;
    updatedAt: Date;
}
