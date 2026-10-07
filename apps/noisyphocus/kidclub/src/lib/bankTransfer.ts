import { useEffect, useState } from 'react';
import { getDoc, setDoc } from 'firebase/firestore';
import { docRef } from './db';

/**
 * Bank details parents transfer to, from `_apps/arcoiris/config/billing`
 * (readable by any signed-in user, writable by admins — firestore.rules
 * config/{configId}). Edited in Cobranças → "Dados para transferência".
 * Deliberately not hardcoded: empty until an admin fills it in.
 */
export interface BankTransferConfig {
  iban: string;
  accountHolder: string;
}

export const EMPTY_BANK_CONFIG: BankTransferConfig = { iban: '', accountHolder: '' };

export async function loadBankTransferConfig(): Promise<BankTransferConfig> {
  const snap = await getDoc(docRef('config', 'billing'));
  const d = snap.data() ?? {};
  return { iban: d.iban ?? '', accountHolder: d.accountHolder ?? '' };
}

export async function saveBankTransferConfig(cfg: BankTransferConfig): Promise<void> {
  await setDoc(docRef('config', 'billing'), {
    iban: cfg.iban.replace(/\s+/g, ' ').trim().toUpperCase(),
    accountHolder: cfg.accountHolder.trim(),
    updatedAt: new Date(),
  }, { merge: true });
}

export function useBankTransferConfig(): { config: BankTransferConfig | null; reload: () => void } {
  const [config, setConfig] = useState<BankTransferConfig | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    loadBankTransferConfig().then(setConfig).catch(err => {
      console.error('[bankTransfer] config/billing load failed', err);
      setConfig(EMPTY_BANK_CONFIG);
    });
  }, [n]);
  return { config, reload: () => setN(x => x + 1) };
}

/** Groups of four, as printed on a bank statement. */
export function formatIban(iban: string): string {
  return iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

/** Suggested transfer description: family name + period, short enough for most banks (≤ 140 chars). */
export function transferDescription(familyName: string, periodLabel: string): string {
  return `${familyName} — ${periodLabel}`.slice(0, 140);
}
