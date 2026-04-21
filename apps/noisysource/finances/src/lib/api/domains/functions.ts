import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";

/**
 * Thin wrapper around Callable v2 functions.
 * Keeps UI code free from httpsCallable details & payload shapes.
 */
export function makeFunctionsDomain(getOrgId: () => string) {
  async function call<TReq, TRes>(name: string, data: TReq): Promise<TRes> {
    const fn = httpsCallable<TReq, TRes>(functions, name);
    const res = await fn(data);
    return res.data;
  }

  /** Post a single planned instance into the ledger. */
  async function postPlannedInstance(args: {
    instanceId: string;
    cashAccountId?: string;
    createdBy?: string;
  }): Promise<{ ledgerId?: string }> {
    return call<typeof args, { ledgerId?: string }>("postPlannedInstance", {
      orgId: getOrgId(),
      ...args,
    } as any);
  }

  /** Optional batch helper (loop in client, call one-by-one server-side). */
  async function postPlannedInstancesBatch(args: {
    instanceIds: string[];
    cashAccountId?: string;
    createdBy?: string;
  }): Promise<{ ok: number; fail: number; results?: any[] }> {
    return call<typeof args, { ok: number; fail: number; results?: any[] }>(
      "postPlannedInstancesBatch",
      { orgId: getOrgId(), ...args } as any
    );
  }

  return { postPlannedInstance, postPlannedInstancesBatch };
}