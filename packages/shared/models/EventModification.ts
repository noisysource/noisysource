import { Timestamp } from 'firebase/firestore';

/**
 * Represents a modification to a single occurrence of a subscription-based event
 * This allows parents to cancel or modify individual occurrences without changing
 * the subscription itself (and without changing the subscription price).
 */
export interface EventModification {
  id: string;
  
  // Reference to the event being modified
  eventId: string; // ID of the event in the 'events' collection
  
  // Reference to the subscription that generated this event
  subscriptionId: string;
  subscriptionType: 'study' | 'transport' | 'party';
  
  // Reference to family and child
  familyId: string;
  childId: string;
  
  // The date of the occurrence
  date: Date; // YYYY-MM-DD format
  
  // Modification type
  modificationType: 'cancelled' | 'added' | 'time_changed' | 'location_changed';
  
  // Reason for the modification
  reason?: string;
  
  // Original event details (for reference)
  originalTime?: string;
  newTime?: string;
  originalLocation?: string;
  newLocation?: string;
  
  // Financial impact
  // Note: Cancellations don't change subscription price, but additions might
  affectsPricing: boolean; // true if this modification should affect billing
  
  // Who made the modification
  requestedBy: string; // userId of parent
  requestedByName?: string;
  
  // Status
  status: 'pending' | 'approved' | 'rejected';
  
  // Approval (if needed)
  approvedBy?: string; // userId of admin
  approvedAt?: Date;
  rejectionReason?: string;
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Helper to check if an event is cancelled for a specific date
 */
export function isEventCancelledForDate(
  eventId: string, 
  date: Date, 
  modifications: EventModification[]
): boolean {
  return modifications.some(mod => 
    mod.eventId === eventId &&
    formatDate(mod.date) === formatDate(date) &&
    mod.modificationType === 'cancelled' &&
    mod.status === 'approved'
  );
}

function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString().split('T')[0];
}

