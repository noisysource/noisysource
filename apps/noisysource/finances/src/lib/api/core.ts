import { makeOrgPaths } from "@shared/lib/orgPaths";
import { db, functions } from "@shared/firebase";
import { httpsCallable } from "firebase/functions";

export type CoreApi = {
  get orgId(): string;
  setOrg(id: string): void;
  P(): ReturnType<typeof makeOrgPaths>;
  callV2<Req, Res>(name: string, data: Req): Promise<Res>;
};

export function createCore(initialOrgId = "personal"): CoreApi {
  let _orgId = initialOrgId;

  return {
    get orgId() { return _orgId; },
    setOrg(id: string) { _orgId = id; },
    P() { return makeOrgPaths(db, _orgId); },
    async callV2<Req, Res>(name: string, data: Req): Promise<Res> {
      const fn = httpsCallable<Req, Res>(functions, name);
      const res = await fn(data);
      return res.data as Res;
    },
  };
}