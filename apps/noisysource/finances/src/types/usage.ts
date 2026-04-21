export type UsageSnapshot = {
  month: string;
  window: { start: string; end: string };
  firestore: {
    reads: number;
    writes: number;
    deletes: number;
    free: { reads: number; writes: number };
  };
  functions: {
    invocations: number;
    free: number;
  };
  storage: {
    gb: number;
    free: { gb: number };
  };
  hosting: {
    gb: number;
    free: { gb: number };
  };
  auth: {
    newUsers: number;
    free: { users: number };
  };
  status: {
    firestoreReadsOk: boolean;
    firestoreWritesOk: boolean;
    functionsInvocationsOk: boolean;
    storageOk: boolean;
    hostingOk: boolean;
    authOk: boolean;
  };
};
