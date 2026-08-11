import {
  collection, doc, getDoc, setDoc, getDocs,
  addDoc, updateDoc, deleteDoc, serverTimestamp, query, where,
} from 'firebase/firestore';
import { db } from '@shared/firebase';
import type { Sealed } from './crypto';

export interface VaultConfigDoc {
  salt:       string;
  verifier:   string;
  verifierIv: string;
}

export interface VaultEntryDoc {
  id:            string;
  uid:           string;
  title:         string;
  category:      string;
  username:      string;
  url?:          string;
  encryptedData: string;
  iv:            string;
  createdAt:     any;
  updatedAt:     any;
}

export interface SensitivePayload {
  password: string;
  notes:    string;
}

const CONFIG_REF = (uid: string) => doc(db, 'vault_config', uid);
const ENTRIES    = (uid: string) => query(collection(db, 'vault_entries'), where('uid', '==', uid));
const ENTRY_REF  = (id: string) => doc(db, 'vault_entries', id);

export async function loadVaultConfig(uid: string): Promise<VaultConfigDoc | null> {
  const snap = await getDoc(CONFIG_REF(uid));
  return snap.exists() ? (snap.data() as VaultConfigDoc) : null;
}

export async function saveVaultConfig(uid: string, cfg: VaultConfigDoc): Promise<void> {
  await setDoc(CONFIG_REF(uid), cfg);
}

export async function loadEntries(uid: string): Promise<VaultEntryDoc[]> {
  const snap = await getDocs(ENTRIES(uid));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }) as VaultEntryDoc)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function addVaultEntry(
  uid: string,
  title: string, category: string, username: string, url: string | undefined,
  sealed: Sealed,
): Promise<VaultEntryDoc> {
  const ref = await addDoc(collection(db, 'vault_entries'), {
    uid, title, category, username, url: url || null,
    encryptedData: sealed.ciphertext, iv: sealed.iv,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return { id: ref.id, uid, title, category, username, url, encryptedData: sealed.ciphertext, iv: sealed.iv, createdAt: null, updatedAt: null };
}

export async function updateVaultEntry(
  id: string, title: string, category: string, username: string, url: string | undefined,
  sealed: Sealed,
): Promise<void> {
  await updateDoc(ENTRY_REF(id), {
    title, category, username, url: url || null,
    encryptedData: sealed.ciphertext, iv: sealed.iv,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteVaultEntry(id: string): Promise<void> {
  await deleteDoc(ENTRY_REF(id));
}
