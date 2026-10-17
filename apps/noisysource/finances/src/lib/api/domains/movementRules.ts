import { makeOrgCRUD } from "./base";
import { stripUndefinedDeep } from "../payload";
import type { MovementRuleDoc } from "@shared/models/BankTransaction";

type MovementRuleSave = Omit<MovementRuleDoc, "id"> & { id?: string };

const from = (raw: any, id: string): MovementRuleDoc => ({
  id,
  key: raw?.key ?? "",
  accountId: raw?.accountId || undefined,
  match: raw?.match ?? { kind: "adhoc", label: "" },
});

/** finances_entities/{entity}/movementRules: remembered classifications (Movimentos). */
export function makeMovementRulesDomain(getEntityId: () => string) {
  const base = makeOrgCRUD<MovementRuleSave, MovementRuleDoc>(getEntityId, {
    collectionPath: "movementRules",
    from,
    sort: (a, b) => a.key.localeCompare(b.key),
  });
  return {
    ...base,
    /** One rule per description (and account): saving again replaces it. */
    async remember(rule: Omit<MovementRuleDoc, "id">): Promise<string> {
      const id = `${rule.accountId ?? "all"}__${rule.key.replace(/\s+/g, "_")}`.slice(0, 400);
      return base.upsertWithId(id, { ...rule, match: stripUndefinedDeep(rule.match) });
    },
  };
}
