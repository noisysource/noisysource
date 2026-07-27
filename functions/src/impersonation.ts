import * as admin from 'firebase-admin';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
if (!admin.apps.length) {
  admin.initializeApp();
}

export const impersonateUser = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }

  const isAdmin = request.auth.token.roles?.includes('rainbowAdmin') || request.auth.token.roles?.includes('owner');

  if (!isAdmin) {
    throw new HttpsError('permission-denied', 'Only admins can impersonate users.');
  }

  const { uid } = request.data;
  if (!uid) {
    throw new HttpsError('invalid-argument', 'The function must be called with a "uid" argument.');
  }

  try {
    const customToken = await admin.auth().createCustomToken(uid);
    return { token: customToken };
  } catch (error) {
    console.error('Error creating custom token:', error);
    throw new HttpsError('internal', 'Unable to create custom token.');
  }
});
