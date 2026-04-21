import { Timestamp } from 'firebase/firestore';

export interface Event {
  id: string;
  title: string;
  start: Timestamp;
  end: Timestamp;
  type: 'party' | 'study' | 'transport' | 'financial';
  transportType?: 'study' | 'subscription';
  resourceId?: string;
  bookingId: string;
  status: 'confirmed' | 'pending' | 'canceled';
}
