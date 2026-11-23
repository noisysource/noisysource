// Cloud Functions of the NoisySource projects (noisysource-dev,
// noisysource-prod): the private tools' backend. KidClub's functions are the
// repo-root /functions codebase, in KidClub's projects.
import "./options"; // must stay the first import: see options.ts
import * as admin from "firebase-admin";

admin.initializeApp();

export { legrandGetHome, legrandGetStatus, legrandSetState } from "./domotics/legrand";
export { tuyaGetDevices, tuyaSetState } from "./domotics/tuya";
export { domoticsWarmBy } from "./domotics/warmBy";
export { domoticsEnergyBill } from "./domotics/energyBillCallable";
export { kanbanList, kanbanGet, kanbanCreate, kanbanUpdate, kanbanComment } from "./tasks/callables";
export { kanbanPrs, kanbanMergePr, kanbanSetGithubToken, kanbanGithubInfo } from "./tasks/github";
