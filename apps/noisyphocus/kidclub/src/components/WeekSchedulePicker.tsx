import { useMemo } from 'react';
import { WeekPattern, activeWeeksInPattern } from '@shared/models/weekPattern';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { TransportationConfig } from '@shared/models/Transportation';
import { DiscountRule } from '@shared/models/Discount';
import { resolveAutoDiscounts } from '../services/discountService';
import PlacesInput from './PlacesInput';

const WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;
const WEEKDAY_LABELS: Record<string, string> = {
  monday: 'Segunda', tuesday: 'Terça', wednesday: 'Quarta', thursday: 'Quinta', friday: 'Sexta',
};
const WEEKDAY_SHORT: Record<string, string> = {
  monday: 'Seg', tuesday: 'Ter', wednesday: 'Qua', thursday: 'Qui', friday: 'Sex',
};
const JS_DAY: Record<string, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5,
};

const WEEK_NUMS = [1, 2, 3, 4] as const;
function weekIsActive(weekNum: 1 | 2 | 3 | 4, pattern: WeekPattern): boolean {
  if (pattern === 'all') return true;
  return pattern === 'odd' ? weekNum % 2 === 1 : weekNum % 2 === 0;
}

// Quarter-hour granularity: the real study-room timetable and transport
// routes run on :00/:15/:30/:45 (a 15:40 school pickup is recorded as 15:45,
// a 08:20 one as 08:15). A 30-minute grid could not represent those and
// forced every route onto a rounded hour, which is what made the Firestore
// schedules disagree with the manually-kept route sheet.
const buildTimes = (startHour: number, endHour: number): string[] => {
  const out: string[] = [];
  for (let h = startHour; h <= endHour; h++) {
    for (const m of [0, 15, 30, 45]) {
      if (h === endHour && m > 0) break;
      out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return out;
};

const ARRIVAL_TIMES = buildTimes(13, 19).filter(t => t >= '13:30');
const TRIP_TIMES = buildTimes(7, 20);

// Coimbra city centre — all address inputs are biased to this area
const COIMBRA_BIAS = { lat: 40.2033, lng: -8.4103, radiusMeters: 20000 };

export interface TransportTrip {
  time: string;
  pickupAddress: string;
  dropoffAddress: string;
}

export interface DayConfig {
  weekday: string;
  hour: string; // study room arrival time
  services: {
    study?: boolean;
    transportTrips?: TransportTrip[];
  };
}

export interface WeekScheduleValue {
  weekPattern: WeekPattern;
  days: DayConfig[];
}

interface TransportCoverage {
  weekday: string;
  direction: 'pickup' | 'dropoff' | 'both';
}

interface Props {
  value: WeekScheduleValue;
  onChange: (v: WeekScheduleValue) => void;
  availableServices: ('study' | 'transport')[];
  existingTransportCoverage?: TransportCoverage[];
  studyCenterConfig?: StudyCenterConfig | null;
  transportConfig?: TransportationConfig | null;
  discountRules?: DiscountRule[];
  /** Child's school name — used to auto-apply school discounts */
  schoolName?: string;
  /** Number of siblings already with an active transport subscription */
  activeSiblingCount?: number;
}

function patternLabel(p: WeekPattern) {
  return p === 'all' ? 'Todas as semanas' : p === 'odd' ? 'Semanas ímpares (1.ª e 3.ª)' : 'Semanas pares (2.ª e 4.ª)';
}

function newTrip(): TransportTrip {
  return { time: '08:00', pickupAddress: '', dropoffAddress: '' };
}

// Keep a thin local type for the price preview rows
interface Discount { label: string; pct: number; }

export function computeTransportDiscounts(
  days: DayConfig[],
  discountRules: DiscountRule[],
  schoolName?: string,
  activeSiblingCount?: number,
): Discount[] {
  return resolveAutoDiscounts(discountRules, 'transport', days, schoolName, activeSiblingCount)
    .map(d => ({ label: d.name, pct: d.percentage }));
}

export default function WeekSchedulePicker({
  value, onChange, availableServices, existingTransportCoverage = [],
  studyCenterConfig, transportConfig, discountRules = [], schoolName, activeSiblingCount,
}: Props) {

  const selectedWeekdays = new Set(value.days.map(d => d.weekday));
  const hasStudy = availableServices.includes('study');
  const hasTransport = availableServices.includes('transport');

  function toggleWeekday(weekday: string) {
    if (selectedWeekdays.has(weekday)) {
      onChange({ ...value, days: value.days.filter(d => d.weekday !== weekday) });
    } else {
      const covered = existingTransportCoverage.some(c => c.weekday === weekday);
      onChange({
        ...value,
        days: [...value.days, {
          weekday, hour: '16:00',
          services: {
            study: hasStudy ? true : undefined,
            transportTrips: hasTransport && !covered ? [newTrip()] : undefined,
          },
        }],
      });
    }
  }

  function updateDay(weekday: string, patch: Partial<DayConfig>) {
    onChange({ ...value, days: value.days.map(d => d.weekday === weekday ? { ...d, ...patch } : d) });
  }
  function toggleStudy(weekday: string) {
    const day = value.days.find(d => d.weekday === weekday)!;
    updateDay(weekday, { services: { ...day.services, study: !day.services.study } });
  }
  function toggleTransport(weekday: string) {
    const day = value.days.find(d => d.weekday === weekday)!;
    const hasTrips = (day.services.transportTrips?.length ?? 0) > 0;
    updateDay(weekday, { services: { ...day.services, transportTrips: hasTrips ? [] : [newTrip()] } });
  }
  function addTrip(weekday: string) {
    const day = value.days.find(d => d.weekday === weekday)!;
    updateDay(weekday, { services: { ...day.services, transportTrips: [...(day.services.transportTrips ?? []), newTrip()] } });
  }
  function removeTrip(weekday: string, idx: number) {
    const day = value.days.find(d => d.weekday === weekday)!;
    updateDay(weekday, { services: { ...day.services, transportTrips: day.services.transportTrips!.filter((_, i) => i !== idx) } });
  }
  function updateTrip(weekday: string, idx: number, patch: Partial<TransportTrip>) {
    const day = value.days.find(d => d.weekday === weekday)!;
    updateDay(weekday, {
      services: { ...day.services, transportTrips: day.services.transportTrips!.map((t, i) => i === idx ? { ...t, ...patch } : t) },
    });
  }

  const totalTrips = value.days.reduce((sum, d) => sum + (d.services.transportTrips?.length ?? 0), 0);

  const studyFee = useMemo(() => {
    if (!hasStudy || !studyCenterConfig) return 0;
    const studyDays = value.days.filter(d => d.services.study).length;
    const ratePerDay = studyCenterConfig.pricePerDayPerWeek != null && studyCenterConfig.weeksPerMonth != null
      ? studyCenterConfig.pricePerDayPerWeek * studyCenterConfig.weeksPerMonth
      : studyCenterConfig.monthlyPricePerWeekday;
    const weeksActive = activeWeeksInPattern(value.weekPattern);
    const weeksBase = studyCenterConfig.weeksPerMonth ?? 4;
    return studyDays * ratePerDay * (weeksActive / weeksBase);
  }, [value, studyCenterConfig, hasStudy]);

  const { transportFeeGross, discounts, transportFeeNet } = useMemo(() => {
    if (!hasTransport || !transportConfig || totalTrips === 0) {
      return { transportFeeGross: 0, discounts: [] as Discount[], transportFeeNet: 0 };
    }
    const gross = totalTrips * transportConfig.flatRatePerTrip * activeWeeksInPattern(value.weekPattern);
    const ds = computeTransportDiscounts(value.days, discountRules, schoolName, activeSiblingCount);
    const totalPct = Math.min(ds.reduce((s, d) => s + d.pct, 0), 1);
    return { transportFeeGross: gross, discounts: ds, transportFeeNet: gross * (1 - totalPct) };
  }, [value, transportConfig, hasTransport, totalTrips, discountRules, schoolName, activeSiblingCount]);

  const sortedDays = [...value.days].sort((a, b) => (JS_DAY[a.weekday] ?? 0) - (JS_DAY[b.weekday] ?? 0));
  const inputCls = 'border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 w-full';

  return (
    <div className="space-y-4">
      {/* Pattern selector */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Frequência</p>
        <div className="flex flex-col gap-2">
          {(['all', 'odd', 'even'] as WeekPattern[]).map(p => (
            <label key={p} className="flex items-center gap-3 cursor-pointer">
              <input type="radio" name="weekPattern" value={p}
                checked={value.weekPattern === p}
                onChange={() => onChange({ ...value, weekPattern: p })}
                className="accent-blue-600" />
              <span className={`text-sm ${value.weekPattern === p ? 'font-medium text-gray-900' : 'text-gray-500'}`}>
                {patternLabel(p)}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Two-column: grid left, config right */}
      <div className="grid grid-cols-2 gap-4 items-start">

        {/* Left: 4-week grid + price */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <p className="text-xs text-gray-400">Clique num dia para selecionar</p>
            </div>
            <div className="p-3">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="w-10" />
                    {WEEKDAY_NAMES.map(wd => (
                      <th key={wd} className="pb-1 px-1">
                        <button type="button" onClick={() => toggleWeekday(wd)}
                          className={`w-full text-xs font-semibold py-1.5 rounded-lg transition-colors ${
                            selectedWeekdays.has(wd)
                              ? 'bg-blue-600 text-white'
                              : 'text-gray-400 hover:bg-gray-100'
                          }`}>
                          {WEEKDAY_SHORT[wd]}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {WEEK_NUMS.map(wn => {
                    const active = weekIsActive(wn, value.weekPattern);
                    return (
                      <tr key={wn}>
                        <td className={`text-xs font-medium text-right pr-2 py-1 ${active ? 'text-gray-500' : 'text-gray-300'}`}>
                          Sem.{wn}
                        </td>
                        {WEEKDAY_NAMES.map(wd => {
                          const selected = selectedWeekdays.has(wd);
                          const covered = existingTransportCoverage.some(c => c.weekday === wd);
                          return (
                            <td key={wd} className="px-1 py-1">
                              <button type="button" onClick={() => active && toggleWeekday(wd)}
                                disabled={!active}
                                className={`w-full rounded-lg py-2 text-center transition-colors ${
                                  !active ? 'bg-gray-50 cursor-default' :
                                  selected ? 'bg-blue-100 hover:bg-blue-200' :
                                  'bg-gray-100 hover:bg-blue-50'
                                }`}>
                                {selected && active && (
                                  <span className={`text-xs ${covered ? 'text-green-500' : 'text-blue-500'}`}>
                                    {covered ? '🚌' : '✓'}
                                  </span>
                                )}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Price preview */}
          {sortedDays.length > 0 && (studyFee > 0 || transportFeeGross > 0) && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-blue-900 text-sm">Mensalidade</span>
                <span className="text-2xl font-bold text-blue-700">
                  €{(studyFee + transportFeeNet).toFixed(0)}
                </span>
              </div>
              <div className="text-xs text-blue-700 space-y-1">
                {studyFee > 0 && (
                  <div className="flex justify-between">
                    <span>📚 {value.days.filter(d => d.services.study).length} dia(s) · {value.weekPattern === 'all' ? '4 sem.' : '2 sem.'}</span>
                    <span>€{studyFee.toFixed(0)}</span>
                  </div>
                )}
                {transportFeeGross > 0 && (
                  <>
                    <div className="flex justify-between">
                      <span>🚌 {totalTrips} viagem(ns) · {value.weekPattern === 'all' ? '4 sem.' : '2 sem.'}</span>
                      <span className={discounts.length > 0 ? 'line-through text-blue-400' : ''}>
                        €{transportFeeGross.toFixed(0)}
                      </span>
                    </div>
                    {discounts.map((d, i) => (
                      <div key={i} className="flex justify-between text-green-700">
                        <span>✓ {d.label}</span>
                        <span>−€{(transportFeeGross * d.pct).toFixed(0)}</span>
                      </div>
                    ))}
                    {discounts.length > 0 && (
                      <div className="flex justify-between font-medium text-blue-800 pt-0.5 border-t border-blue-200">
                        <span>Transporte com desconto</span>
                        <span>€{transportFeeNet.toFixed(0)}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
              <p className="text-xs text-blue-400 pt-0.5">Valor fixo mensal</p>
            </div>
          )}
        </div>

        {/* Right: per-day config */}
        <div className="space-y-3">
          {sortedDays.length === 0 ? (
            <div className="bg-white rounded-xl border border-dashed border-gray-200 p-6 text-center text-sm text-gray-400">
              Selecione dias no calendário
            </div>
          ) : sortedDays.map(day => {
            const covered = existingTransportCoverage.some(c => c.weekday === day.weekday);
            const trips = day.services.transportTrips ?? [];
            const transportOn = trips.length > 0;

            return (
              <div key={day.weekday} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 border-b border-gray-100">
                  <span className="font-semibold text-sm text-gray-900">{WEEKDAY_LABELS[day.weekday]}</span>
                </div>

                <div className="divide-y divide-gray-100">
                  {/* Study room */}
                  {hasStudy && (
                    <div className="px-3 py-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-gray-700">📚 Sala de Estudo</span>
                        <button type="button" onClick={() => toggleStudy(day.weekday)}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${day.services.study ? 'bg-blue-600' : 'bg-gray-200'}`}>
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${day.services.study ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                      </div>
                      {day.services.study && (
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-500 whitespace-nowrap">Hora de chegada</label>
                          <select value={day.hour}
                            onChange={e => updateDay(day.weekday, { hour: e.target.value })}
                            className="border border-gray-200 rounded-lg px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400">
                            {ARRIVAL_TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Transport */}
                  {hasTransport && (
                    covered ? (
                      <div className="px-3 py-2.5 flex items-center gap-2 text-sm text-green-700">
                        <span>🚌</span><span>Transporte já contratado</span>
                      </div>
                    ) : (
                      <div className="px-3 py-2.5 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-gray-700">🚌 Transporte</span>
                          <button type="button" onClick={() => toggleTransport(day.weekday)}
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${transportOn ? 'bg-blue-600' : 'bg-gray-200'}`}>
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${transportOn ? 'translate-x-6' : 'translate-x-1'}`} />
                          </button>
                        </div>

                        {transportOn && (
                          <div className="space-y-2">
                            {trips.map((trip, idx) => (
                              <div key={idx} className="bg-gray-50 rounded-lg p-2.5 space-y-2">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <label className="text-xs text-gray-500">Hora</label>
                                    <select value={trip.time}
                                      onChange={e => updateTrip(day.weekday, idx, { time: e.target.value })}
                                      className="border border-gray-200 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400">
                                      {TRIP_TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                  </div>
                                  {trips.length > 1 && (
                                    <button type="button" onClick={() => removeTrip(day.weekday, idx)}
                                      className="text-gray-300 hover:text-red-400 text-lg leading-none ml-auto">×</button>
                                  )}
                                </div>
                                <PlacesInput value={trip.pickupAddress}
                                  onChange={v => updateTrip(day.weekday, idx, { pickupAddress: v })}
                                  placeholder="Origem" className={inputCls}
                                  locationBias={COIMBRA_BIAS} />
                                <PlacesInput value={trip.dropoffAddress}
                                  onChange={v => updateTrip(day.weekday, idx, { dropoffAddress: v })}
                                  placeholder="Destino" className={inputCls}
                                  locationBias={COIMBRA_BIAS} />
                              </div>
                            ))}
                            <button type="button" onClick={() => addTrip(day.weekday)}
                              className="text-xs text-blue-600 hover:text-blue-700 font-medium">
                              + Adicionar viagem
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
