// Cloud Functions of the NoisySource projects (noisysource-dev,
// noisysource-prod): the private tools' backend. KidClub's functions are the
// repo-root /functions codebase, in KidClub's projects.
import * as admin from "firebase-admin";
import { setGlobalOptions } from "firebase-functions/v2";

admin.initializeApp();

// Every function here: Frankfurt, a small instance cap (these are one
// person's tools; a runaway loop should hit a wall, not a bill), and the
// runtime account from Terraform, which can use Firestore and write logs and
// nothing else.
setGlobalOptions({
  region: "europe-west3",
  maxInstances: 3,
  serviceAccount: "functions-runtime@",
});

export { legrandGetStatus, legrandSetState } from "./domotics/legrand";
export { tuyaGetDevices, tuyaSetState } from "./domotics/tuya";
export { domoticsWarmBy } from "./domotics/warmBy";
