import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { getApp } from 'firebase/app';

const fns = getFunctions(getApp(), 'europe-west3');

// Only use emulator when running the local dev server (vite), not in any built/deployed mode.
if (import.meta.env.MODE === 'development') {
  connectFunctionsEmulator(fns, 'localhost', 5001);
}

export function callable<TData = unknown, TResult = unknown>(name: string) {
  return httpsCallable<TData, TResult>(fns, name);
}
