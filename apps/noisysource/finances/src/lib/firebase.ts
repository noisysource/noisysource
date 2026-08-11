export { auth, db, storage } from '@shared/firebase/firebase';
import { getApp } from 'firebase/app';
import { getFunctions } from 'firebase/functions';
export const functions = getFunctions(getApp(), 'europe-west3');
