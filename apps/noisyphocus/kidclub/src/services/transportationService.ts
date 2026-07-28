import { getDoc, getDocs, query, where, setDoc } from 'firebase/firestore';
import { col, docRef } from '../lib/db';
import { TransportationConfig, TransportationSubscription } from '@shared/models/Transportation';
import { StudyRoomEntry } from '@shared/models';

const CONFIG_ID = 'transportation';

export const getTransportationConfig = async (): Promise<TransportationConfig | null> => {
  const configRef = docRef('config', CONFIG_ID);
  const docSnap = await getDoc(configRef);
  if (docSnap.exists()) {
    return docSnap.data() as TransportationConfig;
  }
  return null;
};

export const saveTransportationConfig = async (config: TransportationConfig): Promise<void> => {
  const configRef = docRef('config', CONFIG_ID);
  await setDoc(configRef, config, { merge: true });
};

export const getActiveTransportationSubscriptions = async (): Promise<TransportationSubscription[]> => {
  const q = query(col('transportationSubscriptions'), where('status', '==', 'active'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() } as TransportationSubscription));
};

export const getTransportBooking = async (
  bookingId: string,
  type: 'study' | 'subscription'
): Promise<StudyRoomEntry | TransportationSubscription | null> => {
  const collectionName = type === 'study' ? 'studyroom' : 'transportationSubscriptions';
  const docSnap = await getDoc(docRef(collectionName, bookingId));
  if (docSnap.exists()) {
    return { id: docSnap.id, ...docSnap.data() } as StudyRoomEntry | TransportationSubscription;
  }
  return null;
};
