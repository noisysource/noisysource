import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc,
  query, orderBy, serverTimestamp,
} from "firebase/firestore";
import { db } from "../../firebase";
import type { AppNotification, NotificationSeverity } from "@shared/models/AppNotification";
import { toDate } from "../utils";

const COL = () => collection(db, "finances_notifications");
const DOC = (id: string) => doc(db, "finances_notifications", id);

const SEVERITY_ORDER: Record<NotificationSeverity, number> = { info: 1, warning: 2, urgent: 3 };

type NotificationInput = Omit<AppNotification, "id" | "createdAt" | "read">;

const from = (raw: any, id: string): AppNotification => ({
  id,
  type: raw?.type ?? "generic",
  severity: raw?.severity ?? "info",
  title: raw?.title ?? "",
  body: raw?.body ?? "",
  read: raw?.read === true,
  entityId: raw?.entityId || undefined,
  referenceId: raw?.referenceId || undefined,
  referenceType: raw?.referenceType || undefined,
  linkTo: raw?.linkTo || undefined,
  dueDate: raw?.dueDate || undefined,
  createdAt: toDate(raw?.createdAt) ?? undefined,
});

export function makeNotificationsDomain() {
  async function list(): Promise<AppNotification[]> {
    const snap = await getDocs(query(COL(), orderBy("createdAt", "desc")));
    return snap.docs.map(d => from(d.data(), d.id));
  }

  async function markRead(id: string): Promise<void> {
    await updateDoc(DOC(id), { read: true });
  }

  async function markAllRead(): Promise<void> {
    const all = await list();
    await Promise.all(all.filter(n => !n.read).map(n => markRead(n.id)));
  }

  async function upsert(id: string, data: NotificationInput): Promise<void> {
    const snap = await getDoc(DOC(id));
    const existing = snap.exists() ? from(snap.data(), id) : null;
    const severityEscalated = !existing ||
      SEVERITY_ORDER[data.severity] > SEVERITY_ORDER[existing.severity];

    if (existing) {
      await setDoc(DOC(id), {
        ...data,
        read: severityEscalated ? false : existing.read,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    } else {
      await setDoc(DOC(id), {
        ...data,
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  }

  return { list, markRead, markAllRead, upsert };
}
