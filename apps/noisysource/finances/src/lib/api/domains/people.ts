
import { stripUndefined } from "../crud";
import { makeOrgCRUD } from "./base";

export type Person = { id: string; name: string };

const from = (raw: any, id: string): Person => ({
  id,
  name: String(raw?.name ?? id),
});

const to = (input: Omit<Person, "id"> | Partial<Person>) =>
  stripUndefined({
    name: (input as any).name?.trim(),
  });

export function makePeopleDomain(getOrgId: () => string) {
  return makeOrgCRUD<Omit<Person, "id"> & { id?: string }, Person>(getOrgId, {
    collectionPath: "people",
    from,
    to,
    sort: (a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id),
  });
}