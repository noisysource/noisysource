// apps/finhub/src/lib/api/domains/base.ts
import {
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  setDoc,
  collection,
  doc,
  query as fq,
  serverTimestamp,
  type QueryConstraint,
} from "firebase/firestore";
import { db } from "../../firebase";
import { diffPayload, nullsToUndefinedDeep, stripUndefinedDeep, type PayloadDiff } from "../payload";

/** Signature to map Firestore doc -> model */
export type DocFromFn<TModel> = (raw: any, id: string) => TModel;
/** Signature to map save input -> Firestore payload */
export type DocToFn<TSave> = (input: TSave) => any;

export interface OrgCrudOptions<TSave, TModel> {
  /** Path AFTER orgs/{orgId}/… e.g. "companies" */
  collectionPath: string;
  from: DocFromFn<TModel>;
  to?: DocToFn<TSave>;
  /** Optional default sort (client side) */
  sort?: (a: TModel, b: TModel) => number;
}

export function orgCol(entityId: string, path: string) {
  return collection(db, "finances_entities", entityId, path);
}
export function orgDoc(entityId: string, path: string, id: string) {
  return doc(db, "finances_entities", entityId, path, id);
}

export function makeGlobalCRUD<TSave extends { id?: string }, TModel>(
  collectionPath: string,
  opts: Omit<OrgCrudOptions<TSave, TModel>, "collectionPath">
) {
  const to = opts.to ?? ((x: TSave) => x);
  const col = () => collection(db, collectionPath);
  const docRef = (id: string) => doc(db, collectionPath, id);

  async function list(constraints?: QueryConstraint[]): Promise<TModel[]> {
    const q = constraints?.length ? fq(col(), ...constraints) : col();
    const snap = await getDocs(q as any);
    const rows = snap.docs.map(d => opts.from(d.data(), d.id));
    return opts.sort ? rows.sort(opts.sort) : rows;
  }

  async function get(id: string): Promise<TModel | undefined> {
    const d = await getDoc(docRef(id));
    if (!d.exists()) return undefined;
    return opts.from(d.data(), d.id);
  }

  async function save(input: TSave): Promise<string> {
    const mapped = to({ ...(input as any), id: undefined });
    const payload = stripUndefinedDeep(nullsToUndefinedDeep(mapped));
    if (input.id) {
      await updateDoc(docRef(input.id), payload);
      return input.id;
    }
    const ref = await addDoc(col(), { createdAt: serverTimestamp(), ...payload });
    return ref.id;
  }

  const toPayload = (input: TSave) => stripUndefinedDeep(nullsToUndefinedDeep(to(input)));

  /** Idempotent upsert by known id (merge: fields not in the input are kept). */
  async function upsertWithId(id: string, input: Omit<TSave, "id">): Promise<string> {
    const ref = docRef(id);
    const exists = (await getDoc(ref)).exists();
    const payload = toPayload(input as TSave);
    await setDoc(ref, exists ? payload : { createdAt: serverTimestamp(), ...payload }, { merge: true });
    return id;
  }

  /** What upsertWithId(id, input) would change, without writing. */
  async function diffWithId(id: string, input: Omit<TSave, "id">): Promise<PayloadDiff> {
    const snap = await getDoc(docRef(id));
    return diffPayload(snap.exists() ? snap.data() : undefined, toPayload(input as TSave));
  }

  async function remove(id: string): Promise<void> {
    await deleteDoc(docRef(id));
  }

  return { list, get, save, delete: remove, upsertWithId, diffWithId };
}

/**
 * Factory for CRUD over an org-scoped collection.
 * - list() accepts constraints AND orderBy constraints
 * - save() never writes undefined (deep)
 * - upsertWithId() for deterministic/idempotent writes
 */
export function makeOrgCRUD<TSave extends { id?: string }, TModel>(
  getOrgId: () => string,
  opts: OrgCrudOptions<TSave, TModel>
) {
  const to = opts.to ?? ((x: TSave) => x);

  async function list(
    constraints?: QueryConstraint[],
    order?: QueryConstraint[]
  ): Promise<TModel[]> {
    const base = orgCol(getOrgId(), opts.collectionPath);
    const q =
      (constraints?.length || order?.length)
        ? fq(base, ...(constraints ?? []), ...(order ?? []))
        : base;

    const snap = await getDocs(q as any);
    const rows = snap.docs.map(d => opts.from(d.data(), d.id));
    return opts.sort ? rows.sort(opts.sort) : rows;
  }

  async function get(id: string): Promise<TModel | undefined> {
    const d = await getDoc(orgDoc(getOrgId(), opts.collectionPath, id));
    if (!d.exists()) return undefined;
    return opts.from(d.data(), d.id);
  }

  async function save(input: TSave): Promise<string> {
    const hasId = !!input.id;

    // map -> deep clean (also normalize nulls)
    const mapped = to({ ...(input as any), id: undefined });
    const payload = stripUndefinedDeep(nullsToUndefinedDeep(mapped));

    if (hasId && input.id) {
      await updateDoc(orgDoc(getOrgId(), opts.collectionPath, input.id), payload);
      return input.id;
    } else {
      const ref = await addDoc(orgCol(getOrgId(), opts.collectionPath), {
        createdAt: serverTimestamp(),
        ...payload,
      });
      return ref.id;
    }
  }

  async function create(input: Omit<TSave, "id">): Promise<string> {
    return save(input as TSave);
  }

  async function update(id: string, input: Partial<TSave>): Promise<void> {
    const mapped = to(input as TSave);
    const payload = stripUndefinedDeep(nullsToUndefinedDeep(mapped));
    await updateDoc(orgDoc(getOrgId(), opts.collectionPath, id), payload);
  }

  /** Idempotent upsert by known ID (useful for generated/expanded docs). */
  async function upsertWithId(id: string, input: Omit<TSave, "id">): Promise<string> {
    const ref = orgDoc(getOrgId(), opts.collectionPath, id);

    // Only set createdAt the first time: light existence check
    const exists = (await getDoc(ref)).exists();

    const mapped = to(input as TSave);
    const payload = stripUndefinedDeep(nullsToUndefinedDeep(mapped));

    await setDoc(
      ref,
      exists ? payload : { createdAt: serverTimestamp(), ...payload },
      { merge: true }
    );
    return id;
  }

  /** What upsertWithId(id, input) would change, without writing (the seed import's preview). */
  async function diffWithId(id: string, input: Omit<TSave, "id">): Promise<PayloadDiff> {
    const snap = await getDoc(orgDoc(getOrgId(), opts.collectionPath, id));
    const payload = stripUndefinedDeep(nullsToUndefinedDeep(to(input as TSave)));
    return diffPayload(snap.exists() ? snap.data() : undefined, payload);
  }

  async function remove(id: string): Promise<void> {
    await deleteDoc(orgDoc(getOrgId(), opts.collectionPath, id));
  }

  return {
    list,
    get,
    save,
    create,
    update,
    delete: remove,
    upsertWithId,
    diffWithId,
  };
}