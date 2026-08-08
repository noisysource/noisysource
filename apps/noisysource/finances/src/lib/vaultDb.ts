import {
  collection, doc, getDoc, setDoc, getDocs,
  addDoc, updateDoc, deleteDoc, serverTimestamp, query, orderBy,
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

const CONFIG_REF = () => doc(db, 'vault_config', 'default');
const ENTRIES    = () => collection(db, 'vault_entries');
const ENTRY_REF  = (id: string) => doc(db, 'vault_entries', id);

export async function loadVaultConfig(): Promise<VaultConfigDoc | null> {
  const snap = await getDoc(CONFIG_REF());
  return snap.exists() ? (snap.data() as VaultConfigDoc) : null;
}

export async function saveVaultConfig(cfg: VaultConfigDoc): Promise<void> {
  await setDoc(CONFIG_REF(), cfg);
}

export async function loadEntries(): Promise<VaultEntryDoc[]> {
  const snap = await getDocs(query(ENTRIES(), orderBy('title')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as VaultEntryDoc);
}

export async function addVaultEntry(
  title: string, category: string, username: string, url: string | undefined,
  sealed: Sealed,
): Promise<VaultEntryDoc> {
  const ref = await addDoc(ENTRIES(), {
    title, category, username, url: url || null,
    encryptedData: sealed.ciphertext, iv: sealed.iv,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return { id: ref.id, title, category, username, url, encryptedData: sealed.ciphertext, iv: sealed.iv, createdAt: null, updatedAt: null };
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
