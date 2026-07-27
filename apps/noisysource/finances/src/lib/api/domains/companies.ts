import { stripUndefined } from "../crud";
import { makeGlobalCRUD } from "./base";

export type Company = { id: string; name: string; shortCode?: string; taxNumber?: string };

const from = (raw: any, id: string): Company => ({
  id,
  name: String(raw?.name ?? id),
  shortCode: raw?.shortCode || undefined,
  taxNumber: raw?.taxNumber || undefined,
});

const to = (input: Partial<Company>) =>
  stripUndefined({
    name: (input as any).name?.trim(),
    shortCode: (input as any).shortCode?.trim() || undefined,
    taxNumber: (input as any).taxNumber?.trim() || undefined,
  });

export function makeCompaniesDomain() {
  return makeGlobalCRUD<Omit<Company, "id"> & { id?: string }, Company>(
    "finances_companies",
    { from, to, sort: (a, b) => a.name.localeCompare(b.name) }
  );
}
