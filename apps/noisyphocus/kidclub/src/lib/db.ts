import { collection, doc } from 'firebase/firestore';
import { db } from './firebase';

const APP_ROOT = doc(db, '_apps', 'arcoiris');

export const col = (name: string) => collection(APP_ROOT, name);
export const docRef = (colName: string, docId: string) => doc(collection(APP_ROOT, colName), docId);
