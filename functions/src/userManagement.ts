import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";

function assertOwner(request: { auth?: { uid: string } }) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
}

async function assertOwnerRole(uid: string) {
  const snap = await admin.firestore().collection("users").doc(uid).get();
  const roles = snap.data()?.roles ?? {};
  if (!roles.owner && !roles.finhubAdmin) {
    throw new HttpsError("permission-denied", "Owner or finhubAdmin role required.");
  }
}

export const lookupUserByEmail = onCall<{ email: string }>(
  { region: "europe-west3" },
  async ({ data, auth }) => {
    assertOwner({ auth });
    await assertOwnerRole(auth!.uid);

    try {
      const user = await admin.auth().getUserByEmail(data.email);
      return { uid: user.uid, email: user.email, name: user.displayName ?? "" };
    } catch {
      throw new HttpsError("not-found", `No Firebase Auth account for ${data.email}.`);
    }
  }
);
