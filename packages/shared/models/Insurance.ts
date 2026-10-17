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
  /**
   * The premium repeats (monthly/quarterly/annual) and is a recurring expense in Recorrentes and the
   * forecast. false = paid only at contract or renewal (e.g. a works policy): kept as a record, no
   * recurring entry. Absent = true.
   */
  recurring?: boolean;
  createdAt?: Date;
}
