/**
 * Party Booking - linked to Family and Child
 */
export interface Booking {
  id: string;
  familyId: string; // Required - links to Family
  childId: string; // Required - links to Child
  
  // Event details
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  status: 'pending' | 'confirmed' | 'rejected';
  
  // Child information (denormalized)
  childName: string;
  childAge: number;
  
  // Party details
  partyType: string;
  numKids: number;
  extras?: string[];
  /** Quantity per extra name, for per-unit extras. A listed extra with no entry counts as 1. */
  extrasDetail?: Record<string, number>;
  
  // Pricing
  /** Before IVA. Use partyVatBreakdown(total) for the IVA and the amount the family pays. */
  total: number;
  
  // Contact information (from family)
  parentName: string;
  phone: string;
  email: string;
  
  // Metadata
  createdAt: Date;
  statusReason?: string;
  statusHistory?: Array<{
    status: 'pending' | 'confirmed' | 'rejected';
    timestamp: Date;
    reason?: string;
  }>;
}
