import * as admin from "firebase-admin";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

export const APP_ROOT = db.doc("_apps/arcoiris");
export const appCol = (name: string) => APP_ROOT.collection(name);
