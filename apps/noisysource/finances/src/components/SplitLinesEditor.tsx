import { useMemo } from 'react';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import AccountSelect from './AccountSelect';

export type SplitLineUI = {
  accountId: string;
  side: 'debit' | 'credit';
  amount: number;          // EUR
  personId?: string;
  tag?: string;
};

type Props = {
  orgId: string;
  lines: SplitLineUI[];
  onChange: (next: SplitLineUI[]) => void;
  errorText?: string;
  className?: string;
};

export default function SplitLinesEditor({
  orgId,
  lines,
  onChange,
  errorText,
  className = '',
}: Props) {
  const totals = useMemo(() => {
    const debits = lines.filter(l => l.side === 'debit').reduce((s, l) => s + (l.amount || 0), 0);
    const credits = lines.filter(l => l.side === 'credit').reduce((s, l) => s + (l.amount || 0), 0);
    const equal = Math.abs(debits - credits) < 0.000001;
    return { debits, credits, equal };
  }, [lines]);

  const setLine = (i: number, patch: Partial<SplitLineUI>) =>
    onChange(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const addLine = (preset?: Partial<SplitLineUI>) =>
    onChange([...lines, { accountId: '', side: preset?.side ?? 'debit', amount: 0, tag: '', personId: '' }]);

  const removeLine = (i: number) => onChange(lines.filter((_, idx) => idx !== i));

  const duplicateLine = (i: number) => onChange([...lines.slice(0, i + 1), { ...lines[i] }, ...lines.slice(i + 1)]);

  return (
    <Card className={`p-3 space-y-2 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-400">Split lines</div>
        <div className="text-xs">
          Debits: <span className="text-emerald-400">{totals.debits.toFixed(2)}</span> ·
          Credits: <span className="text-emerald-400"> {totals.credits.toFixed(2)}</span> ·
          {totals.equal ? (
            <span className="text-emerald-400"> Balanced ✅</span>
          ) : (
            <span className="text-red-400"> Not balanced ❌</span>
          )}
        </div>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800">
            <th className="text-left py-1 pr-2 w-[40%]">Account</th>
            <th className="text-left py-1 pr-2 w-[14%]">Side</th>
            <th className="text-left py-1 pr-2 w-[20%]">Amount</th>
            <th className="text-left py-1 pr-2 w-[16%]">Tag</th>
            <th className="text-left py-1 pr-2 w-[10%]"></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((ln, i) => (
            <tr key={i} className="border-b border-zinc-900">
              <td className="py-1 pr-2">
                <AccountSelect
                  orgId={orgId}
                  value={ln.accountId}
                  onChange={(id) => setLine(i, { accountId: id })}
                  // For split, allow ANY account type; if you want to limit, pass types={['expense','income','bank','cash']}
                />
              </td>
              <td className="py-1 pr-2">
                <select
                  value={ln.side}
                  onChange={(e) => setLine(i, { side: e.target.value as 'debit' | 'credit' })}
                  className="border p-1 bg-zinc-900 border-zinc-700 text-white rounded"
                >
                  <option value="debit">debit</option>
                  <option value="credit">credit</option>
                </select>
              </td>
              <td className="py-1 pr-2">
                <Input
                  type="number"
                  step="0.01"
                  min={0.01}
                  value={Number.isFinite(ln.amount) ? ln.amount : 0}
                  onChange={(e) => setLine(i, { amount: parseFloat(e.target.value) || 0 })}
                />
              </td>
              <td className="py-1 pr-2">
                <Input
                  placeholder="optional tag"
                  value={ln.tag ?? ''}
                  onChange={(e) => setLine(i, { tag: e.target.value })}
                />
              </td>
              <td className="py-1 pr-2">
                <div className="flex gap-2 justify-end">
                  <button type="button" className="text-blue-400 underline" onClick={() => duplicateLine(i)}>
                    Duplicate
                  </button>
                  <button type="button" className="text-red-400 underline" onClick={() => removeLine(i)}>
                    Remove
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {!lines.length && (
            <tr>
              <td className="py-3 text-zinc-500" colSpan={5}>
                No lines yet. Add at least one debit and one credit.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => addLine({ side: 'debit' })}>
            + Add debit
          </Button>
          <Button type="button" variant="outline" onClick={() => addLine({ side: 'credit' })}>
            + Add credit
          </Button>
        </div>
        {errorText && <div className="text-xs text-red-400">{errorText}</div>}
      </div>
    </Card>
  );
}