import { doc, getDoc, collection, getDocs, query, where, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { TransportationConfig, TransportationSubscription } from '@shared/models/Transportation';
import { StudyRoomEntry } from '@shared/models';

const CONFIG_ID = 'transportation';

export const getTransportationConfig = async (): Promise<TransportationConfig | null> => {
  const docRef = doc(db, 'config', CONFIG_ID);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data() as TransportationConfig;
  }
  return null;
};

export const saveTransportationConfig = async (config: TransportationConfig): Promise<void> => {
  const docRef = doc(db, 'config', CONFIG_ID);
  await setDoc(docRef, config, { merge: true });
};

export const getActiveTransportationSubscriptions = async (): Promise<TransportationSubscription[]> => {
  const q = query(collection(db, 'transportationSubscriptions'), where('status', '==', 'active'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() } as TransportationSubscription));
};

export const getTransportBooking = async (
  bookingId: string,
  type: 'study' | 'subscription'
): Promise<StudyRoomEntry | TransportationSubscription | null> => {
  const collectionName = type === 'study' ? 'studyroom' : 'transportationSubscriptions';
  const docSnap = await getDoc(doc(db, collectionName, bookingId));
  if (docSnap.exists()) {
    return { id: docSnap.id, ...docSnap.data() } as StudyRoomEntry | TransportationSubscription;
  }
  return null;
};
