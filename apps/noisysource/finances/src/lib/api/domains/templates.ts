import { stripUndefined } from "../crud";
import { makeOrgCRUD } from "./base";

export type Template = {
  id: string;
  name: string;
  type?: string;               // "single" | "transfer" | "split" | custom
  payload?: Record<string, any>;
  active?: boolean;
};

export type TemplateSave = Omit<Template, "id"> & { id?: string };

const from = (raw: any, id: string): Template => ({
  id,
  name: raw?.name ?? raw?.title ?? id,
  type: raw?.type || undefined,
  payload: raw?.payload || undefined,
  active: raw?.active !== false,
});

const to = (doc: TemplateSave) => stripUndefined({
  name: doc.name,
  type: doc.type,
  payload: doc.payload,
  active: doc.active !== false,
});

export function makeTemplatesDomain(getOrgId: () => string) {
  return makeOrgCRUD<TemplateSave, Template>(getOrgId, {
    collectionPath: "templates",
    from,
    to,
    sort: (a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id),
  });
}

export type { Template as TemplateModel };