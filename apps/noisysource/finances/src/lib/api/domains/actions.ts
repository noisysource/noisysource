import type { CoreApi } from "../core";

export function createActionsApi(core: CoreApi) {
  return {
    async postPlannedInstance(input: {
      orgId: string;
      instanceId: string;
      cashAccountId?: string;
      createdBy?: string;
    }): Promise<{ ledgerId: string }> {
      return core.callV2<typeof input, { ledgerId: string }>("postPlannedInstance", input);
    },

    async postPlannedInstances(
      orgId: string,
      items: Array<{ instanceId: string; cashAccountId?: string; createdBy?: string }>
    ): Promise<{ ok: number; fail: number; results: Array<{ id: string; ledgerId?: string; error?: string }> }> {
      const results: Array<{ id: string; ledgerId?: string; error?: string }> = [];
      let ok = 0, fail = 0;
      for (const it of items) {
        try {
          const res = await this.postPlannedInstance({ orgId, ...it });
          results.push({ id: it.instanceId, ledgerId: res.ledgerId });
          ok++;
        } catch (e: any) {
          results.push({ id: it.instanceId, error: e?.message ?? "post failed" });
          fail++;
        }
      }
      return { ok, fail, results };
    },
  };
}