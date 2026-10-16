import { Fragment, useEffect, useMemo, useState } from "react";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";

import type { EmploymentContractDoc } from "@shared/models/Employment";
import type { Account } from "@shared/models/Account";
import { formatEUR } from "@shared/lib/money";

import {
  buildPayrollPreview,
  payrollRunId,
  splitConfirmedRows,
  type PayrollRow as PreviewRow,
} from "@shared/lib/payroll";
import type { PayrollRunDoc } from "@shared/models/PayrollRun";
import { where } from "firebase/firestore";
import { useEntity } from "../hooks/EntityContext";

type Company = { id: string; name: string };

const CASH_TYPES = new Set(["bank", "wallet", "cash", "credit"]);

const show = (v: any) => (v == null || v === "" ? "—" : String(v));
const showEUR = (cents?: number | null) => formatEUR((cents ?? 0) as number);

function Money({
  cents,
  negative = false,
}: {
  cents?: number | null;
  negative?: boolean;
}) {
  const c = Number(cents ?? 0);
  const isDeduction = negative && c > 0;
  return (
    <span className={isDeduction ? "text-red-400" : undefined}>
      {isDeduction ? "−" : ""}
      {showEUR(c)}
    </span>
  );
}

// Load companies, people names, and all accounts once; reload on entity change
function usePayrollBase(entityId: string) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [peopleById, setPeopleById] = useState<Record<string, string>>({});
  const [accountsById, setAccountsById] = useState<Record<string, Account>>({});

  useEffect(() => {
    (async () => {
      const [cs, ps, as] = await Promise.all([
        api.companies.list(),
        api.people.list(),
        api.accounts.list(),
      ]);
      setCompanies(
        (cs || [])
          .map((c: any) => ({ id: c.id, name: c.name || c.id }))
          .sort((a: Company, b: Company) => a.name.localeCompare(b.name))
      );
      const pb: Record<string, string> = {};
      (ps || []).forEach((p: any) => (pb[p.id] = p.name || p.id));
      setPeopleById(pb);
      const accMap: Record<string, Account> = {};
      (as || []).forEach((a: Account) => (accMap[a.id] = a));
      setAccountsById(accMap);
    })();
  }, [entityId]);

  return { companies, peopleById, accountsById };
}

