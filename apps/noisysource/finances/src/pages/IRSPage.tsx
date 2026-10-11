import { useEffect, useState, useMemo } from "react";
import type { PersonIncomeSource, IRSDeductions } from "@shared/models/IRSConfig";
import { computeIRS, effectiveRatePct, projectFullYear } from "@shared/lib/irs";
import { formatEUR } from "@shared/lib/money";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";
import { Link } from "react-router-dom";
import { useEntity } from "../hooks/EntityContext";

// ─── helpers ─────────────────────────────────────────────────────────────────

const EUR = (cents: number) => formatEUR(cents);
const pct = (n: number) => `${n.toFixed(1)}%`;

function toEUR(cents: number) { return cents > 0 ? (cents / 100).toFixed(2) : ""; }
function fromEUR(s: string) { return Math.round((parseFloat(s) || 0) * 100); }

const DEFAULT_DEDUCTIONS: IRSDeductions = { healthCents: 0, educationCents: 0, housingCents: 0 };

// ─── income row editor ────────────────────────────────────────────────────────

function IncomeRow({
  src,
  people,
  onChange,
  onRemove,
}: {
  src: PersonIncomeSource;
  people: string[];
  onChange: (next: PersonIncomeSource) => void;
  onRemove: () => void;
}) {
  const set = (k: keyof PersonIncomeSource, v: string | number) =>
    onChange({ ...src, [k]: typeof v === "string" && k !== "personName" && k !== "employerName" ? fromEUR(v) : v });

  return (
    <div className="grid grid-cols-[140px_160px_1fr_1fr_1fr_32px] gap-2 items-end">
      <div>
        <div className="text-xs text-zinc-500 mb-1">Person</div>
        <select
          value={src.personName}
          onChange={e => set("personName", e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1 text-sm"
        >
          {people.map(name => <option key={name} value={name}>{name}</option>)}
          {!people.includes(src.personName) && src.personName && (
            <option value={src.personName}>{src.personName}</option>
          )}
        </select>
      </div>
      <div>
        <div className="text-xs text-zinc-500 mb-1">Employer</div>
        <Input
          value={src.employerName}
          onChange={e => set("employerName", e.target.value)}
          placeholder="NoisySource…"
          className="text-sm"
        />
      </div>
      <div>
        <div className="text-xs text-zinc-500 mb-1">Gross annual (€)</div>
        <Input
          type="number" step="0.01" placeholder="0.00"
          value={toEUR(src.grossAnnualCents)}
          onChange={e => set("grossAnnualCents", e.target.value)}
          className="text-sm"
        />
      </div>
      <div>
        <div className="text-xs text-zinc-500 mb-1">IRS withheld (€)</div>
        <Input
          type="number" step="0.01" placeholder="0.00"
          value={toEUR(src.irsWithheldCents)}
          onChange={e => set("irsWithheldCents", e.target.value)}
          className="text-sm"
        />
      </div>
      <div>
        <div className="text-xs text-zinc-500 mb-1">SS paid (€)</div>
        <Input
          type="number" step="0.01" placeholder="0.00"
          value={toEUR(src.ssEmployeeCents)}
          onChange={e => set("ssEmployeeCents", e.target.value)}
          className="text-sm"
        />
      </div>
      <button onClick={onRemove} className="text-zinc-600 hover:text-red-400 text-lg leading-none mt-4">✕</button>
    </div>
  );
}

// ─── result row helper ────────────────────────────────────────────────────────

function Row({ label, value, sub, highlight, dimmed }: {
  label: string; value: string; sub?: string; highlight?: boolean; dimmed?: boolean;
}) {
  return (
    <div className={`flex justify-between items-baseline py-1.5 border-b border-zinc-800 last:border-0 ${dimmed ? "opacity-50" : ""}`}>
      <span className="text-sm text-zinc-300">{label}</span>
      <div className="text-right">
        <span className={`font-medium tabular-nums ${highlight ? "text-white text-base" : "text-sm text-zinc-200"}`}>{value}</span>
        {sub && <div className="text-xs text-zinc-500">{sub}</div>}
      </div>
    </div>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function IRSPage() {
  const { selectedEntity } = useEntity();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [monthsElapsed, setMonthsElapsed] = useState(new Date().getMonth() + 1); // 1–12
  const [sources, setSources] = useState<PersonIncomeSource[]>([]);
  const [deductions, setDeductions] = useState<IRSDeductions>(DEFAULT_DEDUCTIONS);
  const [people, setPeople] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Load people for the current entity
  useEffect(() => {
    api.people.list().then(ps => {
      const names = (ps as any[]).map(p => p.name as string).sort();
      setPeople(names);
    }).catch(() => {});
  }, [selectedEntity.id]);

  // Load saved config for selected year
  useEffect(() => {
    setBusy(true);
    setSaved(false);
    api.irsConfig.get(year).then(cfg => {
      if (cfg) {
        setSources(cfg.incomes);
        setDeductions(cfg.deductions);
        setSaved(true);
      } else {
        setSources([]);
        setDeductions(DEFAULT_DEDUCTIONS);
      }
    }).catch(() => {}).finally(() => setBusy(false));
  }, [year, selectedEntity.id]);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api.irsConfig.save(year, sources, deductions);
      setSaved(true);
      setMsg("Saved ✔");
    } catch (e: any) {
      setMsg(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const addSource = () => setSources(s => [...s, { personName: people[0] ?? "", employerName: "", grossAnnualCents: 0, irsWithheldCents: 0, ssEmployeeCents: 0 }]);
  const updateSource = (i: number, next: PersonIncomeSource) => setSources(s => s.map((x, j) => j === i ? next : x));
  const removeSource = (i: number) => setSources(s => s.filter((_, j) => j !== i));
  const setDed = (k: keyof IRSDeductions, v: string) => setDeductions(d => ({ ...d, [k]: fromEUR(v) }));

  // Compute results
  const result = useMemo(() => {
    if (!sources.some(s => s.grossAnnualCents > 0)) return null;
    return computeIRS(sources, deductions);
  }, [sources, deductions]);

  const projectedResult = useMemo(() => {
    if (!sources.some(s => s.grossAnnualCents > 0)) return null;
    if (monthsElapsed >= 12) return result;
    return projectFullYear(sources, deductions, monthsElapsed);
  }, [sources, deductions, monthsElapsed, result]);

  const settlementColor = (cents: number) =>
    cents > 0 ? "text-emerald-400" : cents < 0 ? "text-red-400" : "text-zinc-400";

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-end gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold">Simulador IRS</h2>
          <div className="text-xs text-zinc-500 mt-0.5">
            Joint household declaration{people.length > 0 ? ` (${people.join(" + ")})` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-zinc-400">Year</div>
          <select
            value={year}
            onChange={e => setYear(Number(e.target.value))}
            className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
          >
            {[currentYear - 1, currentYear, currentYear + 1].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-zinc-400">Months elapsed</div>
          <select
            value={monthsElapsed}
            onChange={e => setMonthsElapsed(Number(e.target.value))}
            className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <Button onClick={save} disabled={busy} variant="secondary" className="h-8 text-sm">
          {saved ? "Save (updated)" : "Save"}
        </Button>
        {msg && <span className="text-xs text-emerald-400">{msg}</span>}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-6">
        {/* LEFT: inputs */}
        <div className="space-y-6">
          {/* Income sources */}
          <Card className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-zinc-200">Income sources (Category A)</h3>
              <Button onClick={addSource} variant="secondary" className="h-7 text-xs" disabled={people.length === 0}>+ Add source</Button>
            </div>
            <div className="text-xs text-zinc-500">Enter annual totals — or YTD actual (set months elapsed above to project full year)</div>

            {people.length === 0 && (
              <div className="text-xs text-zinc-500 py-2">
                No people found in this entity.{" "}
                <Link to="/setup/people" className="text-blue-400 underline">Go to Setup → People</Link>
                {" "}to add them first.
              </div>
            )}

            {sources.map((s, i) => (
              <IncomeRow key={i} src={s} people={people} onChange={next => updateSource(i, next)} onRemove={() => removeSource(i)} />
            ))}

            {/* Auto SS hint */}
            <div className="text-xs text-zinc-600 pt-1">
              Tip: SS paid = 11% of gross (Category A). E.g. €24,000 gross → SS = €2,640
            </div>
          </Card>

          {/* Deductions */}
          <Card className="p-4 space-y-4">
            <h3 className="font-semibold text-zinc-200">Deduções à coleta</h3>
            <div className="text-xs text-zinc-500">Enter total annual expenses — the system applies the legal rates and caps.</div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Health expenses (€)</div>
                <Input
                  type="number" step="0.01" placeholder="0.00"
                  value={toEUR(deductions.healthCents)}
                  onChange={e => setDed("healthCents", e.target.value)}
                />
                <div className="text-xs text-zinc-600 mt-1">15% deductible, max credit €1,000</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Education expenses (€)</div>
                <Input
                  type="number" step="0.01" placeholder="0.00"
                  value={toEUR(deductions.educationCents)}
                  onChange={e => setDed("educationCents", e.target.value)}
                />
                <div className="text-xs text-zinc-600 mt-1">30% deductible, max credit €800</div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">Housing (rent/interest) (€)</div>
                <Input
                  type="number" step="0.01" placeholder="0.00"
                  value={toEUR(deductions.housingCents)}
                  onChange={e => setDed("housingCents", e.target.value)}
                />
                <div className="text-xs text-zinc-600 mt-1">15% deductible, max credit €502</div>
              </div>
            </div>
          </Card>
        </div>

        {/* RIGHT: results */}
        {result ? (
          <div className="space-y-4">
            {/* Per-person summary */}
            {result.persons.map(p => (
              <Card key={p.personName} className="p-4">
                <div className="font-semibold text-zinc-200 mb-3">{p.personName}</div>
                <Row label="Gross income" value={EUR(p.grossCents)} />
                <Row label="SS (employee)" value={`−${EUR(p.ssEmployeeCents)}`} dimmed />
                <Row label="Specific deduction" value={`−${EUR(p.specificDeductionCents)}`} sub="max(€4,104 ; 75% SS), cap €11,573" dimmed />
                <Row label="Net taxable" value={EUR(p.netTaxableCents)} />
                <Row label="IRS withheld YTD" value={EUR(p.irsWithheldCents)} />
              </Card>
            ))}

            {/* Household IRS computation */}
            <Card className="p-4">
              <div className="font-semibold text-zinc-200 mb-3">Household IRS (declaração conjunta)</div>
              <Row label="Combined taxable income" value={EUR(result.householdNetTaxableCents)} />
              <Row label="÷ 2 (joint filing quotient)" value={EUR(result.quotientNetTaxableCents)} dimmed />
              <Row label="Tax on quotient" value={EUR(result.taxOnQuotientCents)} dimmed />
              <Row label="× 2 → IRS before deductions" value={EUR(result.totalIRSBeforeDeductionsCents)} />

              {result.totalDeductColectaCents > 0 && (
                <>
                  {result.deductColectaHealthCents > 0 && (
                    <Row label="  Health deduction" value={`−${EUR(result.deductColectaHealthCents)}`} dimmed />
                  )}
                  {result.deductColectaEducationCents > 0 && (
                    <Row label="  Education deduction" value={`−${EUR(result.deductColectaEducationCents)}`} dimmed />
                  )}
                  {result.deductColectaHousingCents > 0 && (
                    <Row label="  Housing deduction" value={`−${EUR(result.deductColectaHousingCents)}`} dimmed />
                  )}
                </>
              )}

              <Row label="IRS owed (coleta)" value={EUR(result.totalIRSOwedCents)} />
              <Row label="Total withheld" value={EUR(result.totalWithheldCents)} />

              <div className="mt-3 pt-3 border-t border-zinc-700">
                <div className="flex justify-between items-center">
                  <span className="font-semibold text-zinc-200">Settlement estimate</span>
                  <div className="text-right">
                    <div className={`text-xl font-bold ${settlementColor(result.settlementCents)}`}>
                      {result.settlementCents >= 0 ? "+" : ""}{EUR(result.settlementCents)}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {result.settlementCents >= 0 ? "Estimated refund" : "Estimated payment due"}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-2 text-xs text-zinc-600">
                Effective rate: {pct(effectiveRatePct(result))} on gross household income
              </div>
            </Card>

            {/* Projection if not full year */}
            {monthsElapsed < 12 && projectedResult && projectedResult !== result && (
              <Card className="p-4 border-zinc-700">
                <div className="font-semibold text-zinc-400 mb-3 text-sm">
                  Full-year projection (extrapolated from {monthsElapsed} months)
                </div>
                <Row label="Projected gross (household)" value={EUR(projectedResult.householdGrossCents)} />
                <Row label="Projected IRS owed" value={EUR(projectedResult.totalIRSOwedCents)} />
                <Row label="Projected withheld" value={EUR(projectedResult.totalWithheldCents)} />
                <div className="mt-3 pt-3 border-t border-zinc-800">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-zinc-400">Projected settlement</span>
                    <span className={`font-bold ${settlementColor(projectedResult.settlementCents)}`}>
                      {projectedResult.settlementCents >= 0 ? "+" : ""}{EUR(projectedResult.settlementCents)}
                    </span>
                  </div>
                </div>
              </Card>
            )}
          </div>
        ) : (
          <Card className="p-6 text-center">
            <div className="text-zinc-500 text-sm">Enter income sources to compute IRS estimate.</div>
          </Card>
        )}
      </div>

      <div className="text-xs text-zinc-700 max-w-2xl">
        Rates: 2024/2025 mainland Portugal progressive brackets. Joint filing (quociente familiar = 2). Specific deductions Category A: max(€4,104; 75% SS), cap €11,573. This is an estimate — consult a tax advisor for official filing.
      </div>
    </div>
  );
}
