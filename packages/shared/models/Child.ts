/**
 * Represents a child/student that belongs to a family
 * Children can have multiple subscriptions (study room, transport, etc.)
 */
export interface Child {
  id: string;
  familyId: string; // Required - links to Family
  
  // Child information
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  age?: number; // Calculated field, can be computed from dateOfBirth
  
  // School information
  schoolName?: string;
  schoolYear?: string;
  schoolGrade?: string;
  
  // Contact information (if different from family)
  contactPhone?: string;
  contactEmail?: string;
  
  // Medical/Allergy notes (optional, for safety)
  medicalNotes?: string;
  allergies?: string[];
  
  // Status
  status: 'active' | 'inactive' | 'graduated';
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  notes?: string;
}
