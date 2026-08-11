export type InsuranceType =
  | 'health'
  | 'life'
  | 'car'
  | 'home'
  | 'liability'
  | 'work'
  | 'travel'
  | 'other';

export type InsuranceFrequency = 'monthly' | 'quarterly' | 'annual';

export interface InsuranceAttachment {
  id: string;
  name: string;
  storagePath: string;
  downloadUrl: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedAt: string;
}

export interface InsuranceDoc {
  id: string;
  name: string;
  type: InsuranceType;
  insurer: string;
  policyNumber?: string;
  premiumCents: number;
  frequency: InsuranceFrequency;
  startDate?: string;
  renewalDate?: string;
  insuredPersons?: string;
  notes?: string;
  attachments: InsuranceAttachment[];
  active: boolean;
  createdAt?: Date;
}
