import { BatteryFull, Gauge, Receipt, Zap } from 'lucide-react';
import type { TeslaChargingResult } from '../../lib/firebase';

const card = 'rounded-2xl bg-zinc-900 border border-zinc-800';
const eur = (v: number, digits = 2) => v.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits });
const kwh = (v: number) => `${v.toLocaleString('pt-PT', { maximumFractionDigits: 1 })} kWh`;
const day = (ms: number) => new Date(ms).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', timeZone: 'Europe/Lisbon' });
const dayTime = (ms: number) => new Date(ms).toLocaleString('pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' });
const monthName = (ym: string) => {
  const t = new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
};

interface Props {
  vin: string;
  data: TeslaChargingResult | null;
  loading: boolean;
}

/**
 * Below the car: what charging cost, what the car uses, and how the battery is
 * holding up. Supercharger sessions come from Tesla's charging history; home
 * charging (the Schuko) isn't in it yet, so consumption is only shown over
 * stretches Tesla can see, and says so.
 */
export default function ChargingSection({ vin, data, loading }: Props) {
  if (!data) {
    return loading ? <p className="text-sm text-zinc-500">A ler os carregamentos…</p> : null;
  }
  const car = data.cars.find(c => c.vin === vin);
  const sessions = data.sessions.filter(s => !s.vin || s.vin === vin);
  const thisMonth = car?.months[0];

  return (
    <div className="flex flex-col gap-4">
      {data.error && (
        <p className={`${card} p-4 text-sm text-amber-200`}>Histórico de carregamentos: {data.error}</p>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <section className={`${card} p-5 flex flex-col gap-2`}>
          <h3 className="text-sm text-zinc-400 flex items-center gap-1.5"><Receipt size={15} /> Superchargers{thisMonth ? `, ${monthName(thisMonth.month).toLowerCase()}` : ''}</h3>
          {thisMonth ? (
            <>
              <span className="text-3xl font-semibold text-zinc-50 tabular-nums">{eur(thisMonth.cost)}</span>
              <span className="text-sm text-zinc-400">
                {thisMonth.sessions} {thisMonth.sessions === 1 ? 'carregamento' : 'carregamentos'} · {kwh(thisMonth.kwh)}
                {thisMonth.perKwh !== undefined && ` · ${eur(thisMonth.perKwh, 3)}/kWh`}
              </span>
            </>
          ) : <span className="text-sm text-zinc-400">Sem carregamentos pagos à Tesla no último ano.</span>}
        </section>

        <section className={`${card} p-5 flex flex-col gap-2`}>
          <h3 className="text-sm text-zinc-400 flex items-center gap-1.5"><Gauge size={15} /> Consumo</h3>
          {car?.consumption ? (
            <>
              <span className="text-3xl font-semibold text-zinc-50 tabular-nums">{car.consumption.whPerKm} Wh/km</span>
              <span className="text-sm text-zinc-400">
                {eur(car.consumption.per100Km)} por 100 km · {car.consumption.km.toLocaleString('pt-PT')} km entre {day(car.consumption.from)} e {day(car.consumption.to)}
              </span>
              <span className="text-xs text-zinc-500">Conta só os carregamentos pagos à Tesla: se carregou em casa pelo meio, o real é mais.</span>
            </>
          ) : (
            <span className="text-sm text-zinc-400">
              Aparece depois de dois carregamentos com o carro lido perto de cada um (abra Carros quando carrega).
            </span>
          )}
        </section>

        <section className={`${card} p-5 flex flex-col gap-2`}>
          <h3 className="text-sm text-zinc-400 flex items-center gap-1.5"><BatteryFull size={15} /> Bateria</h3>
          {car?.fullRangeKm ? (
            <>
              <span className="text-3xl font-semibold text-zinc-50 tabular-nums">{car.fullRangeKm} km a 100%</span>
              <span className="text-sm text-zinc-400">
                {car.capacityKwh ? `Capacidade estimada ~${car.capacityKwh} kWh (inclui perdas de carregamento).` : 'A capacidade (kWh) aparece com duas leituras durante um carregamento, com 5% ou mais entre elas.'}
              </span>
              {car.fullRangeByMonth.length > 1 && (
                <span className="text-xs text-zinc-500">
                  {car.fullRangeByMonth.slice(-6).map(m => `${m.month.slice(5)}/${m.month.slice(2, 4)}: ${m.km} km`).join(' · ')}
                </span>
              )}
            </>
          ) : <span className="text-sm text-zinc-400">Aparece com a primeira leitura do carro acima de 20%.</span>}
        </section>
      </div>

      {sessions.length > 0 && (
        <section className={`${card} overflow-hidden`}>
          <h3 className="px-5 pt-4 pb-2 text-sm text-zinc-400 flex items-center gap-1.5"><Zap size={15} /> Carregamentos</h3>
          <ul className="divide-y divide-zinc-800">
            {sessions.slice(0, 30).map(s => {
              const minutes = s.end ? Math.round((s.end - s.start) / 60_000) : undefined;
              return (
                <li key={s.id} className="px-5 py-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-sm text-zinc-400 w-28 shrink-0 tabular-nums">{dayTime(s.start)}</span>
                  <span className="flex-1 min-w-[10rem] text-[15px] text-zinc-100 truncate">{s.site}</span>
                  <span className="text-sm text-zinc-300 tabular-nums">{kwh(s.kwh)}{minutes !== undefined ? ` · ${minutes} min` : ''}</span>
                  <span className="text-[15px] font-semibold text-zinc-50 tabular-nums w-32 text-right">
                    {eur(s.cost)}
                    {s.otherFees > 0 && <span className="block text-xs font-normal text-amber-300">inclui {eur(s.otherFees)} de taxas</span>}
                    {s.kwh > 0 && <span className="block text-xs font-normal text-zinc-500">{eur(s.cost / s.kwh, 3)}/kWh</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {car && car.months.length > 1 && (
        <section className={`${card} p-5`}>
          <h3 className="text-sm text-zinc-400 mb-2">Por mês (Superchargers)</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {car.months.slice(0, 12).map(m => (
              <li key={m.month} className="flex gap-3 tabular-nums">
                <span className="flex-1 min-w-0 truncate text-zinc-300">{monthName(m.month)}</span>
                <span className="w-8 text-right text-zinc-400">{m.sessions}×</span>
                <span className="hidden sm:inline w-20 text-right text-zinc-400">{kwh(m.kwh)}</span>
                <span className="w-20 text-right text-zinc-100 font-medium">{eur(m.cost)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
