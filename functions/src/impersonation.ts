import * as admin from 'firebase-admin';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
if (!admin.apps.length) {
  admin.initializeApp();
}

// Real deployment is us-central1 (verified via `firebase functions:list`), not
// Terraform's europe-west3, which is an inert placeholder for this function —
// see functions/src/OrgDataTools.ts's comment for the full story. The caller
// (apps/noisyphocus/kidclub/src/pages/admin/EmployeesPage.tsx) must match.
export const impersonateUser = onCall({ region: 'us-central1' }, async (request) => {
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
