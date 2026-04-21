
import { stripUndefined } from "../crud";
import { makeOrgCRUD } from "./base";

export type Company = { id: string; name: string; shortCode?: string };

const from = (raw: any, id: string): Company => ({
  id,
  name: String(raw?.name ?? id),
  shortCode: raw?.shortCode || undefined,
});

const to = (input: Omit<Company, "id"> | Partial<Company>) =>
  stripUndefined({
    name: (input as any).name?.trim(),
    shortCode: (input as any).shortCode?.trim() || undefined,
  });

export function makeCompaniesDomain(getOrgId: () => string) {
  return makeOrgCRUD<Omit<Company, "id"> & { id?: string }, Company>(getOrgId, {
    collectionPath: "companies",
    from,
    to,
    sort: (a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id),
  });
}