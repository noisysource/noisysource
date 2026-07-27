import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { getApp } from 'firebase/app';

const fns = getFunctions(getApp(), 'europe-west3');

// Emulator in dev — production callable functions require Cloud Run IAM (org policy constraint).
if (import.meta.env.DEV) {
  connectFunctionsEmulator(fns, 'localhost', 5001);
}

export function callable<TData = unknown, TResult = unknown>(name: string) {
  return httpsCallable<TData, TResult>(fns, name);
}
