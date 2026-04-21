import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { FeatureFlags } from '@shared/models/FeatureFlags';

const CONFIG_ID = 'featureFlags';

export const getFeatureFlags = async (): Promise<FeatureFlags> => {
  const docRef = doc(db, 'config', CONFIG_ID);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data() as FeatureFlags;
  }
  return {};
};

export const updateFeatureFlags = async (flags: FeatureFlags): Promise<void> => {
  const docRef = doc(db, 'config', CONFIG_ID);
  await setDoc(docRef, flags, { merge: true });
};