export default function PayrollPage() {
  const { selectedEntity } = useEntity();
  const { companies, peopleById, accountsById } = usePayrollBase(selectedEntity.id);

  // `companies` (finances_companies) is a global reference list, not scoped
  // by entity — without this filter, the picker below let you view/default
  // to another entity's company (e.g. NoisySource's contracts while looking
  // at NoisyPhocus's Payroll page). Match by normalized name against the
  // hardcoded ENTITIES list (see EntityContext.tsx) rather than assuming
  // company doc IDs equal entity IDs, since that's not guaranteed by the
  // data model. Falls back to the full list only for the 'private' entity
  // (which has no matching company) or if the name match finds nothing —
  // logged so a silent data mismatch doesn't look like "working as intended".
  const companiesForEntity = useMemo(() => {
    if (selectedEntity.type !== 'company') return companies;
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
    const matches = companies.filter(c => norm(c.name) === norm(selectedEntity.name));
    if (matches.length === 0) {
      console.warn(
        `[PayrollPage] no company matches entity "${selectedEntity.name}" by name — ` +
        `falling back to the full company list. Check finances_companies docs.`
      );
      return companies;
    }
    return matches;
  }, [companies, selectedEntity]);

  const [companyId, setCompanyId] = useState<string>("");
  const [month, setMonth] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [span, setSpan] = useState<number>(1);

  const [rows, setRows] = useState<PreviewRow[]>([]);
  // Runs already stored for the company: their months can't be confirmed again.
  const [runs, setRuns] = useState<PayrollRunDoc[]>([]);
  const { pending, confirmed } = useMemo(() => splitConfirmedRows(rows, runs), [rows, runs]);
  const confirmedKeys = useMemo(() => new Set(confirmed.map(r => r.key)), [confirmed]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Optional: pick a source account (company-owned, cash-like) for the payments
  const companyCashAccounts = useMemo(() => {
    return Object.values(accountsById)
      .filter(
        (a) => a.ownerType === "company" && a.ownerId === companyId && CASH_TYPES.has(a.type)
      )
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }, [accountsById, companyId]);
  const [sourceAccountId, setSourceAccountId] = useState<string>("");

  useEffect(() => {
    // Reset whenever the entity-filtered list changes (including on entity
    // switch) so a stale companyId from another entity can't linger.
    if (companiesForEntity.length && !companiesForEntity.some(c => c.id === companyId)) {
      setCompanyId(companiesForEntity[0].id);
    } else if (!companiesForEntity.length) {
      setCompanyId('');
    }
  }, [companiesForEntity, companyId]);

  useEffect(() => {
    // reset source account on company change
    setSourceAccountId("");
  }, [companyId]);

  const accountName = (id?: string | null) => (id ? accountsById[id]?.name || id : "—");

  async function loadPreview() {
    if (!companyId) {
      setMsg("Pick a company.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const [contracts, companyRuns] = await Promise.all([
        api.contracts.list([where("companyId", "==", companyId)]) as Promise<EmploymentContractDoc[]>,
        api.payrollRuns.listByCompany(companyId),
      ]);
      const [yy, mm] = month.split("-").map(Number);

      // All math happens in shared helper; this page only renders & creates planned
      const preview = buildPayrollPreview(contracts, {
        year: yy,
        month1to12: mm,
        span,
        companyBankAccountId: sourceAccountId || null,
      });

      setRows(preview);
      setRuns(companyRuns);
      const done = splitConfirmedRows(preview, companyRuns).confirmed.length;
      setMsg(`Loaded ${contracts.length} contract(s), built ${preview.length} row(s)` +
        (done ? `; ${done} already confirmed.` : "."));
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to load payroll preview");
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  async function confirmPayroll() {
    if (!rows.length || !companyId) {
      setMsg("Load payroll for a company first.");
      return;
    }
    if (!pending.length) {
      setMsg("Every row shown is already confirmed.");
      return;
    }
    const skipped = confirmed.length ? ` ${confirmed.length} already confirmed will be skipped.` : "";
    if (!confirm(`Confirm ${pending.length} payroll row(s)? This saves them as payroll run records.${skipped}`)) return;

    setBusy(true);
    setMsg(null);
    try {
      // One run per company, person and month (same id as the seed import), each under its own month.
      await Promise.all(
        pending.map(r => {
          const [yy, mm] = r.yearMonth.split("-").map(Number);
          return api.payrollRuns.upsertWithId(payrollRunId(r.companyId, r.personId, r.yearMonth), {
            contractId: r.contractId,
            companyId: r.companyId,
            personId: r.personId,
            year: yy,
            month: mm,
            grossCents: r.grossCents,
            irsCents: r.irsCents,
            ssEmpCents: r.ssEmpCents,
            ssErCents: r.ssErCents,
            netCents: r.netCents,
            benefitsCents: r.totals.benefitsCents,
            costToEmployerCents: r.totals.costToEmployerCents,
            cashOutCents: r.totals.cashOutCents,
            confirmedAt: new Date(),
            sourceAccountId: sourceAccountId || undefined,
          });
        })
      );
      setRuns(await api.payrollRuns.listByCompany(companyId));
      setMsg(`Confirmed ${pending.length} payroll run(s) ✔`);
    } catch (e: any) {
      setMsg(e?.message ?? "Failed to confirm payroll");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Salários</h2>

      <div className="flex flex-wrap gap-2 items-end">
        <div>
          <div className="text-xs text-zinc-400 mb-1">Month</div>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div>
          <div className="text-xs text-zinc-400 mb-1">Company</div>
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
          >
            {companiesForEntity.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="text-xs text-zinc-400 mb-1">Period</div>
          <select
            value={span}
            onChange={(e) => setSpan(parseInt(e.target.value) || 1)}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
          >
            <option value={1}>1 month</option>
            <option value={3}>3 months</option>
            <option value={6}>6 months</option>
          </select>
        </div>

        {/* Optional source account for transfers */}
        <div>
          <div className="text-xs text-zinc-400 mb-1">Source account (company)</div>
          <select
            value={sourceAccountId}
            onChange={(e) => setSourceAccountId(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 min-w-[220px]"
          >
            <option value="">— none / choose later —</option>
            {companyCashAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <Button onClick={loadPreview} disabled={busy}>
          Load payroll
        </Button>
        <Button onClick={confirmPayroll} disabled={busy || !pending.length} variant="secondary">
          Confirm payroll{rows.length ? ` (${pending.length})` : ""}
        </Button>
      </div>

      {msg && <div className="text-sm text-emerald-400">{msg}</div>}

      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm text-left">
          <thead>
            <tr className="border-b border-zinc-700 text-zinc-300">
              <th className="px-3 py-2">Details</th>
              <th className="px-3 py-2">Employee</th>
              <th className="px-3 py-2">Month</th>
              <th className="px-3 py-2">Pay date</th>
              <th className="px-3 py-2">Gross</th>
              <th className="px-3 py-2">IRS (−)</th>
              <th className="px-3 py-2">SS Emp (−)</th>
              <th className="px-3 py-2">SS ER (−)</th>
              <th className="px-3 py-2">Benefits</th>
              <th className="px-3 py-2">Net</th>
              <th className="px-3 py-2">Cash out</th>
              <th className="px-3 py-2">Employer cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const empName = r.personId ? peopleById[r.personId] || r.personId : "—";
              const isOpen = expanded.has(r.key);

              return (
                <Fragment key={r.key}>
                  <tr className="border-b border-zinc-800">
                    <td className="px-3 py-2">
                      <button
                        onClick={() => toggle(r.key)}
                        className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
                        aria-expanded={isOpen}
                      >
                        {isOpen ? "Hide" : "Show"}
                      </button>
                    </td>
                    <td className="px-3 py-2">{show(empName)}</td>
                    <td className="px-3 py-2">
                      {show(r.monthLabel)}
                      {confirmedKeys.has(r.key) && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-300">confirmado</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{show(r.payDateISO)}</td>
                    <td className="px-3 py-2">{showEUR(r.grossCents)}</td>
                    <td className="px-3 py-2">
                      <Money cents={r.irsCents} negative />
                    </td>
                    <td className="px-3 py-2">
                      <Money cents={r.ssEmpCents} negative />
                    </td>
                    <td className="px-3 py-2">
                      <Money cents={r.ssErCents} negative />
                    </td>
                    <td className="px-3 py-2">{showEUR(r.totals.benefitsCents)}</td>
                    <td className="px-3 py-2">{showEUR(r.netCents)}</td>
                    <td className="px-3 py-2">{showEUR(r.totals.cashOutCents)}</td>
                    <td className="px-3 py-2">{showEUR(r.totals.costToEmployerCents)}</td>
                  </tr>

                  {isOpen && (
                    <tr>
                      <td colSpan={12} className="px-3 py-3 bg-zinc-950 border-b border-zinc-800">
                        <div className="grid md:grid-cols-2 gap-4">
                          {/* LEFT: Full payroll for the month */}
                          <div className="p-3 rounded border border-zinc-800 text-xs space-y-2">
                            <div className="font-semibold text-zinc-200">Payroll breakdown</div>

                            <div className="flex justify-between">
                              <span>Gross</span>
                              <span>{showEUR(r.grossCents)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>IRS</span>
                              <span>
                                <Money cents={r.irsCents} negative />
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span>SS employee</span>
                              <span>
                                <Money cents={r.ssEmpCents} negative />
                              </span>
                            </div>

                            <div className="flex justify-between pt-1 border-t border-zinc-800">
                              <span>Net salary</span>
                              <span>{showEUR(r.netCents)}</span>
                            </div>

                            <div className="mt-2">
                              <div className="text-zinc-300 mb-1">Benefits</div>
                              {r.benefits.length ? (
                                <div className="space-y-1">
                                  {r.benefits.map((b, i) => (
                                    <div key={`${r.key}-b-${i}`} className="flex justify-between">
                                      <span>
                                        {(b.type || "benefit").toString()}{" "}
                                        {b.perDayCents
                                          ? `(${showEUR(b.perDayCents)} × ${b.days})`
                                          : b.perMonthCents
                                            ? `(monthly ${showEUR(b.perMonthCents)})`
                                            : ""}
                                      </span>
                                      <span>{showEUR(b.totalCents)}</span>
                                    </div>
                                  ))}
                                  <div className="flex justify-between pt-1 border-t border-zinc-800">
                                    <span>Total benefits</span>
                                    <span>{showEUR(r.totals.benefitsCents)}</span>
                                  </div>
                                </div>
                              ) : (
                                <div className="text-zinc-500">No benefits.</div>
                              )}
                            </div>

                            <div className="flex justify-between pt-2 border-t border-zinc-800">
                              <span>SS employer (company)</span>
                              <span>
                                <Money cents={r.ssErCents} negative />
                              </span>
                            </div>

                            <div className="flex justify-between pt-2 border-t border-zinc-800">
                              <span>Cash out (net + benefits)</span>
                              <span>{showEUR(r.totals.cashOutCents)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Employer cost (gross + SS ER + benefits)</span>
                              <span>{showEUR(r.totals.costToEmployerCents)}</span>
                            </div>
                          </div>

                          {/* RIGHT: Money paths */}
                          <div className="p-3 rounded border border-zinc-800 text-xs">
                            <div className="font-semibold text-zinc-200 mb-2">Money movement (preview)</div>
                            {r.flows.length ? (
                              <div className="space-y-2">
                                {r.flows.map((f, i) => (
                                  <div key={`${r.key}-f-${i}`} className="p-2 rounded border border-zinc-800">
                                    <div className="flex justify-between">
                                      <span>{f.label}</span>
                                      <span>{showEUR(f.amountCents)}</span>
                                    </div>
                                    <div className="text-zinc-400">
                                      From: {f.fromAccountId ? accountName(f.fromAccountId) : "—"} → To:{" "}
                                      {f.toAccountId ? accountName(f.toAccountId) : "—"}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-zinc-500">No flows configured.</div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-zinc-500">
                  Load payroll to begin.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}