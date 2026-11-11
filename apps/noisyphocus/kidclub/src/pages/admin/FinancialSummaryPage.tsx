import { useState, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { getDocs, getDoc, setDoc } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { col, docRef } from '../../lib/db';
import { TransportationConfig, TransportVehicle, vehiclesOf } from '@shared/models/Transportation';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { DiscountRule } from '@shared/models/Discount';
import { normalizeSubStatus, SubStatus } from '../../lib/utils';
import { getDiscountRules } from '../../services/discountService';
import { BillLine, toBillLines, lineNet, billPeriodKey, indexLinesBySub, standardLine, monthKey } from '../../lib/billingLines';
import {
  transportCosts, parseVehicleField, updateVehicle, addVehicle, removeVehicle, hourlyDriverMonthlyCost,
  HOURLY_DRIVER_RATE, HINT_WEEKS_PER_MONTH, VehicleField,
} from '../../lib/transportCosts';

interface AppliedDiscountLite { ruleId: string; name: string; percentage: number }

interface TransportSub {
  id: string;
  status: SubStatus;
  monthlyFee: number;
  appliedDiscounts: AppliedDiscountLite[];
  scheduleLength: number;
  familyId: string;
  childName: string;
  startDate: Date | null;
  endDate: Date | null;
}

interface StudySub {
  id: string;
  status: SubStatus;
  monthlyPrice: number;
  appliedDiscounts: AppliedDiscountLite[];
  daysCount: number;
  familyId: string;
  childName: string;
  startDate: Date | null;
  endDate: Date | null;
}

type ServiceFilter = 'both' | 'transport' | 'study';

interface Bill {
  id: string;
  familyId: string;
  periodKey: string;
  status: string;
  total: number;
  lines: BillLine[];
}

// Received = settled in Easypay; 'invoiced' is paid and already has its Vendus invoice.
const RECEIVED_STATUSES = ['paid', 'invoiced'];

type EntryKind = 'transport' | 'study' | 'enrollment';

/** One month of income from one subscription (or one enrollment-fee line). */
interface Entry {
  key: string;
  subId?: string;
  kind: EntryKind;
  month: string;
  familyId: string;
  childName: string;
  /** What the bill charges, after absences — or the estimate when there is no bill. */
  amount: number;
  received: boolean;
  /** No bill line this month; amount is the subscription's monthly estimate. */
  estimated: boolean;
  line?: BillLine;
}

const SERVICE_LABEL: Record<EntryKind, string> = {
  transport: 'Transporte',
  study: 'Sala de Estudo',
  enrollment: 'Inscrição',
};

// Study room fixed costs, one config field each. Transport costs are per vehicle
// (config/transportation → vehicles, see vehiclesOf) and have their own inputs below.
type CostFieldKey =
  | 'study.teacherMonthlyCost'
  | 'study.rentMonthlyCost';

const COST_FIELD_META: Record<CostFieldKey, { field: 'teacherMonthlyCost' | 'rentMonthlyCost' }> = {
  'study.teacherMonthlyCost': { field: 'teacherMonthlyCost' },
  'study.rentMonthlyCost': { field: 'rentMonthlyCost' },
};

/** A vehicle's inputs as typed, so a half-typed value isn't lost on re-render. */
type VehicleInputs = Record<VehicleField, string>;

// 0 shows as an empty input (blank saves as 0), so typing into a new vehicle doesn't give "0260".
const numInput = (n: number) => (n ? String(n) : '');
const toVehicleInputs = (v: TransportVehicle): VehicleInputs => ({
  label: v.label,
  seats: numInput(v.seats),
  vehicleMonthlyCost: numInput(v.vehicleMonthlyCost),
  driverMonthlyCost: numInput(v.driverMonthlyCost),
  electricityMonthlyCost: numInput(v.electricityMonthlyCost),
});

const newVehicleId = () => `v-${Date.now().toString(36)}`;

const ALL_STATUSES: SubStatus[] = ['active', 'pending', 'cancelled'];

const STATUS_LABEL: Record<SubStatus, string> = {
  active: 'Ativo',
  pending: 'Pendente',
  cancelled: 'Cancelado',
};

const STATUS_PILL_CLASS: Record<SubStatus, string> = {
  active: 'bg-green-100 text-green-700',
  pending: 'bg-yellow-100 text-yellow-700',
  cancelled: 'bg-gray-100 text-gray-500',
};

const PRESETS: { label: string; statuses: SubStatus[] }[] = [
  { label: 'Apenas ativos', statuses: ['active'] },
  { label: 'Ativos + pendentes', statuses: ['active', 'pending'] },
  { label: 'Tudo (incl. cancelados)', statuses: ['active', 'pending', 'cancelled'] },
];

function eur(n: number) {
  const abs = Math.abs(Math.round(n));
  return (n < 0 ? '−' : '') + '€' + abs.toLocaleString('pt-PT');
}

function sign(n: number) { return n >= 0 ? '+' : '−'; }

function samePreset(a: SubStatus[], b: SubStatus[]) {
  return a.length === b.length && a.every(s => b.includes(s));
}

// Firestore may hand back a Timestamp, an ISO/YYYY-MM-DD string, or (rarely)
// a plain Date, depending on which form wrote the doc — normalize all three.
function toJsDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw?.toDate === 'function') return raw.toDate();
  if (raw instanceof Date) return raw;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// month is 'all' or 'YYYY-MM'. A sub with no start/end on the relevant side
// is treated as open-ended (always overlaps) rather than excluded, since
// incomplete legacy data shouldn't silently vanish from the numbers.
function overlapsMonth(startDate: Date | null, endDate: Date | null, month: string): boolean {
  if (month === 'all') return true;
  const [y, m] = month.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);
  const startsBeforeMonthEnds = !startDate || startDate <= monthEnd;
  const endsAfterMonthStarts = !endDate || endDate >= monthStart;
  return startsBeforeMonthEnds && endsAfterMonthStarts;
}

function currentMonthStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function KPI({ label, value, sub, color = 'text-gray-900' }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function ScenarioRow({ label, revenue, cost, color }: {
  label: string; revenue: number; cost: number; color: string;
}) {
  const profit = revenue - cost;
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0 text-sm">
      <span className={`w-40 shrink-0 ${color}`}>{label}</span>
      <span className="font-mono text-blue-600 w-20 text-right">{eur(revenue)}</span>
      <span className="font-mono text-red-500 w-20 text-right">−{eur(cost)}</span>
      <span className={`font-mono font-semibold w-24 text-right ${profit >= 0 ? 'text-green-600' : 'text-red-500'}`}>
        {sign(profit)}{eur(Math.abs(profit))}
      </span>
    </div>
  );
}

function EditableCostRow({ label, value, saving, onChange, onSave }: {
  label: string; value: string; saving: boolean; onChange: (v: string) => void; onSave: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-gray-600">{label}</span>
      <div className="flex items-center gap-1.5">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">€</span>
          <input
            type="number"
            min="0"
            step="1"
            value={value}
            onChange={e => onChange(e.target.value)}
            onBlur={onSave}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className="w-28 pl-6 pr-2 py-1 text-sm border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-indigo-400"
          />
        </div>
        {saving && <span className="text-xs text-gray-400">…</span>}
      </div>
    </div>
  );
}

