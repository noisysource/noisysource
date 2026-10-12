import { useEffect, useMemo, useState } from "react";
import type { RecurringEntryDoc } from "@shared/models/RecurringEntry";
import type { CreditContractDoc } from "@shared/models/CreditContract";
import type { EmploymentContractDoc } from "@shared/models/Employment";
import type { IncomeSourceDoc } from "@shared/models/IncomeSource";
import type { EcContractDoc } from "@shared/models/EcContract";
import type { ComputedEvent, FinanceEntityId } from "@shared/models/FinanceEvent";
import type { Account } from "@shared/models/Account";
import {
  generateRecurringEvents,
  generateCreditEvents,
  generateEmploymentEvents,
  generateIncomeSourceEvents,
  generateEcEvents,
  generateKidclubEvents,
  kidclubVolumeByMonth,
} from "@shared/lib/eventGenerators";
import type { KidclubBillingRecord } from "@shared/lib/eventGenerators";
import { isCashLike } from "@shared/models/Account";
import { formatEUR } from "@shared/lib/money";
import { Card } from "../components/ui/card";
import { api } from "../lib/api";

// ── helpers ────────────────────────────────────────────────────────────────────

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + m + n;
  const mo = ((total - 1) % 12) + 1;
  const yr = (total - mo) / 12;
  return `${yr}-${String(mo).padStart(2, '0')}`;
}

function ymLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return `${months[parseInt(m) - 1]} ${y.slice(2)}`;
}

