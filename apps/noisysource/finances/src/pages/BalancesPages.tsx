import { useEffect, useMemo, useState, Fragment } from "react";
import {
  getDocs, orderBy, query, where, Timestamp, limit,
} from "firebase/firestore";
import { db } from "@shared/firebase";
import { makeOrgPaths } from "@shared/lib/orgPaths";
import type { LedgerTransaction, Posting } from "@shared/models/Ledger";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ChevronDown } from "lucide-react";
import { useOrgs } from "../hooks/OrgContext";
import { toDate } from "../lib/api/utils";

const LIQUID_TYPES = new Set(["bank", "cash", "wallet", "credit"]);

type LedgerTxUI = LedgerTransaction & { docId: string; date: Date | null };
type AccountLite = {
  id: string;
  name: string;
  code?: string;
  type: string;
  ownerType?: "company" | "person";
  ownerId?: string;
};
type Company = { id: string; name: string };
type Person  = { id: string; name: string };

export default function LedgerPage() {
  const { selectedOrgId } = useOrgs();

  // filters
  const [from, setFrom] = useState(
    () => new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10)
  );
  const [to, setTo] = useState(
    () => new Date(new Date().getFullYear(), 11, 31).toISOString().slice(0, 10)
  );
  const [search, setSearch] = useState("");

  // data
  const [txs, setTxs] = useState<LedgerTxUI[]>([]);
  const [accounts, setAccounts] = useState<AccountLite[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // disclosure state (groups + tx rows)
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const P = useMemo(() => makeOrgPaths(db, selectedOrgId), [selectedOrgId]);

  // maps
  const accById = useMemo(
    () => Object.fromEntries(accounts.map(a => [a.id, a])),
    [accounts]
  );
  const compById = useMemo(
    () => Object.fromEntries(companies.map(c => [c.id, c])),
    [companies]
  );
  const pplById = useMemo(
    () => Object.fromEntries(people.map(p => [p.id, p])),
    [people]
  );

  // ---------- load ----------
  const mapSnapToRows = (snap: any): LedgerTxUI[] =>
    snap.docs.map((d: any) => {
      const data = d.data() as any;
      return { docId: d.id, ...data, date: toDate(data.date) } as LedgerTxUI;
    });

  const loadTxs = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const dFrom = new Date(`${from}T00:00:00.000Z`);
      const dTo   = new Date(`${to}T23:59:59.999Z`);
      const qy = query(
        P.colLedger(),
        where("date", ">=", Timestamp.fromDate(dFrom)),
        where("date", "<=", Timestamp.fromDate(dTo)),
        orderBy("date", "asc")
      );
      const snap = await getDocs(qy);
      const rows = mapSnapToRows(snap);
      setTxs(rows);
      setMsg(`Loaded ${rows.length} transactions`);
    } catch (e:any) {
      setMsg(e?.message ?? "Failed to load ledger");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!selectedOrgId) return;
    const loadAll = async () => {
      setBusy(true);
      const [accSnap, compSnap, pplSnap] = await Promise.all([
        getDocs(P.colAccounts()),
        getDocs(P.colCompanies()),
        getDocs(P.colPeople()),
      ]);
  
      const acc = accSnap.docs.map(d => {
        const x = d.data() as any;
        return {
          id: d.id,
          name: x.name || d.id,
          code: x.code,
          type: x.type || "bank",
          ownerType: x.ownerType,
          ownerId: x.ownerId,
        } as AccountLite;
      }).sort((a,b)=>a.name.localeCompare(b.name));
      setAccounts(acc);
  
      setCompanies(compSnap.docs.map(d => ({ id:d.id, ...(d.data() as any) })) as Company[]);
      setPeople(pplSnap.docs.map(d => ({ id:d.id, ...(d.data() as any) })) as Person[]);

      await loadTxs();
      setBusy(false);
    }
    loadAll().catch(e => {
      setMsg(e.message);
      setBusy(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrgId, from, to]);

  // ---------- helpers ----------
  const fmtDate = (d: Date | null) => {
    if (!d || isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("pt-PT");
  }
  const asEUR = (n: number) =>
    new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(n);
  const amountClass = (n: number) =>
    n < 0 ? "text-red-400" : n > 0 ? "text-emerald-400" : "text-zinc-300";

  const accountLabel = (id?: string) => {
    if (!id) return "—";
    const a = accById[id];
    if (!a) return id;
    return a.code ? `${a.name} — ${a.code}` : a.name;
  };

  // Net movement across *liquid* accounts (bank/cash/wallet/credit)
  const netMovement = (tx: LedgerTxUI) => {
    let cents = 0;
    for (const p of tx.postings || []) {
      const acc = accById[p.accountId];
      if (!acc || !LIQUID_TYPES.has((acc.type || "").toLowerCase())) continue;
      cents += p.side === "debit" ? (p.amountCents || 0) : -(p.amountCents || 0);
    }
    return cents / 100;
  };

  // Choose an owner group for a tx by the posting with largest magnitude
  const ownerKeyForTx = (tx: LedgerTxUI): string => {
    const bucket: Record<string, number> = {};
    for (const p of tx.postings || []) {
      const acc = accById[p.accountId];
      if (!acc || !acc.ownerType || !acc.ownerId) continue;
      const key = `${acc.ownerType}:${acc.ownerId}`;
      const abs = Math.abs(p.amountCents || 0);
      bucket[key] = (bucket[key] || 0) + abs;
    }
    let best = "unassigned", bestV = 0;
    for (const [k,v] of Object.entries(bucket)) if (v > bestV) { best=k; bestV=v; }
    return best;
  };

  const ownerLabel = (key: string) => {
    if (!key || key === "unassigned") return "— Unassigned";
    const [kind, id] = key.split(":");
    if (kind === "company") return compById[id]?.name || "Company";
    if (kind === "person")  return pplById[id]?.name  || "Person";
    return "— Unassigned";
  };

  const toggle = (k: string) => setOpen(prev => ({ ...prev, [k]: !prev[k] }));

  // search + group
  const visible = useMemo(() => {
    const s = search.trim().toLowerCase();
    return txs.filter(t => !s || (t.label || "").toLowerCase().includes(s));
  }, [txs, search]);

  const groups = useMemo(() => {
    const map = new Map<string, LedgerTxUI[]>();
    for (const tx of visible) {
      const key = ownerKeyForTx(tx);
      const lst = map.get(key) || [];
      lst.push(tx);
      map.set(key, lst);
    }
    // Build final groups with running balances
    return Array.from(map.entries())
      .map(([key, rows]) => {
        rows.sort((a,b)=> (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
        const label = ownerLabel(key);

        let running = 0;
        const lines = rows.map(tx => {
          const delta = netMovement(tx);
          running += delta;
          return { tx, delta, running };
        });

        const total = lines.length ? lines[lines.length - 1].running : 0;

        return { key, label, lines, total };
      })
      .sort((a,b)=>a.label.localeCompare(b.label));
  }, [visible, accById, compById, pplById]);

  return (
    <div className="space-y-4 text-white">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-xl font-semibold mr-3">Ledger</h2>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
        />
        <input
          placeholder="Search label…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 w-48"
        />
        <Button onClick={loadTxs} disabled={busy}>Refresh</Button>
      </div>

      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      {groups.map((grp) => {
        const openGroup = open[grp.key] ?? true; // default open
        return (
          <Card key={grp.key} className="mb-4">
            {/* Clickable group header */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(grp.key)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(grp.key)}
              className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 cursor-pointer select-none"
            >
              <div className="flex items-center gap-2">
                <ChevronDown
                  size={18}
                  className={`transition-transform ${openGroup ? "rotate-0" : "-rotate-90"}`}
                />
                <div className="text-lg font-semibold">{grp.label}</div>
              </div>
              <div className={`text-sm font-medium ${amountClass(grp.total)}`}>
                Net Total: {asEUR(grp.total)}
              </div>
            </div>

            {openGroup && (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm text-left">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-300">
                      <th className="px-3 py-2 w-[110px]">Date</th>
                      <th className="px-3 py-2">Label</th>
                      <th className="px-3 py-2">Currency</th>
                      <th className="px-3 py-2">Net Δ</th>
                      <th className="px-3 py-2">Running</th>
                      <th className="px-3 py-2 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {grp.lines.map(({ tx, delta, running }) => {
                      const rowKey = `tx:${tx.docId}`;
                      const openTx = open[rowKey] ?? false;

                      return (
                        <Fragment key={tx.docId}>
                          {/* Clickable tx row */}
                          <tr
                            role="button"
                            tabIndex={0}
                            onClick={() => toggle(rowKey)}
                            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(rowKey)}
                            className="border-b border-zinc-900 cursor-pointer hover:bg-zinc-900/40"
                          >
                            <td className="px-3 py-2">{fmtDate(tx.date)}</td>
                            <td className="px-3 py-2">{tx.label}</td>
                            <td className="px-3 py-2">{tx.currency}</td>
                            <td className={`px-3 py-2 ${amountClass(delta)}`}>{asEUR(delta)}</td>
                            <td className={`px-3 py-2 ${amountClass(running)}`}>{asEUR(running)}</td>
                            <td className="px-3 py-2">
                              <ChevronDown
                                size={16}
                                className={`mx-auto transition-transform ${openTx ? "rotate-0" : "-rotate-90"}`}
                              />
                            </td>
                          </tr>

                          {openTx && (
                            <tr className="border-b border-zinc-900 bg-zinc-950/60">
                              <td className="px-3 py-3" colSpan={6}>
                                {/* meta */}
                                <div className="text-xs text-zinc-400 mb-2">
                                  <span className="mr-4">
                                    createdBy: <span className="text-white">{tx.createdBy}</span>
                                  </span>
                                  {tx.source?.type && (
                                    <span>
                                      source: <span className="text-white">{tx.source.type}</span>
                                    </span>
                                  )}
                                </div>

                                {/* postings */}
                                <div className="overflow-x-auto">
                                  <table className="min-w-[520px] w-full">
                                    <thead>
                                      <tr className="text-zinc-400">
                                        <th className="text-left py-1 pr-2">Account</th>
                                        <th className="text-left py-1 pr-2">Side</th>
                                        <th className="text-left py-1 pr-2">Amount</th>
                                        <th className="text-left py-1 pr-2">Person</th>
                                        <th className="text-left py-1 pr-2">Tag</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(tx.postings || []).map((p: Posting, i: number) => {
                                        const signed =
                                          (p.side === "debit" ? 1 : -1) * (p.amountCents || 0) / 100;
                                        return (
                                          <tr key={`${tx.docId}-${i}`} className="border-t border-zinc-800">
                                            <td className="py-1 pr-2">{accountLabel(p.accountId)}</td>
                                            <td className="py-1 pr-2 capitalize">{p.side}</td>
                                            <td className={`py-1 pr-2 ${amountClass(signed)}`}>{asEUR(signed)}</td>
                                            <td className="py-1 pr-2">{p.personId || "—"}</td>
                                            <td className="py-1 pr-2">{p.tag || "—"}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {!grp.lines.length && (
                      <tr><td colSpan={6} className="px-3 py-4 text-zinc-500">No transactions in this group.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