/** A vehicle's name and seats, saved on blur like the cost inputs. */
function VehicleHeaderRow({ label, seats, saving, onLabelChange, onLabelSave, onSeatsChange, onSeatsSave, onRemove }: {
  label: string; seats: string; saving: boolean;
  onLabelChange: (v: string) => void; onLabelSave: () => void;
  onSeatsChange: (v: string) => void; onSeatsSave: () => void;
  /** Absent for the last vehicle, which can't be removed. */
  onRemove?: () => void;
}) {
  const blurOnEnter = (e: ReactKeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); };
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <input
        type="text"
        value={label}
        aria-label="Nome da viatura"
        onChange={e => onLabelChange(e.target.value)}
        onBlur={onLabelSave}
        onKeyDown={blurOnEnter}
        className="min-w-0 flex-1 px-2 py-1 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-indigo-400"
      />
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min="0"
          step="1"
          value={seats}
          aria-label="Lugares para crianças"
          onChange={e => onSeatsChange(e.target.value)}
          onBlur={onSeatsSave}
          onKeyDown={blurOnEnter}
          className="w-14 px-2 py-1 text-sm border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-indigo-400"
        />
        <span className="text-xs text-gray-400" title="Crianças que leva, sem contar o motorista">lugares</span>
        {saving && <span className="text-xs text-gray-400">…</span>}
        {onRemove && (
          <button type="button" onClick={onRemove} title="Remover viatura" className="text-gray-300 hover:text-red-500 text-base leading-none px-1">×</button>
        )}
      </div>
    </div>
  );
}

/**
 * For a driver paid by the hour: hours a week × €6 × 4,33. A hint only: it never saves,
 * and it uses nothing but the hours typed into it.
 */
function HourlyDriverHint({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [hours, setHours] = useState('');
  const monthly = hourlyDriverMonthlyCost(hours);
  const fmt = (n: number) => n.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-indigo-600 hover:underline pb-1">
        Motorista à hora? Calcular
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-1 pb-1.5 text-[11px] text-gray-500">
      <span>Motorista à hora:</span>
      <input
        type="number"
        min="0"
        step="0.5"
        value={hours}
        aria-label="Horas por semana"
        onChange={e => setHours(e.target.value)}
        className="w-14 px-1.5 py-0.5 text-[11px] border border-gray-200 rounded outline-none focus:ring-1 focus:ring-indigo-400"
      />
      <span>
        h/semana × €{HOURLY_DRIVER_RATE} × {HINT_WEEKS_PER_MONTH.toLocaleString('pt-PT')} ={' '}
        <span className="font-mono font-semibold text-gray-700">{monthly != null ? `€${fmt(monthly)}` : '—'}</span>/mês
      </span>
    </div>
  );
}