function compactEUR(cents: number): string {
  const eur = Math.abs(cents) / 100;
  if (eur >= 1000) return `€${(eur / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `€${Math.round(eur)}`;
}

const ENTITY_IDS: FinanceEntityId[] = ['private', 'noisysource', 'noisyphocus'];
const ENTITY_LABELS: Record<FinanceEntityId, string> = {
  private: 'Casa',
  noisysource: 'NoisySource',
  noisyphocus: 'NoisyPhocus',
};
const ENTITY_COLORS: Record<FinanceEntityId, string> = {
  private: 'text-blue-400',
  noisysource: 'text-emerald-400',
  noisyphocus: 'text-purple-400',
};
const ENTITY_BORDER: Record<FinanceEntityId, string> = {
  private: 'border-blue-800/50',
  noisysource: 'border-emerald-800/50',
  noisyphocus: 'border-purple-800/50',
};

const MONTHS = 12;
const TYPE_LABELS: Record<string, string> = {
  income: 'Rendimento', expense: 'Despesa', transfer: 'Transf.',
  salary_credit: 'Salário', ec_payment: 'EC', ec_ts_submission: 'TS',
  tax_payment: 'Imposto', kidclub_revenue: 'KidClub', vacation: 'Férias',
};

// ── types ──────────────────────────────────────────────────────────────────────

interface EntityMonth {
  inCents: number;
  outCents: number;
  netCents: number;
  events: ComputedEvent[];
}

interface MonthData {
  ym: string;
  householdIn: number;
  householdOut: number;
  householdNet: number;
  projectedBalance: number;
  byEntity: Record<FinanceEntityId, EntityMonth>;
  events: ComputedEvent[];
}

// ── main component ─────────────────────────────────────────────────────────────

export default function ForecastPage() {
  const startYM = currentYM();

  const [allRecurring, setAllRecurring]             = useState<{ entry: RecurringEntryDoc; entityId: FinanceEntityId }[]>([]);
  const [allCredits, setAllCredits]                 = useState<{ contract: CreditContractDoc; entityId: FinanceEntityId }[]>([]);
  const [allAccounts, setAllAccounts]               = useState<{ account: Account; entityId: FinanceEntityId }[]>([]);
  const [employmentContracts, setEmploymentContracts] = useState<EmploymentContractDoc[]>([]);
  const [incomeSources, setIncomeSources]           = useState<IncomeSourceDoc[]>([]);
  const [ecContract, setEcContract]                 = useState<EcContractDoc | null>(null);
  const [peopleMap, setPeopleMap]                   = useState<Map<string, string>>(new Map());
  const [kidclubBilling, setKidclubBilling]         = useState<KidclubBillingRecord[]>([]);
  const [loading, setLoading]                       = useState(true);

  const [selectedYM, setSelectedYM]     = useState(startYM);
  const [entityFilter, setEntityFilter] = useState<FinanceEntityId | 'all'>('all');

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const recurringAll: typeof allRecurring = [];
        const creditsAll:   typeof allCredits   = [];
        const accountsAll:  typeof allAccounts  = [];

        for (const eid of ENTITY_IDS) {
          api.setEntity(eid);
          const [recs, creds, accs] = await Promise.all([
            api.recurring.listActive(),
            api.credits.listActive(),
            api.accounts.list(),
          ]);
          // exclude auto-generated entries (sourceId = linked to a contract)
          for (const e of recs) if (!e.sourceId) recurringAll.push({ entry: e, entityId: eid });
          for (const c of creds) creditsAll.push({ contract: c, entityId: eid });
          for (const a of accs) accountsAll.push({ account: a, entityId: eid });
        }

        // Active EC contract
        let activeEc: EcContractDoc | null = null;
        for (const eid of ENTITY_IDS) {
          api.setEntity(eid);
          const list = await api.ecContracts.list();
          const found = list.find((c: EcContractDoc) => c.active);
          if (found) { activeEc = found; break; }
        }

        api.setEntity('noisysource');
        const empContracts = await api.contracts.list() as EmploymentContractDoc[];

        api.setEntity('private');
        const [sources, people] = await Promise.all([
          api.incomeSources.list() as Promise<IncomeSourceDoc[]>,
          api.people.list() as Promise<{ id: string; name: string }[]>,
        ]);

        const billing = await api.kidclub.listBilling();

        setAllRecurring(recurringAll);
        setAllCredits(creditsAll);
        setAllAccounts(accountsAll);
        setEmploymentContracts(empContracts);
        setIncomeSources(sources);
        setEcContract(activeEc);
        setPeopleMap(new Map(people.map(p => [p.id, p.name])));
        setKidclubBilling(billing);
      } catch (e) {
        console.error('[Forecast] load failed:', e);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const allEvents = useMemo((): ComputedEvent[] => {
    const kc   = generateKidclubEvents(kidclubBilling, startYM, MONTHS);
    // Commission costs (EasyPay) = % of the KidClub revenue booked that month.
    const rec  = generateRecurringEvents(allRecurring, startYM, MONTHS, kidclubVolumeByMonth(kc));
    const cred = generateCreditEvents(allCredits, startYM, MONTHS);
    const emp  = generateEmploymentEvents(employmentContracts, peopleMap, startYM, MONTHS);
    const inc  = generateIncomeSourceEvents(incomeSources, startYM, MONTHS);
    const ec   = ecContract ? generateEcEvents(ecContract) : [];
    return [...rec, ...cred, ...emp, ...inc, ...ec, ...kc];
  }, [allRecurring, allCredits, employmentContracts, incomeSources, ecContract, peopleMap, kidclubBilling, startYM]);

  const startingBalance = useMemo(() =>
    allAccounts
      .filter(a => isCashLike(a.account.type) && a.account.balanceCents != null)
      .reduce((s, a) => s + (a.account.balanceCents ?? 0), 0),
    [allAccounts],
  );
  const hasStartingBalance = startingBalance !== 0;

  const monthData = useMemo((): MonthData[] => {
    let runningBalance = startingBalance;
    return Array.from({ length: MONTHS }, (_, i) => {
      const ym   = addMonths(startYM, i);
      const evts = allEvents.filter(e => e.date.startsWith(ym));

      const byEntity = Object.fromEntries(ENTITY_IDS.map(eid => {
        const ee = evts.filter(e => e.entityId === eid).sort((a, b) => a.date.localeCompare(b.date));
        return [eid, {
          inCents:  ee.filter(e => e.amountCents > 0).reduce((s, e) => s + e.amountCents, 0),
          outCents: ee.filter(e => e.amountCents < 0).reduce((s, e) => s + Math.abs(e.amountCents), 0),
          netCents: ee.reduce((s, e) => s + e.amountCents, 0),
          events:   ee,
        }];
      })) as Record<FinanceEntityId, EntityMonth>;

      const householdIn  = evts.filter(e => e.amountCents > 0).reduce((s, e) => s + e.amountCents, 0);
      const householdOut = evts.filter(e => e.amountCents < 0).reduce((s, e) => s + Math.abs(e.amountCents), 0);
      const householdNet = householdIn - householdOut;
      runningBalance += householdNet;

      return { ym, householdIn, householdOut, householdNet, projectedBalance: runningBalance, byEntity, events: evts };
    });
  }, [allEvents, startYM, startingBalance]);

  const selectedMonth = monthData.find(m => m.ym === selectedYM) ?? monthData[0];

  const filteredEvents = useMemo(() => {
    if (!selectedMonth) return [];
    return entityFilter === 'all'
      ? selectedMonth.events.slice().sort((a, b) => a.date.localeCompare(b.date))
      : selectedMonth.byEntity[entityFilter].events;
  }, [selectedMonth, entityFilter]);

  const yearNet = monthData.reduce((s, m) => s + m.householdNet, 0);
  const avgIn   = monthData.reduce((s, m) => s + m.householdIn, 0) / MONTHS;
  const avgOut  = monthData.reduce((s, m) => s + m.householdOut, 0) / MONTHS;

  const maxBar  = Math.max(...monthData.map(m => Math.max(m.householdIn, m.householdOut)), 1);

  if (loading) {
    return <div className="text-zinc-500 text-sm pt-8 text-center">A carregar previsão…</div>;
  }

  return (
    <div className="space-y-5">

      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="px-4 py-3">
          <div className="text-xs text-zinc-500 mb-1">Rendimento médio/mês</div>
          <div className="text-lg font-semibold tabular-nums text-emerald-400">{formatEUR(avgIn)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs text-zinc-500 mb-1">Despesas médias/mês</div>
          <div className="text-lg font-semibold tabular-nums text-red-400">{formatEUR(avgOut)}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs text-zinc-500 mb-1">Saldo líquido 12 meses</div>
          <div className={`text-lg font-semibold tabular-nums ${yearNet >= 0 ? 'text-white' : 'text-red-400'}`}>
            {yearNet >= 0 ? '+' : ''}{formatEUR(yearNet)}
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs text-zinc-500 mb-1">{hasStartingBalance ? 'Saldo projetado (12m)' : 'Saldo atual não definido'}</div>
          <div className={`text-lg font-semibold tabular-nums ${hasStartingBalance ? 'text-zinc-300' : 'text-zinc-600'}`}>
            {hasStartingBalance ? formatEUR(monthData.at(-1)!.projectedBalance) : '—'}
          </div>
        </Card>
      </div>

      {/* 12-month strip */}
      <div className="overflow-x-auto pb-1">
        <div className="flex gap-1.5 min-w-max">
          {monthData.map(m => {
            const isSelected = m.ym === selectedYM;
            const inH  = Math.max(Math.round((m.householdIn  / maxBar) * 40), m.householdIn  > 0 ? 4 : 0);
            const outH = Math.max(Math.round((m.householdOut / maxBar) * 40), m.householdOut > 0 ? 4 : 0);
            const isDeficit = m.householdNet < 0;

            return (
              <button
                key={m.ym}
                onClick={() => setSelectedYM(m.ym)}
                className={`flex flex-col items-center w-[84px] shrink-0 rounded-lg border px-2 pt-2 pb-2.5 text-xs transition-all ${
                  isSelected
                    ? 'border-zinc-500 bg-zinc-800 shadow-sm'
                    : 'border-zinc-800 bg-zinc-900/70 hover:bg-zinc-800/60 hover:border-zinc-700'
                }`}
              >
                <div className={`font-medium mb-2 ${isSelected ? 'text-white' : 'text-zinc-400'}`}>
                  {ymLabel(m.ym)}
                </div>

                {/* Mini bar chart */}
                <div className="flex items-end gap-1 h-10 mb-2 w-full justify-center">
                  <div className="w-[14px] rounded-t bg-emerald-800/80" style={{ height: `${inH}px` }} />
                  <div className="w-[14px] rounded-t bg-red-900/80"     style={{ height: `${outH}px` }} />
                </div>

                <div className="text-emerald-400 tabular-nums">{compactEUR(m.householdIn)}</div>
                <div className="text-red-400   tabular-nums">-{compactEUR(m.householdOut)}</div>
                <div className={`font-semibold tabular-nums mt-0.5 ${isDeficit ? 'text-red-400' : 'text-white'}`}>
                  {m.householdNet >= 0 ? '+' : ''}{compactEUR(m.householdNet)}
                </div>

                {hasStartingBalance && (
                  <div className="text-zinc-500 tabular-nums text-[10px] mt-1 border-t border-zinc-800 w-full text-center pt-1">
                    {compactEUR(m.projectedBalance)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Month detail */}
      {selectedMonth && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 className="text-base font-semibold">{ymLabel(selectedMonth.ym)}</h2>
              <div className="text-xs text-zinc-500 mt-0.5">
                <span className="text-emerald-400">+{formatEUR(selectedMonth.householdIn)}</span>
                {' · '}
                <span className="text-red-400">-{formatEUR(selectedMonth.householdOut)}</span>
                {' · '}
                <span className={selectedMonth.householdNet >= 0 ? 'text-white' : 'text-red-400'}>
                  {selectedMonth.householdNet >= 0 ? '+' : ''}{formatEUR(selectedMonth.householdNet)} líquido
                </span>
              </div>
            </div>

            {/* Entity filter */}
            <div className="flex gap-1 flex-wrap">
              {(['all', ...ENTITY_IDS] as const).map(eid => (
                <button
                  key={eid}
                  onClick={() => setEntityFilter(eid)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    entityFilter === eid
                      ? 'bg-zinc-700 border-zinc-500 text-white'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  {eid === 'all' ? 'Todos' : ENTITY_LABELS[eid]}
                </button>
              ))}
            </div>
          </div>

          {/* Entity breakdown row */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            {ENTITY_IDS.map(eid => {
              const em = selectedMonth.byEntity[eid];
              return (
                <Card key={eid} className={`px-3 py-2.5 border ${ENTITY_BORDER[eid]}`}>
                  <div className={`text-xs font-medium mb-1 ${ENTITY_COLORS[eid]}`}>{ENTITY_LABELS[eid]}</div>
                  <div className="text-xs text-zinc-500 tabular-nums">
                    {em.inCents > 0 && <span className="text-emerald-400/70">+{compactEUR(em.inCents)} </span>}
                    {em.outCents > 0 && <span className="text-red-400/70">-{compactEUR(em.outCents)}</span>}
                  </div>
                  <div className={`text-sm font-semibold tabular-nums mt-0.5 ${em.netCents >= 0 ? 'text-white' : 'text-red-400'}`}>
                    {em.netCents >= 0 ? '+' : ''}{formatEUR(em.netCents)}
                  </div>
                </Card>
              );
            })}
          </div>

          {/* Events list */}
          {filteredEvents.length === 0 ? (
            <div className="text-zinc-500 text-sm py-6 text-center">Sem eventos para este período.</div>
          ) : (
            <div className="space-y-1">
              {filteredEvents.map(e => {
                const isPositive = e.amountCents > 0;
                const typeLabel  = TYPE_LABELS[e.type] ?? e.type;
                return (
                  <div
                    key={e.key}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800"
                  >
                    {/* Day */}
                    <div className="text-xs text-zinc-600 w-5 text-center tabular-nums shrink-0">
                      {e.date.slice(8)}
                    </div>

                    {/* Entity badge */}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border bg-zinc-950 shrink-0 ${ENTITY_COLORS[e.entityId]} ${ENTITY_BORDER[e.entityId]}`}>
                      {ENTITY_LABELS[e.entityId]}
                    </span>

                    {/* Type badge */}
                    <span className="text-[10px] text-zinc-600 shrink-0">{typeLabel}</span>

                    {/* Description */}
                    <div className="flex-1 min-w-0 text-sm text-zinc-300 truncate">{e.description}</div>

                    {/* Amount */}
                    <div className={`text-sm font-semibold tabular-nums shrink-0 ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                      {isPositive ? '+' : '-'}{formatEUR(Math.abs(e.amountCents))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
