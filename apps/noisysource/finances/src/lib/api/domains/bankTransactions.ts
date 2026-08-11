import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../firebase';
import type { BankTransactionDoc, BankImportDoc, BankImportSource } from '@shared/models/BankTransaction';
import type { ParsedBpiStatement } from '../../parsers/bpiXlsx';
import { bpiTxId } from '../../parsers/bpiXlsx';

const TX_COL = 'finances_bank_transactions';
const IMPORT_COL = 'finances_bank_imports';

function toDate(raw: any): Date | undefined {
  if (!raw) return undefined;
  if (raw?.toDate) return raw.toDate();
  if (raw instanceof Date) return raw;
  return undefined;
}

function txFrom(raw: any, id: string): BankTransactionDoc {
  return {
    id,
    accountId: raw.accountId ?? '',
    entityId: raw.entityId ?? '',
    importId: raw.importId,
    sourceType: raw.sourceType ?? 'xlsx',
    date: raw.date ?? '',
    valueDate: raw.valueDate,
    description: raw.description ?? '',
    amountCents: raw.amountCents ?? 0,
    balanceCents: raw.balanceCents,
    categoryId: raw.categoryId,
    recurringId: raw.recurringId,
    notes: raw.notes,
    importedAt: toDate(raw.importedAt),
  };
}

function importFrom(raw: any, id: string): BankImportDoc {
  return {
    id,
    accountId: raw.accountId ?? '',
    entityId: raw.entityId ?? '',
    sourceFormat: raw.sourceFormat ?? 'xlsx',
    filename: raw.filename ?? '',
    storagePath: raw.storagePath,
    dateFrom: raw.dateFrom ?? '',
    dateTo: raw.dateTo ?? '',
    transactionCount: raw.transactionCount ?? 0,
    newCount: raw.newCount ?? 0,
    duplicateCount: raw.duplicateCount ?? 0,
    openingBalanceCents: raw.openingBalanceCents,
    closingBalanceCents: raw.closingBalanceCents,
    importedAt: toDate(raw.importedAt),
  };
}

export function makeBankTransactionsDomain() {
  async function listByAccount(accountId: string): Promise<BankTransactionDoc[]> {
    const q = query(
      collection(db, TX_COL),
      where('accountId', '==', accountId),
      orderBy('date', 'desc'),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => txFrom(d.data(), d.id));
  }

  async function listImportsByAccount(accountId: string): Promise<BankImportDoc[]> {
    const q = query(
      collection(db, IMPORT_COL),
      where('accountId', '==', accountId),
      orderBy('importedAt', 'desc'),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => importFrom(d.data(), d.id));
  }

  async function importXlsx(
    accountId: string,
    entityId: string,
    filename: string,
    statement: ParsedBpiStatement,
  ): Promise<BankImportDoc> {
    // Check for existing transactions (dedup)
    let newCount = 0;
    let duplicateCount = 0;
    const importId = doc(collection(db, IMPORT_COL)).id;
    const sourceType: BankImportSource = 'xlsx';

    for (const tx of statement.transactions) {
      const txId = bpiTxId(accountId, tx);
      const txRef = doc(db, TX_COL, txId);
      const existing = await getDoc(txRef);
      if (existing.exists()) {
        duplicateCount++;
        continue;
      }
      await setDoc(txRef, {
        accountId,
        entityId,
        importId,
        sourceType,
        date: tx.date,
        valueDate: tx.valueDate,
        description: tx.description,
        amountCents: tx.amountCents,
        balanceCents: tx.balanceCents,
        importedAt: serverTimestamp(),
      });
      newCount++;
    }

    const importRecord: Omit<BankImportDoc, 'id' | 'importedAt'> = {
      accountId,
      entityId,
      sourceFormat: 'xlsx',
      filename,
      dateFrom: statement.dateFrom,
      dateTo: statement.dateTo,
      transactionCount: statement.transactions.length,
      newCount,
      duplicateCount,
      closingBalanceCents: statement.closingBalanceCents,
    };

    const importRef = doc(db, IMPORT_COL, importId);
    await setDoc(importRef, { ...importRecord, importedAt: serverTimestamp() });

    // Update account balance to the statement's closing balance
    if (statement.closingBalanceCents !== 0 && statement.dateTo) {
      const accountRef = doc(db, 'finances_entities', entityId, 'accounts', accountId);
      await updateDoc(accountRef, {
        balanceCents: statement.closingBalanceCents,
        balanceAsOf: statement.dateTo,
      });
    }

    return { ...importRecord, id: importId, importedAt: new Date() };
  }

  return { listByAccount, listImportsByAccount, importXlsx };
}
