import { stripUndefined } from "../crud";
import { makeGlobalCRUD } from "./base";

export type Person = { id: string; name: string; email?: string };

const from = (raw: any, id: string): Person => ({
  id,
  name: String(raw?.name ?? id),
  email: raw?.email || undefined,
});

const to = (input: Partial<Person>) =>
  stripUndefined({
    name: (input as any).name?.trim(),
    email: (input as any).email?.trim() || undefined,
  });

export function makePeopleDomain() {
  return makeGlobalCRUD<Omit<Person, "id"> & { id?: string }, Person>(
    "finances_people",
    { from, to, sort: (a, b) => a.name.localeCompare(b.name) }
  );
}
