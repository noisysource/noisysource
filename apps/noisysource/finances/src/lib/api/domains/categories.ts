import { stripUndefined } from "../crud";
import { makeOrgCRUD } from "./base";

export type Category = {
  id: string;
  name: string;
  code?: string;
  type?: string;        // e.g. "expense" | "income" | "payable" | …
  parentId?: string;
  active?: boolean;
};

export type CategorySave = Omit<Category, "id"> & { id?: string };

const from = (raw: any, id: string): Category => ({
  id,
  name: raw?.name ?? raw?.title ?? raw?.code ?? id,
  code: raw?.code || undefined,
  type: raw?.type || undefined,
  parentId: raw?.parentId || undefined,
  active: raw?.active !== false,
});

const to = (doc: CategorySave) => stripUndefined({
  name: doc.name,
  code: doc.code,
  type: doc.type,
  parentId: doc.parentId,
  active: doc.active !== false,
});

export function makeCategoriesDomain(getOrgId: () => string) {
  return makeOrgCRUD<CategorySave, Category>(getOrgId, {
    collectionPath: "categories",
    from,
    to,
    sort: (a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id),
  });
}

export type { Category as CategoryModel };