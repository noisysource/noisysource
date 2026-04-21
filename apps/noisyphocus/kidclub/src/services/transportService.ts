import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { StudyRoomEntry, TransportationSubscription } from '@shared/models';

export const transportService = {
  async getTransportBooking(
    bookingId: string,
    type: 'study' | 'subscription'
  ): Promise<StudyRoomEntry | TransportationSubscription | null> {
    let docRef;
    if (type === 'study') {
      docRef = doc(db, 'studyroom', bookingId);
    } else {
      docRef = doc(db, 'transportationSubscriptions', bookingId);
    }

    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as StudyRoomEntry | TransportationSubscription;
    } else {
      return null;
    }
  },
};
