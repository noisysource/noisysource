// Client contracts, their monthly handovers, and the days off that drive the projection
// (utils/clientContracts.ts). Its own small module beside TreasuryContext: three collections
// of the one book, read live; written by the book's keeper. FinHub is the master of these
// days off; Atlas shows them beside his other calendars.

import { useEffect, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { db, FINHUB_BOOK_ID } from '../firebase';
import type { ClientContract, ContractHandover, DayOff } from '../utils/clientContracts';

const path = (c: string) => `finhub_books/${FINHUB_BOOK_ID}/${c}`;
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const live = <T extends { id: string }>(name: string, set: (xs: T[]) => void, onError: (e: unknown) => void) =>
  onSnapshot(
    query(collection(db, path(name)), where('userId', '==', FINHUB_BOOK_ID)),
    (snap) => set(snap.docs.map((d) => ({ ...(d.data() as Omit<T, 'id'>), id: d.id }) as T)),
    onError,
  );

/** Drops Firestore's own fields so a document round-trips as plain data. */
const plain = <T extends object>(x: T) => {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = x as T & { id?: string; createdAt?: unknown; updatedAt?: unknown };
  return rest;
};

export const useClientContracts = () => {
  const [contracts, setContracts] = useState<ClientContract[]>([]);
  const [handovers, setHandovers] = useState<ContractHandover[]>([]);
  const [daysOff, setDaysOff] = useState<DayOff[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const failed = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
    const stops = [
      live<ClientContract>('clientContracts', (xs) => setContracts(xs.sort((a, b) => a.clientName.localeCompare(b.clientName))), failed),
      live<ContractHandover>('contractHandovers', (xs) => setHandovers(xs.sort((a, b) => b.month.localeCompare(a.month))), failed),
      live<DayOff>('daysOff', (xs) => setDaysOff(xs.sort((a, b) => a.date.localeCompare(b.date))), failed),
    ];
    return () => stops.forEach((s) => s());
  }, []);
  return { contracts, handovers, daysOff, error };
};

const save = async (name: string, id: string, data: object, isNew: boolean) =>
  setDoc(doc(db, path(name), id), { ...plain(data), userId: FINHUB_BOOK_ID, updatedAt: serverTimestamp(), ...(isNew ? { createdAt: serverTimestamp() } : {}) }, { merge: !isNew });

export const saveContract = (c: ClientContract, isNew: boolean) => save('clientContracts', c.id, c, isNew);
export const deleteContract = (id: string) => deleteDoc(doc(db, path('clientContracts'), id));
export const saveHandover = (h: ContractHandover) => save('contractHandovers', h.id, h, true);
export const deleteHandover = (id: string) => deleteDoc(doc(db, path('contractHandovers'), id));
/** A day off: vacation, day off, the client's closure, a public holiday. */
export const saveDayOff = (d: DayOff) => save('daysOff', d.id, { ...d, source: 'manual' }, true);
export const deleteDayOff = (id: string) => deleteDoc(doc(db, path('daysOff'), id));
