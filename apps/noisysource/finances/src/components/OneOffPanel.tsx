import { useMemo, useState } from 'react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import AccountSelect from './AccountSelect';
import SplitLinesEditor, { SplitLineUI } from './SplitLinesEditor';
import { postOneOff } from '../lib/api/OneOffApi';
import type { TemplateKind, TemplateShape } from '@shared/models/Ledger';

const ORG_ID = 'personal';

type Props = {
  createdBy: string;           // user uid
  defaultCashAccountId?: string;
  onPosted?: (ledgerId: string) => void;
};

export default function OneOffPanel({ createdBy, defaultCashAccountId, onPosted }: Props) {
  const [kind, setKind] = useState<TemplateKind>('single');
  const [label, setLabel] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));

  // Single
  const [singleType, setSingleType] = useState<'income' | 'expense'>('expense');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState<number>(0);
  const [cashId, setCashId] = useState(defaultCashAccountId ?? '');

  // Transfer
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');

  // Split
  const [lines, setLines] = useState<SplitLineUI[]>([
    { accountId: '', side: 'debit', amount: 0 },
    { accountId: '', side: 'credit', amount: 0 },
  ]);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const splitBalanced = useMemo(() => {
    const d = lines.filter(l => l.side === 'debit').reduce((s, l) => s + (l.amount || 0), 0);
    const c = lines.filter(l => l.side === 'credit').reduce((s, l) => s + (l.amount || 0), 0);
    return Math.abs(d - c) < 0.000001 && d > 0;
  }, [lines]);

  const canSubmit = useMemo(() => {
    if (!label.trim()) return false;
    if (isNaN(new Date(date).getTime())) return false;

    if (kind === 'single') {
      return !!categoryId && amount > 0 && !!cashId;
    }
    if (kind === 'transfer') {
      return !!fromId && !!toId && fromId !== toId && amount > 0;
    }
    // split
    return splitBalanced && lines.every(l => l.accountId && l.amount > 0);
  }, [label, date, kind, categoryId, amount, cashId, fromId, toId, splitBalanced, lines]);

  const buildShape = (): TemplateShape => {
    if (kind === 'single') {
      return {
        kind: 'single',
        accountId: categoryId,
        amountCents: Math.round(amount * 100),
        type: singleType,
      };
    }
    if (kind === 'transfer') {
      return {
        kind: 'transfer',
        fromAccountId: fromId,
        toAccountId: toId,
        amountCents: Math.round(amount * 100),
      };
    }
    return {
      kind: 'split',
      lines: lines.map(l => ({
        accountId: l.accountId,
        side: l.side,
        amountCents: Math.round(l.amount * 100),
        tag: l.tag || undefined,
        personId: l.personId || undefined,
      })),
    };
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setMsg(null);
    try {
      const res = await postOneOff({
        orgId: ORG_ID,
        label: label.trim(),
        date: new Date(`${date}T00:00:00.000Z`),
        currency,
        kind,
        shape: buildShape(),
        cashAccountId: kind === 'single' ? cashId : undefined,
        createdBy,
      });
      setMsg(`✅ Posted to ledger (${res.ledgerId})`);
      onPosted?.(res.ledgerId);

      // reset small bits
      setLabel(''); setAmount(0);
      if (kind === 'single') { setCategoryId(''); }
      if (kind === 'transfer') { setFromId(''); setToId(''); }
      if (kind === 'split') {
        setLines([{ accountId: '', side: 'debit', amount: 0 }, { accountId: '', side: 'credit', amount: 0 }]);
      }
    } catch (e: any) {
      setMsg(e?.message ?? 'Post failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-3 space-y-3 border border-zinc-800 bg-zinc-900 text-white">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">⚡ Quick One-Off</h3>
        {msg && <div className="text-xs">{msg}</div>}
      </div>

      <Input value={label} onChange={(e)=>setLabel(e.target.value)} placeholder="Label (e.g., 'Company formation')" />

      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={date} onChange={(e)=>setDate(e.target.value)} />
        <Input value={currency} onChange={(e)=>setCurrency(e.target.value)} placeholder="Currency" />
      </div>

      <select value={kind} onChange={(e)=>setKind(e.target.value as TemplateKind)} className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1">
        <option value="single">Single</option>
        <option value="transfer">Transfer</option>
        <option value="split">Split</option>
      </select>

      {kind === 'single' && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <select value={singleType} onChange={(e)=>setSingleType(e.target.value as 'income'|'expense')}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1">
              <option value="income">Income</option>
              <option value="expense">Expense</option>
            </select>
            <Input type="number" step="0.01" min={0.01} value={amount || 0}
              onChange={(e)=>setAmount(parseFloat(e.target.value) || 0)} placeholder="Amount" />
          </div>

          <AccountSelect
            orgId={ORG_ID}
            value={categoryId}
            onChange={setCategoryId}
            types={singleType === 'income' ? ['income'] : ['expense']}
            placeholder={singleType === 'income' ? 'Income category' : 'Expense category'}
          />

          <AccountSelect
            orgId={ORG_ID}
            value={cashId}
            onChange={setCashId}
            types={['bank','cash','credit']}
            placeholder="Pay from / Receive to"
          />
        </div>
      )}

      {kind === 'transfer' && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <AccountSelect orgId={ORG_ID} value={fromId} onChange={setFromId} types={['bank','cash','credit']} placeholder="From" />
            <AccountSelect orgId={ORG_ID} value={toId} onChange={setToId} types={['bank','cash','credit']} placeholder="To" />
          </div>
          <Input type="number" step="0.01" min={0.01} value={amount || 0}
            onChange={(e)=>setAmount(parseFloat(e.target.value) || 0)} placeholder="Amount" />
        </div>
      )}

      {kind === 'split' && (
        <SplitLinesEditor
          orgId={ORG_ID}
          lines={lines}
          onChange={setLines}
        />
      )}

      <Button disabled={!canSubmit || busy} onClick={submit} className="w-full">
        {busy ? 'Posting…' : 'Post now'}
      </Button>

      <p className="text-[11px] text-zinc-400">
        Posts directly to the ledger using a temporary planned draft (idempotent).
      </p>
    </Card>
  );
}