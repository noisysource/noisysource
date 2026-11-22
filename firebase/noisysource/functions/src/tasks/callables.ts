import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { requireKanbanCaller } from "../auth";
import {
  DEFAULT_BOARDS, STATUSES, cleanCardFields, cleanComment, describeChange, isOnRoadmap, orderAtEnd,
  sortCards, type Actor, type Board, type Card, type CardFields, type Status,
} from "./kanban";

/**
 * The Tasks kanban for the agents (apps/noisysource/tasks is Renato's view of
 * the same documents). Atlas and Claude Code (through mcp/kanban) read the
 * boards and create, move, edit and comment on cards here; neither can delete
 * a card or a board, and neither touches Firestore directly (the rules give
 * the tasks_* collections to the owner alone).
 *
 *   tasks_boards/{boardId}                 Board, minus id
 *   tasks_cards/{cardId}                   Card, minus id; times are Timestamps
 *   tasks_cards/{cardId}/activity/{id}     {at, by, kind, text}
 *
 * No external API. At most a few hundred small reads per call (one person's
 * boards); the 1000-card cap is a wall against a runaway loop, not a page size.
 */

const BOARDS = "tasks_boards";
const CARDS = "tasks_cards";
const MAX_CARDS = 1000;

const db = () => admin.firestore();
const fail = (e: unknown): never => {
  throw new HttpsError("invalid-argument", e instanceof Error ? e.message : String(e));
};

const ms = (v: unknown): number =>
  v instanceof admin.firestore.Timestamp ? v.toMillis() : typeof v === "number" ? v : 0;

function toCard(snap: admin.firestore.DocumentSnapshot): Card {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    boardId: d.boardId,
    title: d.title,
    description: d.description ?? "",
    status: d.status,
    priority: d.priority ?? "p2",
    labels: d.labels ?? [],
    assignee: d.assignee ?? null,
    roadmap: d.roadmap === true,
    links: d.links ?? [],
    order: d.order ?? 0,
    createdBy: d.createdBy,
    updatedBy: d.updatedBy,
    createdAt: ms(d.createdAt),
    updatedAt: ms(d.updatedAt),
  };
}

/** The boards, creating the default ones the first time anyone asks. */
async function loadBoards(): Promise<Board[]> {
  const snap = await db().collection(BOARDS).get();
  if (snap.empty) {
    const batch = db().batch();
    for (const { id, ...b } of DEFAULT_BOARDS) batch.set(db().collection(BOARDS).doc(id), b);
    await batch.commit();
    return DEFAULT_BOARDS;
  }
  return snap.docs
    .map((s) => ({ id: s.id, ...(s.data() as Omit<Board, "id">) }))
    .sort((a, b) => a.order - b.order);
}

async function requireBoard(boardId: string): Promise<void> {
  const boards = await loadBoards();
  if (!boards.some((b) => b.id === boardId)) {
    fail(`boardId: no board "${boardId}" (boards: ${boards.map((b) => b.id).join(", ")})`);
  }
}

async function endOfColumn(boardId: string, status: Status): Promise<number> {
  const snap = await db().collection(CARDS)
    .where("boardId", "==", boardId).where("status", "==", status)
    .select("order").limit(MAX_CARDS).get();
  return orderAtEnd(snap.docs.map((d) => d.get("order") as number));
}

function log(cardId: string, by: Actor, kind: "created" | "updated" | "comment", text: string) {
  return db().collection(CARDS).doc(cardId).collection("activity").add({
    at: admin.firestore.FieldValue.serverTimestamp(), by, kind, text,
  });
}

async function loadCard(cardId: unknown): Promise<admin.firestore.DocumentSnapshot> {
  if (typeof cardId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(cardId)) fail("cardId: required");
  const snap = await db().collection(CARDS).doc(cardId as string).get();
  if (!snap.exists) throw new HttpsError("not-found", `no card "${cardId}"`);
  return snap;
}

interface ListInput {
  boardId?: string;
  /** Only cards on the "All systems" roadmap. */
  roadmap?: boolean;
  status?: Status;
  assignee?: string;
  /** Done cards are left out unless asked for. */
  includeDone?: boolean;
}

export const kanbanList = onCall<ListInput>(async ({ auth, data }) => {
  requireKanbanCaller(auth);
  const q = data ?? {};
  if (q.status !== undefined && !STATUSES.includes(q.status)) fail(`status: one of ${STATUSES.join(", ")}`);
  const boards = await loadBoards();
  let query: admin.firestore.Query = db().collection(CARDS);
  if (q.boardId) query = query.where("boardId", "==", q.boardId);
  const snap = await query.limit(MAX_CARDS).get();
  const statusRank = (s: Status) => STATUSES.indexOf(s);
  const cards = sortCards(snap.docs.map(toCard))
    .filter((c) => (q.roadmap ? isOnRoadmap(c) : true))
    .filter((c) => (q.status ? c.status === q.status : q.includeDone || c.status !== "done"))
    .filter((c) => (q.assignee ? c.assignee === q.assignee : true))
    .sort((a, b) => a.boardId.localeCompare(b.boardId) || statusRank(a.status) - statusRank(b.status));
  return { boards, cards, truncated: snap.size === MAX_CARDS };
});

export const kanbanGet = onCall<{ cardId: string }>(async ({ auth, data }) => {
  requireKanbanCaller(auth);
  const snap = await loadCard(data?.cardId);
  const activity = await snap.ref.collection("activity").orderBy("at", "desc").limit(50).get();
  return {
    card: toCard(snap),
    activity: activity.docs.map((a) => ({ id: a.id, ...a.data(), at: ms(a.get("at")) })),
  };
});

export const kanbanCreate = onCall<Partial<CardFields>>(async ({ auth, data }) => {
  const by = requireKanbanCaller(auth);
  let fields: CardFields;
  try { fields = cleanCardFields(data); } catch (e) { return fail(e); }
  await requireBoard(fields.boardId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ref = db().collection(CARDS).doc();
  await ref.set({
    ...fields,
    order: await endOfColumn(fields.boardId, fields.status),
    createdBy: by, updatedBy: by, createdAt: now, updatedAt: now,
  });
  await log(ref.id, by, "created", fields.title);
  return { card: toCard(await ref.get()) };
});

export const kanbanUpdate = onCall<Partial<CardFields> & { cardId: string }>(async ({ auth, data }) => {
  const by = requireKanbanCaller(auth);
  const snap = await loadCard(data?.cardId);
  const { cardId: _ignored, ...rest } = data;
  let patch: Partial<CardFields>;
  try { patch = cleanCardFields(rest, true); } catch (e) { return fail(e); }
  const before = toCard(snap);
  const change = describeChange(before, patch);
  if (!change) return { card: before, changed: false };
  if (patch.boardId && patch.boardId !== before.boardId) await requireBoard(patch.boardId);
  const boardId = patch.boardId ?? before.boardId;
  const status = patch.status ?? before.status;
  const moved = boardId !== before.boardId || status !== before.status;
  await snap.ref.update({
    ...patch,
    ...(moved ? { order: await endOfColumn(boardId, status) } : {}),
    updatedBy: by,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await log(snap.id, by, "updated", change);
  return { card: toCard(await snap.ref.get()), changed: true };
});

export const kanbanComment = onCall<{ cardId: string; text: string }>(async ({ auth, data }) => {
  const by = requireKanbanCaller(auth);
  const snap = await loadCard(data?.cardId);
  let text: string;
  try { text = cleanComment(data?.text); } catch (e) { return fail(e); }
  await log(snap.id, by, "comment", text);
  await snap.ref.update({ updatedBy: by, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true };
});
