// apps/finhub/src/lib/api/crud.ts
import {
  addDoc, updateDoc, deleteDoc, getDocs, getDoc,
  type CollectionReference, type DocumentReference, type DocumentSnapshot
} from "firebase/firestore";

export const stripUndefined = <T extends Record<string, any>>(obj: T): T => {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
};

type FromSnap<TModel> = (snap: DocumentSnapshot) => TModel | undefined;
type ToPayload<TSave> = (input: TSave) => any;

export function createCrud<TModel, TSave>(opts: {
  col: () => CollectionReference;                 // org-aware collection
  docRef: (id: string) => DocumentReference;      // org-aware doc ref
  fromSnap: FromSnap<TModel>;                     // Firestore -> Model
  toPayload: ToPayload<TSave>;                    // Save -> Firestore payload (no id)
  sort?: (a: TModel, b: TModel) => number;        // optional client-side sort
  addCreatedAt?: boolean;                         // default true
}) {
  const addCreatedAt = opts.addCreatedAt !== false;

  return {
    async list(): Promise<TModel[]> {
      const snap = await getDocs(opts.col());
      const rows = snap.docs.map(opts.fromSnap).filter(Boolean) as TModel[];
      return opts.sort ? rows.sort(opts.sort) : rows;
    },

    async get(id: string): Promise<TModel | undefined> {
      const d = await getDoc(opts.docRef(id));
      if (!d.exists()) return undefined;
      return opts.fromSnap(d);
    },

    async save(doc: TSave & { id?: string }): Promise<string> {
      const { id, ...rest } = (doc as any);
      const payload = stripUndefined(opts.toPayload(rest as TSave));
      if (id) {
        await updateDoc(opts.docRef(id), payload);
        return id;
      } else {
        if (addCreatedAt) payload.createdAt = new Date();
        const ref = await addDoc(opts.col(), payload);
        return ref.id;
      }
    },

    async delete(id: string): Promise<void> {
      await deleteDoc(opts.docRef(id));
    },

    
  };
}