import { useEffect, useMemo, useRef, useState } from "react";
import type { Account } from "@shared/models/Account";
import { CASH_ACCOUNT_TYPES, computeAccountTrajectory, computeEntityTotals } from "@shared/lib/cashflow";
import { formatEUR } from "@shared/lib/money";
import { toYM, monthRange } from "@shared/lib/forecast";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";

function currentYM() {
  const d = new Date();
  return toYM(d.getFullYear(), d.getMonth() + 1);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Inline balance editor for a single account */
function BalanceCard({
  account,
  onSaved,
}: {
  account: Account;
  onSaved: (id: string, cents: number, asOf: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [eur, setEur] = useState(
    account.balanceCents != null ? (account.balanceCents / 100).toFixed(2) : ""
  );
  const [asOf, setAsOf] = useState(account.balanceAsOf ?? today());
  const inputRef = useRef<HTMLInputElement>(null);

  async function save() {
    const cents = Math.round(parseFloat(eur || "0") * 100);
    await api.accounts.setBalance(account.id, cents, asOf);
    onSaved(account.id, cents, asOf);
    setEditing(false);
  }

  return (
    <div className="flex flex-col p-3 rounded-lg border border-zinc-800 bg-zinc-900 gap-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{account.name}</div>
          <div className="text-xs text-zinc-500 capitalize">{account.type}</div>
        </div>
        {!editing && (
          <button
            className="text-xs text-zinc-400 underline"
            onClick={() => { setEditing(true); setTimeout(() => inputRef.current?.focus(), 50); }}
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <div className="flex gap-2 items-center">
            <input
              ref={inputRef}
              type="number"
              step="0.01"
              value={eur}
              onChange={e => setEur(e.target.value)}
              className="flex-1 bg-zinc-800 border border-zinc-700 text-white rounded px-2 py-1 text-sm"
              placeholder="0.00"
            />
            <span className="text-zinc-500 text-sm">€</span>
          </div>
          <input
            type="date"
            value={asOf}
            onChange={e => setAsOf(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 text-white rounded px-2 py-1 text-sm"
          />
          <div className="flex gap-2">
            <Button className="flex-1 h-7 text-xs" onClick={save}>Save</Button>
            <Button variant="secondary" className="flex-1 h-7 text-xs" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div>
          {account.balanceCents != null ? (
            <>
              <div className={`text-lg font-semibold ${account.balanceCents >= 0 ? "text-white" : "text-red-400"}`}>
                {formatEUR(account.balanceCents)}
              </div>
              {account.balanceAsOf && (
                <div className="text-xs text-zinc-600">as of {account.balanceAsOf}</div>
              )}
            </>
          ) : (
            <div className="text-sm text-zinc-600 italic">Balance not set</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CashFlowPage() {
  const { selectedEntity } = useEntity();

  const [startYM, setStartYM] = useState(currentYM);
  const numMonths = 12;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setMsg(null);
    try {
      const [as, evts] = await Promise.all([
        api.accounts.list(),
        api.forecastEvents.listInRange(startYM, addMonths(startYM, numMonths - 1)),
      ]);
      setAccounts(as);
      setEvents(evts);
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [selectedEntity.id, startYM]);

  function addMonths(ym: string, n: number) {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return toYM(d.getFullYear(), d.getMonth() + 1);
  }

  function handleBalanceSaved(id: string, cents: number, asOf: string) {
    setAccounts(prev => prev.map(a => a.id === id ? { ...a, balanceCents: cents, balanceAsOf: asOf } : a));
  }

  // Cash-like accounts only for the trajectory
  const cashAccounts = useMemo(
    () => accounts.filter(a => CASH_ACCOUNT_TYPES.has(a.type)),
    [accounts]
  );

  const trajectories = useMemo(() => {
    return cashAccounts.map(a =>
      computeAccountTrajectory(
        a.id,
        a.name,
        a.balanceCents ?? 0,
        events,
        startYM,
        numMonths
      )
    );
  }, [cashAccounts, events, startYM]);

  const entityTotals = useMemo(() => computeEntityTotals(trajectories), [trajectories]);

  const months = useMemo(() => monthRange(startYM, numMonths), [startYM]);

  // Balance coverage: how many accounts have a balance set
  const setCount = cashAccounts.filter(a => a.balanceCents != null).length;

  function balanceColor(cents: number) {
    if (cents > 0) return "text-emerald-400";
    if (cents < 0) return "text-red-400";
    return "text-zinc-400";
  }

  function balanceBg(cents: number, isTotal = false) {
    const intensity = isTotal ? "bg-opacity-20" : "bg-opacity-10";
    if (cents > 50000) return `bg-emerald-900 ${intensity}`;
    if (cents < 0) return `bg-red-900 ${intensity}`;
    return "";
  }

  return (
    <div className="space-y-6">
      {/* Header controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <div className="text-xs text-zinc-400 mb-1">Forecast start</div>
          <input
            type="month"
            value={startYM}
            onChange={e => setStartYM(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
          />
        </div>
        <Button onClick={load} disabled={busy} variant="secondary">Refresh</Button>
        {cashAccounts.length > 0 && (
          <div className="text-xs text-zinc-500">
            {setCount}/{cashAccounts.length} accounts have balances set
            {setCount < cashAccounts.length && " — set balances below for accurate forecast"}
          </div>
        )}
      </div>

      {msg && <div className="text-sm text-red-400">{msg}</div>}

      {/* Balance cards */}
      {cashAccounts.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">Current balances</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {cashAccounts.map(a => (
              <BalanceCard key={a.id} account={a} onSaved={handleBalanceSaved} />
            ))}
          </div>
        </div>
      )}

      {/* Running balance table */}
      {trajectories.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">12-month running balance</h3>
          <Card className="overflow-x-auto">
            <table className="text-sm text-left" style={{ minWidth: `${240 + months.length * 100}px` }}>
              <thead>
                <tr className="border-b border-zinc-700 text-zinc-400 text-xs">
                  <th className="px-3 py-2 sticky left-0 bg-zinc-900 z-10 w-52">Account</th>
                  <th className="px-3 py-2 text-right w-24">Now</th>
                  {months.map(m => (
                    <th key={m} className="px-3 py-2 text-right w-24">{m.slice(5)}/{m.slice(2, 4)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trajectories.map(t => (
                  <tr key={t.accountId} className="border-b border-zinc-800 hover:bg-zinc-900">
                    <td className="px-3 py-2 sticky left-0 bg-zinc-950 z-10 font-medium">
                      {t.accountName}
                    </td>
                    <td className={`px-3 py-2 text-right text-xs ${balanceColor(t.startingBalanceCents)}`}>
                      {t.startingBalanceCents !== 0 || accounts.find(a => a.id === t.accountId)?.balanceCents != null
                        ? formatEUR(t.startingBalanceCents)
                        : <span className="text-zinc-700">—</span>
                      }
                    </td>
                    {t.months.map(m => (
                      <td key={m.yearMonth} className={`px-3 py-2 text-right text-xs ${balanceBg(m.endingBalanceCents)}`}>
                        <span className={balanceColor(m.endingBalanceCents)}>
                          {formatEUR(m.endingBalanceCents)}
                        </span>
                        {m.netCents !== 0 && (
                          <div className={`text-xs ${m.netCents > 0 ? "text-emerald-600" : "text-red-600"}`}>
                            {m.netCents > 0 ? "▲" : "▼"} {formatEUR(Math.abs(m.netCents))}
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}

                {/* Entity total row */}
                {trajectories.length > 1 && (
                  <tr className="border-t-2 border-zinc-700 font-semibold bg-zinc-900">
                    <td className="px-3 py-2 sticky left-0 bg-zinc-900 z-10">Entity total</td>
                    <td className={`px-3 py-2 text-right text-xs ${balanceColor(trajectories.reduce((s, t) => s + t.startingBalanceCents, 0))}`}>
                      {formatEUR(trajectories.reduce((s, t) => s + t.startingBalanceCents, 0))}
                    </td>
                    {entityTotals.map(et => (
                      <td key={et.yearMonth} className={`px-3 py-2 text-right text-xs ${balanceBg(et.totalBalanceCents, true)}`}>
                        <span className={balanceColor(et.totalBalanceCents)}>
                          {formatEUR(et.totalBalanceCents)}
                        </span>
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          {/* Mini net flow summary */}
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-zinc-300 mb-3">Monthly net flow (all accounts)</h3>
            <div className="flex gap-1 overflow-x-auto pb-2">
              {months.map((ym, i) => {
                const totalNet = trajectories.reduce((s, t) => s + t.months[i].netCents, 0);
                const totalIn = trajectories.reduce((s, t) => s + t.months[i].inCents, 0);
                const totalOut = trajectories.reduce((s, t) => s + t.months[i].outCents, 0);
                const maxAbs = Math.max(...months.map((_, j) =>
                  Math.abs(trajectories.reduce((s, t) => s + t.months[j].netCents, 0))
                ), 1);
                const barHeight = Math.round(Math.abs(totalNet) / maxAbs * 48);
                return (
                  <div key={ym} className="flex flex-col items-center gap-1 min-w-[72px]">
                    <div className="text-xs text-zinc-500">{ym.slice(5)}/{ym.slice(2, 4)}</div>
                    <div className="h-12 flex items-end justify-center w-full">
                      <div
                        className={`w-10 rounded-sm ${totalNet >= 0 ? "bg-emerald-700" : "bg-red-800"}`}
                        style={{ height: `${Math.max(barHeight, 2)}px` }}
                      />
                    </div>
                    <div className={`text-xs font-medium ${totalNet >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {totalNet >= 0 ? "+" : ""}{formatEUR(totalNet)}
                    </div>
                    {(totalIn > 0 || totalOut > 0) && (
                      <div className="text-xs text-zinc-600 text-center leading-tight">
                        <div className="text-emerald-800">↑{formatEUR(totalIn)}</div>
                        <div className="text-red-900">↓{formatEUR(totalOut)}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="text-zinc-500 text-sm">
          {busy ? "Loading…" : "No cash accounts found for this entity. Add bank accounts first."}
        </div>
      )}
    </div>
  );
}
