import { useEffect, useState } from 'react';
import {
  addDoc, collection, deleteDoc, doc, getDocs, onSnapshot, orderBy, query, serverTimestamp, setDoc,
  Timestamp, updateDoc, writeBatch, type DocumentData,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  DEFAULT_BOARDS, cleanCardFields, cleanComment, describeChange, orderAtEnd,
  type Board, type Card, type CardFields, type Status,
} from '@shared/lib/kanban';

// Renato's side of the kanban: straight to Firestore, live. The agents go
// through the kanban* callables, which keep the same document shapes
// (firebase/noisysource/functions/src/tasks/callables.ts). Both clean every
// card with the same cleanCardFields.

const BOARDS = 'tasks_boards';
const CARDS = 'tasks_cards';

const ms = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : Date.now());

function toCard(id: string, d: DocumentData): Card {
  return {
    id,
    boardId: d.boardId,
    title: d.title,
    description: d.description ?? '',
    status: d.status,
    priority: d.priority ?? 'p2',
    labels: d.labels ?? [],
    assignee: d.assignee ?? null,
    roadmap: d.roadmap === true,
    links: d.links ?? [],
    testPlan: d.testPlan ?? '',
    order: d.order ?? 0,
    createdBy: d.createdBy ?? 'renato',
    updatedBy: d.updatedBy ?? 'renato',
    createdAt: ms(d.createdAt),
    updatedAt: ms(d.updatedAt),
  };
}

export interface Activity {
  id: string;
  at: number;
  by: string;
  kind: 'created' | 'updated' | 'comment';
  text: string;
}

export function useBoards(): Board[] | null {
  const [boards, setBoards] = useState<Board[] | null>(null);
  useEffect(
    () =>
      onSnapshot(collection(db, BOARDS), (snap) => {
        if (snap.empty) {
          void seedBoards();
          return;
        }
        setBoards(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Board, 'id'>) }))
            .sort((a, b) => a.order - b.order),
        );
      }),
    [],
  );
  return boards;
}

async function seedBoards() {
  const batch = writeBatch(db);
  for (const { id, ...b } of DEFAULT_BOARDS) batch.set(doc(db, BOARDS, id), b);
  await batch.commit();
}

/** Every card. One person's boards: a few hundred documents at most. */
export function useCards(): Card[] | null {
  const [cards, setCards] = useState<Card[] | null>(null);
  useEffect(
    () => onSnapshot(collection(db, CARDS), (snap) => setCards(snap.docs.map((d) => toCard(d.id, d.data())))),
    [],
  );
  return cards;
}

export function useActivity(cardId: string | null): Activity[] {
  const [items, setItems] = useState<Activity[]>([]);
  useEffect(() => {
    if (!cardId) return setItems([]);
    return onSnapshot(query(collection(db, CARDS, cardId, 'activity'), orderBy('at', 'desc')), (snap) =>
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Activity, 'id' | 'at'>), at: ms(d.get('at')) }))),
    );
  }, [cardId]);
  return items;
}

const log = (cardId: string, kind: Activity['kind'], text: string) =>
  addDoc(collection(db, CARDS, cardId, 'activity'), { at: serverTimestamp(), by: 'renato', kind, text });

export async function createCard(input: Partial<CardFields>, column: Card[]): Promise<void> {
  const fields = cleanCardFields(input);
  const ref = doc(collection(db, CARDS));
  await setDoc(ref, {
    ...fields,
    order: orderAtEnd(column.map((c) => c.order)),
    createdBy: 'renato', updatedBy: 'renato', createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  await log(ref.id, 'created', fields.title);
}

export async function updateCard(card: Card, input: Partial<CardFields> & { order?: number }): Promise<void> {
  const { order, ...rest } = input;
  const patch = cleanCardFields(rest, true);
  const change = describeChange(card, patch);
  if (!change && order === undefined) return;
  await updateDoc(doc(db, CARDS, card.id), {
    ...patch,
    ...(order !== undefined ? { order } : {}),
    updatedBy: 'renato',
    updatedAt: serverTimestamp(),
  });
  if (change) await log(card.id, 'updated', change);
}

export async function moveCard(card: Card, status: Status, order: number): Promise<void> {
  await updateCard(card, { status, order });
}

export async function commentOn(cardId: string, text: string): Promise<void> {
  await log(cardId, 'comment', cleanComment(text));
}

export async function deleteCard(cardId: string): Promise<void> {
  const activity = await getDocs(collection(db, CARDS, cardId, 'activity'));
  await Promise.all(activity.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, CARDS, cardId));
}

export async function createBoard(name: string, color: string, boards: Board[]): Promise<string> {
  const id = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!id || boards.some((b) => b.id === id)) throw new Error('A board with that name already exists');
  await setDoc(doc(db, BOARDS, id), { name: name.trim(), color, order: Math.max(0, ...boards.map((b) => b.order)) + 1 });
  return id;
}
