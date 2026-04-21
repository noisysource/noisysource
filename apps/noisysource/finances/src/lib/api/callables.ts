import { httpsCallable } from "firebase/functions";
import { functions } from "@shared/firebase";

// Generic typed caller for v2 callables.
export async function callV2<Req, Res>(name: string, data: Req): Promise<Res> {
  const fn = httpsCallable<Req, Res>(functions, name);
  const res = await fn(data);
  return res.data as Res;
}