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
  extrasDetail?: Record<string, number>;
  
  // Pricing
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