export default function FinancialSummaryPage() {
  const [tConfig, setTConfig] = useState<TransportationConfig | null>(null);
  const [sConfig, setSConfig] = useState<StudyCenterConfig | null>(null);
  const [tSubs, setTSubs] = useState<TransportSub[]>([]);
  const [sSubs, setSSubs] = useState<StudySub[]>([]);
  const [families, setFamilies] = useState<Record<string, string>>({});
  const [bills, setBills] = useState<Bill[]>([]);
  const [rules, setRules] = useState<DiscountRule[]>([]);
  const [loading, setLoading] = useState(true);
  // Fixed-cost inputs — edited directly here, not derived from a planned
  // route snapshot. Keyed the same as CostFieldKey so one generic save
  // handler covers the study room's fields.
  const [costInputs, setCostInputs] = useState<Record<CostFieldKey, string>>({
    'study.teacherMonthlyCost': '',
    'study.rentMonthlyCost': '',
  });
  const [savingCostField, setSavingCostField] = useState<CostFieldKey | null>(null);
  // Transport fixed costs, per vehicle: inputs as typed, by vehicle id.
  const [vehicleInputs, setVehicleInputs] = useState<Record<string, VehicleInputs>>({});
  const [savingVehicle, setSavingVehicle] = useState<string | null>(null);
  const [vehicleError, setVehicleError] = useState<string | null>(null);
  // The list as last saved (or being saved). Every save starts from here rather than from
  // React state, so two quick edits in a row can't write over each other.
  const vehiclesRef = useRef<TransportVehicle[]>([]);

  // Filters — drive every revenue/count figure on the page. Default mirrors
  // the old "Receita Estimada" scenario (active + pending).
  const [statusFilter, setStatusFilter] = useState<SubStatus[]>(['active', 'pending']);
  const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('both');
  const [monthFilter, setMonthFilter] = useState<string>('all');
  // Which income counts in the totals: money already received, money still
  // expected (unpaid bills + estimates for unbilled subscriptions), or both.
  const [basis, setBasis] = useState({ received: true, forecast: true });
  const [detailOpen, setDetailOpen] = useState(false);
  // Discount scenario: ruleId -> simulated percentage (0-1). A rule absent from
  // the map keeps whatever percentage the subscription actually carries, so an
  // empty map reproduces today's revenue exactly. Setting a rule to 0 is the
  // "drop it entirely" case. Nothing here is ever written — it re-prices the
  // displayed figures so rate changes can be costed without touching a single
  // subscription.
  const [rates, setRates] = useState<Record<string, number>>({});

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const [tCfgSnap, sCfgSnap, tSnap, sSnap, familiesSnap, billingSnap, discountRules] = await Promise.all([
        getDoc(docRef('config', 'transportation')),
        getDoc(docRef('config', 'studyCenter')),
        getDocs(col('transportationSubscriptions')),
        getDocs(col('studyroom')),
        getDocs(col('families')),
        getDocs(col('billing')),
        getDiscountRules(),
      ]);
      setRules(discountRules ?? []);
      setBills(billingSnap.docs.map(d => {
        const x = d.data();
        return { id: d.id, familyId: x.familyId ?? '', periodKey: billPeriodKey(d.id, x.periodStart), status: x.status ?? '', total: x.total ?? 0, lines: toBillLines(x.lineItems) };
      }));

      let cfg: TransportationConfig | null = null;
      let sCfg: StudyCenterConfig | null = null;
      if (tCfgSnap.exists()) {
        cfg = tCfgSnap.data() as TransportationConfig;
        setTConfig(cfg);
      }
      if (sCfgSnap.exists()) {
        sCfg = sCfgSnap.data() as StudyCenterConfig;
        setSConfig(sCfg);
      }
      const vehicles = vehiclesOf(cfg);
      vehiclesRef.current = vehicles;
      setVehicleInputs(Object.fromEntries(vehicles.map(v => [v.id, toVehicleInputs(v)])));
      setCostInputs({
        'study.teacherMonthlyCost': sCfg?.teacherMonthlyCost != null ? String(sCfg.teacherMonthlyCost) : '',
        'study.rentMonthlyCost': sCfg?.rentMonthlyCost != null ? String(sCfg.rentMonthlyCost) : '',
      });

      const familyNames: Record<string, string> = {};
      for (const d of familiesSnap.docs) {
        const f = d.data();
        familyNames[d.id] = f.primaryContact?.name || '—';
      }
      setFamilies(familyNames);

      // Note: cancelled subs are now kept (not filtered out here) so the
      // status filter below can include them on request.
      setTSubs(tSnap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id,
          status: normalizeSubStatus(x.status),
          monthlyFee: x.monthlyFee ?? 0,
          appliedDiscounts: (x.appliedDiscounts ?? []) as AppliedDiscountLite[],
          scheduleLength: (x.schedule ?? []).length,
          familyId: x.familyId ?? '',
          childName: x.childName ?? '',
          startDate: toJsDate(x.startDate),
          endDate: toJsDate(x.endDate),
        };
      }));
      setSSubs(sSnap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id,
          status: normalizeSubStatus(x.status),
          appliedDiscounts: (x.appliedDiscounts ?? []) as AppliedDiscountLite[],
          monthlyPrice: x.monthlyPrice ?? 0,
          daysCount: (x.days ?? []).filter((dd: any) => dd.day).length,
          familyId: x.familyId ?? '',
          childName: x.childName ?? '',
          startDate: toJsDate(x.startDate),
          endDate: toJsDate(x.endDate),
        };
      }));
      setLoading(false);
    };
    load();
  }, []);

  // Each subscription's monthly amount comes from its billing line — the
  // selected month's, or (for "all periods") the current/next billed month's
  // — as amount + absenceCreditAmount: net of discounts, before absences.
  // That is what the engine charges under the subscription's own pricing
  // model. The stored monthlyFee/monthlyPrice is the flat (old-pricing)
  // figure and is only a fallback for a subscription with no bill yet
  // (e.g. still pending).
  const linesBySub = useMemo(() => indexLinesBySub(bills), [bills]);
  const lineFor = (id: string) => standardLine(linesBySub.get(id), monthFilter === 'all' ? undefined : monthFilter);

  const tAmountFor = (s: TransportSub) => {
    const line = lineFor(s.id);
    if (line) return lineNet(line);
    const flatRate = tConfig?.flatRatePerTrip ?? 0;
    const weeks = tConfig?.weeksPerMonth ?? 4.33;
    return s.monthlyFee > 0 ? s.monthlyFee : s.scheduleLength * flatRate * weeks;
  };

  const sAmountFor = (s: StudySub) => {
    const line = lineFor(s.id);
    if (line) return lineNet(line);
    const dayRate = sConfig?.monthlyPricePerWeekday ?? 24;
    // Prefer the stored price, which is NET of discounts, and only fall back
    // to the computed gross when there isn't one.
    return s.monthlyPrice > 0 ? s.monthlyPrice : s.daysCount * dayRate;
  };

  // ── Discount scenarios ────────────────────────────────────────────────────
  // Every simulated figure is the real monthly amount plus the change the
  // simulated rates make, so with nothing moved the scenario equals the page
  // above it to the cent, whatever rounding the engine did.
  //
  // Old pricing (and subs with no bill yet) is the flat model: gross − the
  // summed appliedDiscounts. Gross is derived from the net and those
  // discounts, so it is exact by construction.
  //
  // New pricing mirrors the engine's pipeline from the bill line's own
  // breakdown: multi-trip (scales with its rate) → sibling (on what multi-trip
  // leaves) → institutional % (school + manual/returning). Multi-trip and
  // sibling are structural there, so they come from the discount rules config,
  // not from appliedDiscounts.
  const pctOf = (ds: AppliedDiscountLite[], ov: Record<string, number>) =>
    Math.min(ds.reduce((n, d) => n + (ov[d.ruleId] ?? d.percentage), 0), 1);

  const grossOf = (net: number, ds: AppliedDiscountLite[]) => {
    const all = pctOf(ds, {});
    return all > 0 && all < 1 ? net / (1 - all) : net;
  };

  const flatAmount = (net: number, ds: AppliedDiscountLite[], ov: Record<string, number>) =>
    grossOf(net, ds) * (1 - pctOf(ds, ov));

  const structuralRule = (kind: 'transport' | 'study', trigger: 'auto_multitrip' | 'auto_sibling') =>
    rules.find(r => r.active && r.trigger === trigger && r.appliesTo?.includes(kind));

  const perTripAmount = (line: BillLine, ds: AppliedDiscountLite[], kind: 'transport' | 'study', ov: Record<string, number>) => {
    const multi = structuralRule(kind, 'auto_multitrip');
    const sibling = structuralRule(kind, 'auto_sibling');
    const mt = multi && multi.percentage > 0
      ? line.multiTripDiscountAmount * (ov[multi.id] ?? multi.percentage) / multi.percentage
      : line.multiTripDiscountAmount;
    const sib = sibling && line.siblingDiscountAmount > 0
      ? (line.grossAmount - mt) * (ov[sibling.id] ?? sibling.percentage)
      : line.siblingDiscountAmount;
    const structuralIds = new Set([multi?.id, sibling?.id]);
    const instDelta = ds.filter(d => !structuralIds.has(d.ruleId))
      .reduce((n, d) => n + (ov[d.ruleId] ?? d.percentage) - d.percentage, 0);
    const inst = Math.min(Math.max(line.institutionalDiscountPct + instDelta, 0), 1);
    return (line.grossAmount - mt - sib) * (1 - inst);
  };

  const scenarioAmount = (id: string, net: number, ds: AppliedDiscountLite[], kind: 'transport' | 'study', ov: Record<string, number>) => {
    const line = lineFor(id);
    const price = line && !line.legacyPricing
      ? (o: Record<string, number>) => perTripAmount(line, ds, kind, o)
      : (o: Record<string, number>) => flatAmount(net, ds, o);
    return Math.round((net + price(ov) - price({})) * 100) / 100;
  };

  /** Every discount rule actually in use, with what it currently costs. */
  const rulesInUse = useMemo(() => {
    const m = new Map<string, { ruleId: string; name: string; percentage: number; subs: number; worth: number }>();
    const add = (id: string, ds: AppliedDiscountLite[], net: number, kind: 'transport' | 'study') => {
      const line = lineFor(id);
      const used: { ruleId: string; name: string; percentage: number }[] = [...ds];
      if (line && !line.legacyPricing) {
        const multi = structuralRule(kind, 'auto_multitrip');
        const sibling = structuralRule(kind, 'auto_sibling');
        if (multi && line.multiTripDiscountAmount > 0 && !used.some(d => d.ruleId === multi.id)) used.push({ ruleId: multi.id, name: multi.name, percentage: multi.percentage });
        if (sibling && line.siblingDiscountAmount > 0 && !used.some(d => d.ruleId === sibling.id)) used.push({ ruleId: sibling.id, name: sibling.name, percentage: sibling.percentage });
      }
      for (const d of used) {
        const e = m.get(d.ruleId) ?? { ruleId: d.ruleId, name: d.name, percentage: d.percentage, subs: 0, worth: 0 };
        // What this one rule gives away on this subscription, holding the others.
        const worth = scenarioAmount(id, net, ds, kind, { [d.ruleId]: 0 }) - net;
        if (Math.abs(worth) < 0.005) continue;
        e.subs += 1;
        e.worth += worth;
        m.set(d.ruleId, e);
      }
    };
    for (const s of tSubs) if (s.status !== 'cancelled') add(s.id, s.appliedDiscounts, tAmountFor(s), 'transport');
    for (const s of sSubs) if (s.status !== 'cancelled') add(s.id, s.appliedDiscounts, sAmountFor(s), 'study');
    return [...m.values()].sort((a, b) => b.worth - a.worth);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tSubs, sSubs, linesBySub, rules, monthFilter]);

  const setRate = (id: string, pct: number) => setRates(prev => ({ ...prev, [id]: pct }));
  const clearRate = (id: string) => setRates(prev => { const n = { ...prev }; delete n[id]; return n; });
  /** Simulated percentage for a rule — its own value until someone moves the slider. */
  const rateOf = (r: { ruleId: string; percentage: number }) => rates[r.ruleId] ?? r.percentage;

  const tByStatus = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of tSubs) m[s.status] = (m[s.status] ?? 0) + 1;
    return m;
  }, [tSubs]);
  const sByStatus = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of sSubs) m[s.status] = (m[s.status] ?? 0) + 1;
    return m;
  }, [sSubs]);

  const showTransport = serviceFilter !== 'study';
  const showStudy = serviceFilter !== 'transport';

  // ── Income entries ────────────────────────────────────────────────────────
  // One entry per subscription per month (plus enrollment-fee lines), each
  // either RECEIVED (its bill is paid/invoiced) or FORESEEN (an unpaid bill,
  // or — for a subscription with no bill that month, e.g. still pending — its
  // monthly amount as an estimate). Amounts are what the bill charges, after
  // absences. Every total, the discount simulation and the detail table are
  // sums over these, so the Recebido/Previsto toggles move all of them.

  // The months the totals cover: one month, or every month that has a bill
  // (the school year). Fixed costs are monthly, so they scale with this.
  const monthsInScope = useMemo(() => monthFilter !== 'all'
    ? [monthFilter]
    : [...new Set(bills.filter(b => b.status !== 'cancelled' && b.periodKey).map(b => b.periodKey))].sort(),
  [bills, monthFilter]);
  const monthsCount = Math.max(1, monthsInScope.length);

  const subsById = useMemo(() => {
    const m = new Map<string, { kind: 'transport' | 'study'; sub: TransportSub | StudySub }>();
    for (const sub of tSubs) m.set(sub.id, { kind: 'transport', sub });
    for (const sub of sSubs) m.set(sub.id, { kind: 'study', sub });
    return m;
  }, [tSubs, sSubs]);

  const buildEntries = (statuses: SubStatus[]): Entry[] => {
    const out: Entry[] = [];
    const wanted = (kind: EntryKind) => kind === 'enrollment' ? serviceFilter === 'both' : kind === 'transport' ? showTransport : showStudy;
    for (const month of monthsInScope) {
      const billed = new Set<string>();
      for (const b of bills) {
        if (b.periodKey !== month || b.status === 'cancelled') continue;
        const received = RECEIVED_STATUSES.includes(b.status);
        b.lines.forEach((l, i) => {
          if (l.subscriptionId) billed.add(l.subscriptionId);
          const kind: EntryKind | null = l.type === 'enrollment' || l.type === 'study' || l.type === 'transport' ? l.type : null;
          if (!kind || !wanted(kind)) return;
          const owner = kind === 'enrollment' ? undefined : subsById.get(l.subscriptionId)?.sub;
          // Money received is a fact; the status filter only shapes what is still expected.
          if (!received && owner && !statuses.includes(owner.status)) return;
          out.push({
            key: `${b.id}#${i}`, subId: owner?.id, kind, month, familyId: b.familyId,
            childName: owner?.childName || l.title || '', amount: l.amount, received, estimated: false, line: l,
          });
        });
      }
      for (const { kind, sub } of subsById.values()) {
        if (!wanted(kind) || !statuses.includes(sub.status) || billed.has(sub.id)) continue;
        if (!overlapsMonth(sub.startDate, sub.endDate, month)) continue;
        const amount = kind === 'transport' ? tAmountFor(sub as TransportSub) : sAmountFor(sub as StudySub);
        if (amount <= 0) continue;
        out.push({
          key: `est-${sub.id}-${month}`, subId: sub.id, kind, month, familyId: sub.familyId,
          childName: sub.childName, amount, received: false, estimated: true, line: lineFor(sub.id),
        });
      }
    }
    return out;
  };

  const entries = useMemo(() => buildEntries(statusFilter),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [bills, subsById, statusFilter, monthsInScope, serviceFilter, linesBySub, tConfig, sConfig]);
  const activeEntries = useMemo(() => buildEntries(['active']),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [bills, subsById, monthsInScope, serviceFilter, linesBySub, tConfig, sConfig]);

  const counts = (e: Entry) => e.received ? basis.received : basis.forecast;
  const sumOf = (es: Entry[], pred: (e: Entry) => boolean = () => true) =>
    Math.round(es.filter(e => counts(e) && pred(e)).reduce((n, e) => n + e.amount, 0) * 100) / 100;

  const totalRevenue = sumOf(entries);
  const receivedRevenue = sumOf(entries, e => e.received);
  const forecastRevenue = sumOf(entries, e => !e.received);
  const tRevenue = sumOf(entries, e => e.kind === 'transport');
  const sRevenue = sumOf(entries, e => e.kind === 'study');
  const activeOnlyRevenue = sumOf(activeEntries);
  const subsCounted = (kind: EntryKind) => new Set(entries.filter(e => counts(e) && e.kind === kind).map(e => e.subId)).size;

  // Each vehicle's cost + driver + electricity, × months. An old doc with no vehicle list
  // is one van built from its single-van fields (vehiclesOf), so its figure is unchanged.
  const tCosts = transportCosts(tConfig, monthsCount);
  const tCost = tCosts.total;
  const teacherCost = (sConfig?.teacherMonthlyCost ?? 0) * monthsCount;
  const rentCost = (sConfig?.rentMonthlyCost ?? 0) * monthsCount;
  const sCost = teacherCost + rentCost;

  // Each entry re-priced at the simulated rates, as a factor on what it
  // actually charges (so absences scale with it). Exactly 1 with nothing moved.
  const scenarioFactor = (e: Entry, ov: Record<string, number>) => {
    const owner = e.subId ? subsById.get(e.subId) : undefined;
    if (!owner) return 1;
    const ds = owner.sub.appliedDiscounts;
    if (e.line && !e.line.legacyPricing) {
      const base = perTripAmount(e.line, ds, owner.kind, {});
      return base > 0 ? perTripAmount(e.line, ds, owner.kind, ov) / base : 1;
    }
    const base = 1 - pctOf(ds, {});
    return base > 0 ? (1 - pctOf(ds, ov)) / base : 1;
  };

  const scenarioRevenue = useMemo(() =>
    Math.round(entries.filter(counts).reduce((n, e) => n + e.amount * scenarioFactor(e, rates), 0) * 100) / 100,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [entries, rates, basis, rules]);

  const scenarioDelta = Math.round((scenarioRevenue - totalRevenue) * 100) / 100;
  const scenarioOn = rulesInUse.some(r => rateOf(r) !== r.percentage);
  const totalCost = (showTransport ? tCost : 0) + (showStudy ? sCost : 0);
  const totalProfit = totalRevenue - totalCost;
  // Costs are fixed monthly inputs — each vehicle's cost, driver and
  // electricity, teacher, rent — and none of them move with a discount. So every euro given away in
  // discounts is a euro straight off profit, and the margin swing is the whole
  // point of simulating a rate rather than just the revenue line.
  const scenarioProfit = Math.round((scenarioRevenue - totalCost) * 100) / 100;
  const scenarioMargin = scenarioRevenue > 0 ? scenarioProfit / scenarioRevenue : 0;
  /** Revenue needed to cover fixed costs, and what the scenario leaves against it. */
  const breakEvenGap = Math.round((totalCost - scenarioRevenue) * 100) / 100;
  const deltaVsActive = totalRevenue - activeOnlyRevenue;
  const isActiveOnlyFilter = samePreset(statusFilter, ['active']);

  const filterLabel = statusFilter.length === 0
    ? 'nenhum estado selecionado'
    : statusFilter.map(s => STATUS_LABEL[s]).join(' + ');

  const basisLabel = basis.received && basis.forecast ? 'recebido + previsto'
    : basis.received ? 'só recebido' : basis.forecast ? 'só previsto' : 'nada selecionado';

  const periodLabel = monthFilter === 'all'
    ? `ano letivo (${monthsInScope.length} meses)`
    : new Date(Number(monthFilter.split('-')[0]), Number(monthFilter.split('-')[1]) - 1, 1)
        .toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });

  interface DetailRow {
    key: string; parent: string; child: string; service: string; status?: SubStatus;
    received: number; forecast: number; estimated: boolean;
  }
  const detailRows = useMemo(() => {
    const m = new Map<string, DetailRow>();
    for (const e of entries) {
      if (!counts(e)) continue;
      const key = e.kind === 'enrollment' ? `fee-${e.familyId}` : e.subId ?? e.key;
      const owner = e.subId ? subsById.get(e.subId)?.sub : undefined;
      const row = m.get(key) ?? {
        key, parent: families[e.familyId] ?? '—',
        child: e.kind === 'enrollment' ? 'Taxas de inscrição' : (owner?.childName || e.childName || '—'),
        service: SERVICE_LABEL[e.kind], status: owner?.status, received: 0, forecast: 0, estimated: false,
      };
      if (e.received) row.received += e.amount; else row.forecast += e.amount;
      if (e.estimated) row.estimated = true;
      m.set(key, row);
    }
    return [...m.values()].sort((a, b) => (b.received + b.forecast) - (a.received + a.forecast));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, families, basis, subsById]);

  // Faturado / Recebido per month, straight from the bills: totals after
  // absences, enrollment fees included. Independent of the status filter
  // (a bill is a fact, not a subscription state); the service filter keeps
  // only that service's lines, so enrollment fees count under "Ambos" only.
  const billingByMonth = useMemo(() => {
    const m = new Map<string, { billed: number; received: number; count: number }>();
    for (const b of bills) {
      if (b.status === 'cancelled' || !b.periodKey) continue;
      const amount = serviceFilter === 'both'
        ? b.total
        : b.lines.filter(l => l.type === serviceFilter).reduce((n, l) => n + l.amount, 0);
      if (amount === 0 && serviceFilter !== 'both') continue;
      const e = m.get(b.periodKey) ?? { billed: 0, received: 0, count: 0 };
      e.billed += amount;
      if (RECEIVED_STATUSES.includes(b.status)) e.received += amount;
      e.count += 1;
      m.set(b.periodKey, e);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v }));
  }, [bills, serviceFilter]);

  const monthLabel = (key: string) => {
    const [y, mo] = key.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });
  };

  function toggleStatus(s: SubStatus) {
    setStatusFilter(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  }

  async function saveCostField(key: CostFieldKey) {
    const raw = costInputs[key].trim();
    const value = raw === '' ? 0 : parseFloat(raw);
    if (isNaN(value) || value < 0) return;
    const { field } = COST_FIELD_META[key];
    setSavingCostField(key);
    try {
      await setDoc(docRef('config', 'studyCenter'), { [field]: value }, { merge: true });
      setSConfig(prev => prev ? { ...prev, [field]: value } : prev);
      setCostInputs(prev => ({ ...prev, [key]: String(value) }));
    } finally {
      setSavingCostField(null);
    }
  }

  // ── Vehicles ──────────────────────────────────────────────────────────────
  // Any change writes the whole list to config/transportation → vehicles. On a doc
  // from before the list, the first write creates the van from the old fields as it
  // was (vehiclesOf), plus the change. The old fields stay in the doc, unread.
  async function writeVehicles(next: TransportVehicle[], key: string) {
    const prev = vehiclesRef.current;
    vehiclesRef.current = next;
    setTConfig(c => ({ ...(c ?? {}), vehicles: next }) as TransportationConfig);
    setSavingVehicle(key);
    setVehicleError(null);
    try {
      await setDoc(docRef('config', 'transportation'), { vehicles: next }, { merge: true });
    } catch (err) {
      console.error('[financial-summary] saving vehicles failed', err);
      // Back to what's stored, unless a later save has started since.
      if (vehiclesRef.current === next) {
        vehiclesRef.current = prev;
        setTConfig(c => ({ ...(c ?? {}), vehicles: prev }) as TransportationConfig);
        setVehicleInputs(Object.fromEntries(prev.map(v => [v.id, toVehicleInputs(v)])));
      }
      setVehicleError('Não foi possível guardar as viaturas. Tente novamente.');
    } finally {
      setSavingVehicle(s => (s === key ? null : s));
    }
  }

  async function saveVehicleField(id: string, field: VehicleField) {
    const current = vehiclesRef.current.find(v => v.id === id);
    if (!current) return;
    const value = parseVehicleField(field, vehicleInputs[id]?.[field] ?? '');
    const showStored = (v: TransportVehicle) =>
      setVehicleInputs(prev => ({ ...prev, [id]: { ...(prev[id] ?? toVehicleInputs(v)), [field]: toVehicleInputs(v)[field] } }));
    // Invalid or unchanged: show the stored value again, write nothing.
    if (value === null || value === current[field]) { showStored(current); return; }
    const next = updateVehicle(vehiclesRef.current, id, field, value);
    showStored(next.find(v => v.id === id) ?? current);
    await writeVehicles(next, `${id}.${field}`);
  }

  async function handleAddVehicle() {
    const next = addVehicle(vehiclesRef.current, newVehicleId());
    const added = next[next.length - 1];
    setVehicleInputs(prev => ({ ...prev, [added.id]: toVehicleInputs(added) }));
    await writeVehicles(next, 'add');
  }

  async function handleRemoveVehicle(v: TransportVehicle) {
    if (vehiclesRef.current.length <= 1) return;
    if (!window.confirm(`Remover "${v.label}" e os seus custos do Resumo Financeiro?`)) return;
    await writeVehicles(removeVehicle(vehiclesRef.current, v.id), `remove:${v.id}`);
  }

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-400">A carregar…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Resumo Financeiro</h1>
          <p className="text-sm text-gray-500 mt-0.5">Transporte + Sala de Estudo · todos os custos</p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Estado das inscrições</div>
            <div className="flex gap-1.5">
              {ALL_STATUSES.map(s => (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                    statusFilter.includes(s)
                      ? STATUS_PILL_CLASS[s] + ' border-transparent'
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Serviço</div>
            <div className="flex gap-1.5">
              {(['both', 'transport', 'study'] as ServiceFilter[]).map(f => (
                <button
                  key={f}
                  onClick={() => setServiceFilter(f)}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                    serviceFilter === f
                      ? 'bg-indigo-100 text-indigo-700 border-transparent'
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {f === 'both' ? 'Ambos' : f === 'transport' ? 'Transporte' : 'Sala de Estudo'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Atalhos</div>
            <div className="flex gap-1.5">
              {PRESETS.map(p => (
                <button
                  key={p.label}
                  onClick={() => setStatusFilter(p.statuses)}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                    samePreset(statusFilter, p.statuses)
                      ? 'bg-gray-900 text-white border-transparent'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Período</div>
            <div className="flex gap-1.5 items-center">
              <button
                onClick={() => setMonthFilter('all')}
                className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                  monthFilter === 'all'
                    ? 'bg-gray-900 text-white border-transparent'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                }`}
              >
                Ano letivo
              </button>
              <button
                onClick={() => setMonthFilter(currentMonthStr())}
                className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                  monthFilter === currentMonthStr()
                    ? 'bg-indigo-100 text-indigo-700 border-transparent'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                }`}
              >
                Este mês
              </button>
              <input
                type="month"
                value={monthFilter === 'all' ? '' : monthFilter}
                onChange={e => setMonthFilter(e.target.value || 'all')}
                className="text-xs px-2 py-1 border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-indigo-400"
              />
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">Receita</div>
            <div className="flex gap-1.5">
              {([['received', 'Recebido', 'bg-green-100 text-green-700'], ['forecast', 'Previsto', 'bg-blue-100 text-blue-700']] as const).map(([k, label, on]) => (
                <button
                  key={k}
                  onClick={() => setBasis(prev => ({ ...prev, [k]: !prev[k] }))}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
                    basis[k] ? on + ' border-transparent' : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="text-[11px] text-gray-400">
          Recebido: faturas pagas. Previsto: faturas por pagar + inscrições ainda sem fatura (estimativa).
          O estado das inscrições só filtra o previsto — o recebido conta sempre.
        </p>
      </div>

      {/* Combined KPIs — all driven by the filter above */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KPI
          label="Receita"
          value={eur(totalRevenue)}
          sub={`${eur(receivedRevenue)} recebido · ${eur(forecastRevenue)} previsto — ${periodLabel}`}
          color="text-blue-600"
        />
        <KPI
          label="Custos fixos"
          value={eur(totalCost)}
          sub={monthsCount > 1 ? `${eur(totalCost / monthsCount)}/mês × ${monthsCount} meses` : 'viaturas + motoristas + eletricidade + professora + renda'}
          color="text-red-600"
        />
        <KPI
          label="Lucro"
          value={`${sign(totalProfit)}${eur(Math.abs(totalProfit))}`}
          sub={totalRevenue > 0 ? (totalProfit >= 0 ? `${Math.round(totalProfit / totalRevenue * 100)}% margem` : 'deficit') : '—'}
          color={totalProfit >= 0 ? 'text-green-600' : 'text-red-600'}
        />
        <KPI
          label="Δ vs. apenas ativos"
          value={`${sign(deltaVsActive)}${eur(Math.abs(deltaVsActive))}`}
          sub={isActiveOnlyFilter ? 'filtro atual = ativos' : 'receita adicional incluída pelo filtro'}
          color={deltaVsActive === 0 ? 'text-gray-500' : deltaVsActive > 0 ? 'text-indigo-600' : 'text-red-600'}
        />
      </div>

      {/* P&L table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Demonstração de resultados</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Receita {basisLabel} · {filterLabel} · {periodLabel}. Valores das faturas (após faltas, com o tarifário de cada inscrição); inscrições sem fatura entram como estimativa.
          </p>
        </div>
        <div className="px-5 py-3">
          <div className="flex items-center justify-between pb-2 border-b border-gray-200 text-xs font-semibold text-gray-400 uppercase tracking-wide">
            <span className="w-40">Cenário</span>
            <span className="w-20 text-right">Receita</span>
            <span className="w-20 text-right">Custos</span>
            <span className="w-24 text-right">Lucro</span>
          </div>
          <ScenarioRow label={`Filtro atual (${basisLabel})`} revenue={totalRevenue} cost={totalCost} color="text-blue-600" />
          {!isActiveOnlyFilter && (
            <ScenarioRow label="Referência: apenas ativos" revenue={activeOnlyRevenue} cost={totalCost} color="text-gray-400" />
          )}
          {scenarioOn && (
            <ScenarioRow label="Simulação de descontos" revenue={scenarioRevenue} cost={totalCost} color="text-amber-700" />
          )}
          {deltaVsActive > 0 && (
            <div className="pt-2 text-xs text-gray-400">
              Face a "apenas ativos": <span className="font-semibold text-gray-600">{eur(deltaVsActive)}</span> de receita adicional incluída pelo filtro
            </div>
          )}
        </div>
      </div>

      {/* Billed vs received, per month — from the bills themselves */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Faturação por mês</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Faturado: total das faturas do mês (após faltas, com taxas de inscrição). Recebido: faturas pagas. Não depende do filtro de estado.
          </p>
        </div>
        {billingByMonth.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-gray-400">Sem faturas.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-200">
                  <th className="text-left px-5 py-2">Mês</th>
                  <th className="text-right px-5 py-2">Faturas</th>
                  <th className="text-right px-5 py-2">Faturado</th>
                  <th className="text-right px-5 py-2">Recebido</th>
                  <th className="text-right px-5 py-2">Por receber</th>
                </tr>
              </thead>
              <tbody>
                {billingByMonth.map(r => {
                  const selected = r.month === monthFilter;
                  const current = r.month === monthKey();
                  return (
                    <tr key={r.month} className={`border-b border-gray-50 last:border-0 ${selected ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
                      <td className="px-5 py-1.5 text-gray-700 capitalize">
                        <button onClick={() => setMonthFilter(r.month)} className="hover:underline capitalize">{monthLabel(r.month)}</button>
                        {current && <span className="ml-2 text-[10px] text-indigo-600 font-semibold uppercase">atual</span>}
                      </td>
                      <td className="px-5 py-1.5 text-right text-gray-400 tabular-nums">{r.count}</td>
                      <td className="px-5 py-1.5 text-right font-mono text-blue-600 tabular-nums">{eur(r.billed)}</td>
                      <td className="px-5 py-1.5 text-right font-mono text-green-600 tabular-nums">{eur(r.received)}</td>
                      <td className={`px-5 py-1.5 text-right font-mono tabular-nums ${r.billed - r.received > 0.005 ? 'text-amber-700' : 'text-gray-300'}`}>
                        {eur(r.billed - r.received)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Discount scenarios — simulation only, nothing is written */}
      {rulesInUse.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Simular descontos</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Ajuste as percentagens para ver o efeito na receita. Zero remove o desconto. Simulação apenas — nenhuma inscrição é alterada.
              </p>
            </div>
            {scenarioOn && (
              <button
                onClick={() => setRates({})}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors"
              >
                Repor
              </button>
            )}
          </div>

          <div className="px-5 py-3 grid gap-3 sm:grid-cols-2">
            {rulesInUse.map(r => {
              const pct = rateOf(r);
              const moved = pct !== r.percentage;
              const gone = pct === 0;
              return (
                <div
                  key={r.ruleId}
                  className={`rounded-lg border p-3 transition-colors ${
                    moved ? 'bg-amber-50 border-amber-300' : 'bg-white border-gray-200'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-gray-700">{r.name}</span>
                    <span className={`font-mono text-sm font-semibold tabular-nums ${
                      gone ? 'text-red-600' : moved ? 'text-amber-800' : 'text-gray-900'
                    }`}>
                      {(pct * 100).toFixed(1)}%
                    </span>
                  </div>

                  <input
                    id={`rate-${r.ruleId}`}
                    type="range"
                    min={0}
                    max={50}
                    step={2.5}
                    value={pct * 100}
                    onChange={e => setRate(r.ruleId, Number(e.target.value) / 100)}
                    aria-label={`${r.name} — percentagem simulada`}
                    className="w-full mt-2 accent-indigo-600 cursor-pointer"
                  />

                  <div className="flex items-baseline justify-between gap-2 mt-1">
                    <span className="text-[11px] text-gray-400">
                      atual {(r.percentage * 100).toFixed(1)}% · {r.subs} inscriç{r.subs === 1 ? 'ão' : 'ões'} · vale {eur(Math.abs(r.worth))}/mês
                    </span>
                    {moved && (
                      <button
                        onClick={() => clearRate(r.ruleId)}
                        className="text-[11px] text-amber-700 hover:underline whitespace-nowrap"
                      >
                        repor
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
              <div>
                <div className="text-[11px] text-gray-400 uppercase tracking-wide font-semibold">Receita</div>
                <div className="font-mono text-base font-semibold text-blue-600 tabular-nums">{eur(scenarioRevenue)}</div>
                {scenarioOn && (
                  <div className={`font-mono text-[11px] tabular-nums ${scenarioDelta >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {scenarioDelta >= 0 ? '+' : ''}{eur(scenarioDelta)}
                  </div>
                )}
              </div>
              <div>
                <div className="text-[11px] text-gray-400 uppercase tracking-wide font-semibold">Custos</div>
                <div className="font-mono text-base font-semibold text-red-500 tabular-nums">−{eur(totalCost)}</div>
                <div className="text-[11px] text-gray-400">fixos — não variam</div>
              </div>
              <div>
                <div className="text-[11px] text-gray-400 uppercase tracking-wide font-semibold">Lucro</div>
                <div className={`font-mono text-base font-semibold tabular-nums ${scenarioProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {eur(scenarioProfit)}
                </div>
                {scenarioOn && (
                  <div className={`font-mono text-[11px] tabular-nums ${scenarioDelta >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {scenarioDelta >= 0 ? '+' : ''}{eur(scenarioDelta)} face a {eur(totalProfit)}
                  </div>
                )}
              </div>
              <div>
                <div className="text-[11px] text-gray-400 uppercase tracking-wide font-semibold">Margem</div>
                <div className={`font-mono text-base font-semibold tabular-nums ${scenarioMargin >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {(scenarioMargin * 100).toFixed(1)}%
                </div>
                <div className="text-[11px] text-gray-400">
                  {scenarioOn ? `atual ${(totalRevenue > 0 ? totalProfit / totalRevenue * 100 : 0).toFixed(1)}%` : 'nenhuma alteração'}
                </div>
              </div>
            </div>

            <div className={`mt-3 pt-3 border-t border-gray-200 text-xs ${breakEvenGap > 0 ? 'text-red-700' : 'text-green-700'}`}>
              {breakEvenGap > 0 ? (
                <>
                  <span className="font-semibold">Abaixo do break-even.</span>{' '}
                  Faltam <span className="font-mono font-semibold">{eur(breakEvenGap)}</span> de receita para cobrir os custos fixos de {eur(totalCost)}.
                  {' '}Como os custos não variam com descontos, cada euro de desconto é um euro de lucro.
                </>
              ) : (
                <>
                  <span className="font-semibold">Acima do break-even</span> por{' '}
                  <span className="font-mono font-semibold">{eur(Math.abs(breakEvenGap))}</span> face aos custos fixos de {eur(totalCost)}.
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Revenue detail — collapsible, line-by-line origin of the "Receita" figure */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <button
          onClick={() => setDetailOpen(o => !o)}
          className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
        >
          <div>
            <h2 className="text-sm font-semibold text-gray-700">Detalhe da receita</h2>
            <p className="text-xs text-gray-400 mt-0.5">{detailRows.length} linhas — {basisLabel} · {filterLabel} · {periodLabel}</p>
          </div>
          <span className={`text-gray-400 transition-transform ${detailOpen ? 'rotate-180' : ''}`}>▾</span>
        </button>
        {detailOpen && (
          <div className="border-t border-gray-100 max-h-96 overflow-y-auto">
            {detailRows.length === 0 ? (
              <div className="px-5 py-6 text-center text-sm text-gray-400">Sem inscrições para este filtro.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-200">
                    <th className="text-left px-5 py-2">Encarregado</th>
                    <th className="text-left px-5 py-2">Criança</th>
                    <th className="text-left px-5 py-2">Serviço</th>
                    <th className="text-left px-5 py-2">Estado</th>
                    <th className="text-right px-5 py-2">Recebido</th>
                    <th className="text-right px-5 py-2">Previsto</th>
                    <th className="text-right px-5 py-2">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map(row => (
                    <tr key={row.key} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                      <td className="px-5 py-2 text-gray-700">{row.parent}</td>
                      <td className="px-5 py-2 text-gray-500">{row.child}</td>
                      <td className="px-5 py-2 text-gray-500">{row.service}</td>
                      <td className="px-5 py-2">
                        {row.status && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_PILL_CLASS[row.status]}`}>
                            {STATUS_LABEL[row.status]}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-2 text-right font-mono text-green-600">{row.received ? eur(row.received) : '—'}</td>
                      <td className="px-5 py-2 text-right font-mono text-blue-600"
                        title={row.estimated ? 'Inclui estimativa (inscrição sem fatura neste mês)' : undefined}>
                        {row.forecast ? `${row.estimated ? '≈ ' : ''}${eur(row.forecast)}` : '—'}
                      </td>
                      <td className="px-5 py-2 text-right font-mono text-gray-800">{eur(row.received + row.forecast)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-200 font-semibold">
                    <td className="px-5 py-2 text-gray-700" colSpan={4}>Total</td>
                    <td className="px-5 py-2 text-right font-mono text-green-600">{eur(receivedRevenue)}</td>
                    <td className="px-5 py-2 text-right font-mono text-blue-600">{eur(forecastRevenue)}</td>
                    <td className="px-5 py-2 text-right font-mono text-gray-800">{eur(totalRevenue)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Service breakdown */}
      <div className={`grid grid-cols-1 gap-4 ${showTransport && showStudy ? 'md:grid-cols-2' : ''}`}>
        {/* Transport */}
        {showTransport && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">🚌 Transporte</h2>
            <Link to="/admin/transportes" className="text-xs text-indigo-600 hover:underline">Ver quadro →</Link>
          </div>
          <div className="px-5 py-4 space-y-3">
            <div>
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Receita (filtro atual)</div>
              <div className="text-xl font-bold text-blue-600">{eur(tRevenue)}</div>
              <div className="text-xs text-gray-400">{subsCounted('transport')} inscrições — {basisLabel}</div>
            </div>

            {/* Status pills */}
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(tByStatus).sort().map(([status, n]) => (
                <span key={status} className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_PILL_CLASS[status as SubStatus] ?? 'bg-gray-100 text-gray-500'}`}>
                  {n} {STATUS_LABEL[status as SubStatus] ?? status}
                </span>
              ))}
            </div>

            {/* Costs per vehicle — read-only here; edited in the "Custos Fixos" panel below */}
            <div className="pt-2 border-t border-gray-100 text-xs text-gray-500 space-y-1">
              {tCosts.perVehicle.map(c => (
                <div key={c.vehicle.id} className="space-y-1">
                  <div className="flex justify-between font-medium text-gray-600">
                    <span>{c.vehicle.label} <span className="font-normal text-gray-400">· {c.vehicle.seats} lugares</span></span>
                    <span className="font-mono text-red-500">{eur(c.total)}</span>
                  </div>
                  <div className="flex justify-between pl-3">
                    <span>Viatura</span>
                    <span className="font-mono text-red-500">{eur(c.vehicleCost)}</span>
                  </div>
                  <div className="flex justify-between pl-3">
                    <span>Motorista</span>
                    <span className="font-mono text-red-500">{eur(c.driverCost)}</span>
                  </div>
                  <div className="flex justify-between pl-3">
                    <span>Eletricidade</span>
                    <span className="font-mono text-red-500">{eur(c.electricityCost)}</span>
                  </div>
                </div>
              ))}
              <div className="flex justify-between font-semibold border-t border-gray-100 pt-1 mt-1">
                <span>Total transporte{tCosts.perVehicle.length > 1 ? ` (${tCosts.perVehicle.length} viaturas)` : ''}</span>
                <span className="font-mono text-red-500">{eur(tCost)}</span>
              </div>
            </div>

            {tConfig?.flatRatePerTrip && (
              <div className="text-xs text-gray-400">
                €{tConfig.flatRatePerTrip}/viagem × {tConfig.weeksPerMonth} sem
              </div>
            )}
          </div>
        </div>
        )}

        {/* Study Room */}
        {showStudy && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">📚 Sala de Estudo</h2>
            <Link to="/admin/study-room-planner" className="text-xs text-indigo-600 hover:underline">Ver planeador →</Link>
          </div>
          <div className="px-5 py-4 space-y-3">
            <div>
              <div className="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1">Receita (filtro atual)</div>
              <div className="text-xl font-bold text-blue-600">{eur(sRevenue)}</div>
              <div className="text-xs text-gray-400">{subsCounted('study')} inscrições — {basisLabel}</div>
            </div>

            {/* Status pills */}
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(sByStatus).sort().map(([status, n]) => (
                <span key={status} className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_PILL_CLASS[status as SubStatus] ?? 'bg-gray-100 text-gray-500'}`}>
                  {n} {STATUS_LABEL[status as SubStatus] ?? status}
                </span>
              ))}
            </div>

            {/* Costs */}
            <div className="pt-2 border-t border-gray-100 text-xs text-gray-500 space-y-1">
              <div className="flex justify-between">
                <span>Professora</span>
                <span className="font-mono text-red-500">{eur(teacherCost)}</span>
              </div>
              <div className="flex justify-between">
                <span>Renda</span>
                <span className="font-mono text-red-500">{eur(rentCost)}</span>
              </div>
              <div className="flex justify-between font-semibold border-t border-gray-100 pt-1 mt-1">
                <span>Total sala</span>
                <span className="font-mono text-red-500">{eur(sCost)}</span>
              </div>
            </div>

            {sConfig?.pricePerDayPerWeek != null && (
              <div className="text-xs text-gray-400">
                €{sConfig.pricePerDayPerWeek}/dia × {sConfig.weeksPerMonth} sem
              </div>
            )}
          </div>
        </div>
        )}
      </div>
      {/* Fixed costs — edited here directly, independent of the Transport Planner.
          The planner only estimates cost while planning a route; it never feeds
          these numbers, so the P&L stays correct even with no route ever saved. */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Custos Fixos (por mês)</h2>
          <p className="text-xs text-gray-400 mt-0.5">Editar diretamente aqui — não depende do planeador de rotas. Os totais acima multiplicam pelo número de meses do período.</p>
        </div>
        <div className="px-5 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-8 divide-y sm:divide-y-0 divide-gray-100">
          <div className="divide-y divide-gray-100">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide pt-2 pb-1">🚌 Transporte</div>
            {vehiclesOf(tConfig).map(v => {
              const inputs = vehicleInputs[v.id] ?? toVehicleInputs(v);
              const setInput = (field: VehicleField, value: string) =>
                setVehicleInputs(prev => ({ ...prev, [v.id]: { ...(prev[v.id] ?? toVehicleInputs(v)), [field]: value } }));
              const costRow = (field: 'vehicleMonthlyCost' | 'driverMonthlyCost' | 'electricityMonthlyCost', label: string) => (
                <EditableCostRow
                  label={label}
                  value={inputs[field]}
                  saving={savingVehicle === `${v.id}.${field}`}
                  onChange={value => setInput(field, value)}
                  onSave={() => saveVehicleField(v.id, field)}
                />
              );
              return (
                <div key={v.id} className="py-1">
                  <VehicleHeaderRow
                    label={inputs.label}
                    seats={inputs.seats}
                    saving={savingVehicle === `${v.id}.label` || savingVehicle === `${v.id}.seats` || savingVehicle === `remove:${v.id}`}
                    onLabelChange={value => setInput('label', value)}
                    onLabelSave={() => saveVehicleField(v.id, 'label')}
                    onSeatsChange={value => setInput('seats', value)}
                    onSeatsSave={() => saveVehicleField(v.id, 'seats')}
                    onRemove={vehiclesOf(tConfig).length > 1 ? () => handleRemoveVehicle(v) : undefined}
                  />
                  <div className="pl-3">
                    {costRow('vehicleMonthlyCost', 'Viatura')}
                    {costRow('driverMonthlyCost', 'Motorista')}
                    <HourlyDriverHint initiallyOpen={v.driverMonthlyCost === 0} />
                    {costRow('electricityMonthlyCost', 'Eletricidade')}
                  </div>
                </div>
              );
            })}
            <div className="py-2 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleAddVehicle}
                disabled={savingVehicle === 'add'}
                className="text-xs text-indigo-600 hover:underline disabled:text-gray-400"
              >
                + Adicionar viatura
              </button>
              {savingVehicle === 'add' && <span className="text-xs text-gray-400">…</span>}
              {vehicleError && <span className="text-xs text-red-600">{vehicleError}</span>}
            </div>
          </div>
          <div className="divide-y divide-gray-100">
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide pt-2 pb-1">📚 Sala de Estudo</div>
            <EditableCostRow
              label="Professora"
              value={costInputs['study.teacherMonthlyCost']}
              saving={savingCostField === 'study.teacherMonthlyCost'}
              onChange={v => setCostInputs(prev => ({ ...prev, 'study.teacherMonthlyCost': v }))}
              onSave={() => saveCostField('study.teacherMonthlyCost')}
            />
            <EditableCostRow
              label="Renda"
              value={costInputs['study.rentMonthlyCost']}
              saving={savingCostField === 'study.rentMonthlyCost'}
              onChange={v => setCostInputs(prev => ({ ...prev, 'study.rentMonthlyCost': v }))}
              onSave={() => saveCostField('study.rentMonthlyCost')}
            />
          </div>
        </div>
      </div>

    </div>
  );
}
