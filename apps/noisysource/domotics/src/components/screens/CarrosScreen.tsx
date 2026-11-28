import { useCallback, useEffect, useRef, useState } from 'react';
import { BatteryCharging, Car, Lock, LockOpen, MapPin, Moon, RefreshCw, Thermometer } from 'lucide-react';
import {
  teslaAuthStartFn, teslaChargingFn, teslaRegisterPartnerFn, teslaVehiclesFn, type TeslaCar, type TeslaChargingResult,
} from '../../lib/firebase';
import ChargingSection from '../cars/ChargingSection';
import CarControls from '../cars/CarControls';
import { DEMO } from '../../data/demoData';

interface Props {
  /** Signed in, off the LAN: the callables are the owner's alone. */
  canUse: boolean;
  notify: (text: string) => void;
}

/** Where Tesla sends the browser back after login; must be one of REDIRECT_URIS in the function. */
function redirectUri() {
  return `${window.location.origin}/tesla/callback`;
}

const card = 'rounded-2xl bg-zinc-900 border border-zinc-800';

const CHARGING: Record<string, string> = {
  Charging: 'A carregar', Complete: 'Carga completa', Stopped: 'Parado', Disconnected: 'Desligado do carregador',
  NoPower: 'Sem corrente na tomada', Starting: 'A começar',
};

function ago(ms?: number) {
  if (!ms) return 'nunca lido';
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return 'agora mesmo';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
}

const DEMO_CARS: TeslaCar[] = [
  { vin: 'DEMO1', id: '1', name: 'Model X', model: 'Model X', state: 'online', soc: 68, rangeKm: 310, chargeLimit: 80, chargingState: 'Charging', chargeAmps: 9, chargeAmpsMax: 13, chargerPowerKw: 2.1, energyAddedKwh: 6.8, minutesToFull: 140, locked: true, insideC: 17, outsideC: 13, odometerKm: 48210, lat: 40.235, lon: -8.43, software: '2026.44.1', readAt: Date.now() - 120_000 },
  { vin: 'DEMO2', id: '2', name: 'Model 3', model: 'Model 3', state: 'asleep', soc: 41, rangeKm: 190, chargeLimit: 90, chargingState: 'Disconnected', locked: true, insideC: 15, odometerKm: 31800, lat: 40.21, lon: -8.43, readAt: Date.now() - 40 * 60_000 },
];

const DAY = 24 * 3600_000;
const DEMO_CHARGING: TeslaChargingResult = {
  connected: true,
  fetchedAt: Date.now(),
  error: null,
  sessions: [
    { id: 's1', vin: 'DEMO1', site: 'Coimbra, Portugal', start: Date.now() - 2 * 3600_000, end: Date.now() - 3600_000 * 1.2, kwh: 75.9, cost: 31.86, energyCost: 30.36, otherFees: 1.5, currency: 'EUR', invoiceIds: [] },
    { id: 's2', vin: 'DEMO1', site: 'Pombal, Portugal', start: Date.now() - 9 * DAY, end: Date.now() - 9 * DAY + 35 * 60_000, kwh: 52.3, cost: 20.4, energyCost: 20.4, otherFees: 0, currency: 'EUR', invoiceIds: [] },
    { id: 's3', vin: 'DEMO1', site: 'Mealhada, Portugal', start: Date.now() - 40 * DAY, end: Date.now() - 40 * DAY + 28 * 60_000, kwh: 44.1, cost: 18.08, energyCost: 18.08, otherFees: 0, currency: 'EUR', invoiceIds: [] },
  ],
  cars: [{
    vin: 'DEMO1',
    months: [{ month: '2026-11', sessions: 2, kwh: 128.2, cost: 52.26, perKwh: 0.408 }, { month: '2026-10', sessions: 1, kwh: 44.1, cost: 18.08, perKwh: 0.41 }],
    consumption: { from: Date.now() - 9 * DAY, to: Date.now() - 2 * 3600_000, km: 342, kwh: 75.9, whPerKm: 222, cost: 31.86, per100Km: 9.32 },
    fullRangeKm: 527,
    fullRangeByMonth: [{ month: '2026-10', km: 531 }, { month: '2026-11', km: 527 }],
    capacityKwh: null,
    readings: 14,
  }],
};

/**
 * The cars: battery, range, charging, lock, cabin, position. Read through the
 * Tesla callables, which cap the calls per day and never wake a sleeping car,
 * so an asleep car shows its last reading with when it was taken.
 * Commands (lock, climate, charging current) come in a later step.
 */
export default function CarrosScreen({ canUse, notify }: Props) {
  const [cars, setCars] = useState<TeslaCar[]>(DEMO ? DEMO_CARS : []);
  const [connected, setConnected] = useState<boolean | null>(DEMO ? true : null);
  const [usage, setUsage] = useState<{ calls: number; cap: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const [charging, setCharging] = useState<TeslaChargingResult | null>(DEMO ? DEMO_CHARGING : null);
  const [chargingBusy, setChargingBusy] = useState(false);

  // notify in a ref: load must not change identity when the parent re-renders,
  // or the effect below runs again, calls again, notifies again… (26/11: a
  // loop that used the whole day's Tesla budget in seconds).
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const inFlight = useRef(false);

  const load = useCallback(async (manual = false) => {
    if (DEMO || !canUse || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setChargingBusy(true);
    try {
      const r = (await teslaVehiclesFn({})).data;
      setConnected(r.connected);
      setCars(r.cars);
      if (r.callCap) setUsage({ calls: r.callsToday ?? 0, cap: r.callCap });
      // After the cars, so a reading taken just now counts. The function fetches
      // Tesla's history at most every 6 h (15 min on "Atualizar"); the rest is Firestore.
      if (r.connected) setCharging((await teslaChargingFn({ refresh: manual })).data);
    } catch (err) {
      notifyRef.current(`Tesla: ${(err as Error).message}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
      setChargingBusy(false);
    }
  }, [canUse]);

  // Once when the page opens (and when sign-in changes); never again on its
  // own, failed or not. "Atualizar" is the only other way to call.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!canUse || autoLoaded.current) return;
    autoLoaded.current = true;
    void load();
  }, [canUse, load]);

  async function connect() {
    try {
      const { url } = (await teslaAuthStartFn({ redirectUri: redirectUri() })).data;
      window.location.assign(url);
    } catch (err) {
      notify(`Tesla: ${(err as Error).message}`);
    }
  }

  async function register() {
    try {
      await teslaRegisterPartnerFn();
      notify('App registada na Tesla.');
    } catch (err) {
      notify(`Tesla: ${(err as Error).message}`);
    }
  }

  const car = cars[Math.min(sel, cars.length - 1)];

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 pt-4 pb-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <h1 className="text-2xl font-bold text-zinc-50 mr-3">Carros</h1>
        {cars.length > 1 && (
          <div role="tablist" aria-label="Carro" className="flex gap-1.5">
            {cars.map((c, i) => (
              <button
                key={c.vin}
                role="tab"
                aria-selected={i === sel}
                onClick={() => setSel(i)}
                className={`min-h-[40px] px-4 rounded-full text-sm border ${i === sel ? 'bg-amber-400/10 border-amber-500/60 text-zinc-50' : 'bg-zinc-900 border-zinc-800 text-zinc-300'}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
        {connected && (
          <button onClick={() => void load(true)} disabled={busy} className="ml-auto flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg bg-zinc-800 text-sm text-zinc-200 disabled:opacity-50">
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Atualizar
          </button>
        )}
      </div>

      {!canUse && !DEMO && (
        <p className={`${card} p-5 text-sm text-zinc-300`}>Os carros só aparecem com sessão iniciada, fora da rede de casa (a app alojada).</p>
      )}

      {canUse && connected === false && (
        <section className={`${card} p-5 flex flex-col gap-3 items-start`}>
          <Car size={26} className="text-sky-300" />
          <p className="text-[15px] text-zinc-200">Ligue a conta Tesla para ver os carros. Entra no site da Tesla, aceita o acesso e volta aqui.</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void connect()} className="min-h-[44px] px-4 rounded-xl bg-amber-400 hover:bg-amber-300 text-amber-950 font-semibold">Ligar à Tesla</button>
            <button onClick={() => void register()} className="min-h-[44px] px-4 rounded-xl bg-zinc-800 text-zinc-200 border border-zinc-700">Registar a app na Tesla (uma vez)</button>
          </div>
        </section>
      )}

      {car && (
        <div className="grid gap-4 lg:grid-cols-12">
          <section className={`${card} p-5 flex flex-col gap-3 lg:col-span-5`}>
            <div className="flex justify-between items-baseline text-sm">
              <span className="font-semibold text-zinc-100">{car.name}{car.model && car.model !== car.name && <span className="font-normal text-zinc-400"> · {car.model}</span>}</span>
              <span className="text-zinc-400 flex items-center gap-1">
                {car.state === 'online' ? 'Acordado' : car.state === 'asleep' ? <><Moon size={13} /> A dormir</> : 'Sem ligação'} · {ago(car.readAt)}
              </span>
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-5xl font-semibold text-zinc-50 tabular-nums leading-none">{car.soc ?? '—'}%</span>
              <span className="text-zinc-400">{car.rangeKm !== undefined ? `${car.rangeKm} km` : ''}</span>
            </div>
            <div className="h-3 rounded-full bg-zinc-800 overflow-hidden relative">
              <div className="h-full bg-sky-400" style={{ width: `${car.soc ?? 0}%` }} />
              {car.chargeLimit !== undefined && <div className="absolute top-0 bottom-0 w-0.5 bg-zinc-200/70" style={{ left: `${car.chargeLimit}%` }} title={`Limite ${car.chargeLimit}%`} />}
            </div>
            <div className="flex justify-between text-sm text-zinc-400">
              <span className="flex items-center gap-1.5">
                <BatteryCharging size={15} />
                {CHARGING[car.chargingState ?? ''] ?? car.chargingState ?? '—'}
                {car.chargingState === 'Charging' && car.chargeAmps !== undefined && ` · ${car.chargeAmps} A`}
                {car.chargingState === 'Charging' && car.chargerPowerKw !== undefined && ` · ${car.chargerPowerKw} kW`}
              </span>
              {car.chargeLimit !== undefined && <span>limite {car.chargeLimit}%</span>}
            </div>
            {car.chargingState === 'Charging' && car.minutesToFull !== undefined && (
              <span className="text-sm text-zinc-400">Faltam ~{Math.floor(car.minutesToFull / 60)} h {car.minutesToFull % 60} min · +{car.energyAddedKwh ?? 0} kWh nesta carga</span>
            )}
          </section>

          <section className={`${card} p-5 lg:col-span-7 grid grid-cols-2 sm:grid-cols-3 gap-4 content-start`}>
            <Stat label="Trancado" value={car.locked === undefined ? '—' : car.locked ? 'Sim' : 'Não'} icon={car.locked ? <Lock size={14} /> : <LockOpen size={14} className="text-amber-300" />} />
            <Stat label="Interior" value={car.insideC !== undefined ? `${car.insideC.toFixed(1)}°` : '—'} icon={<Thermometer size={14} />} />
            <Stat label="Exterior" value={car.outsideC !== undefined ? `${car.outsideC.toFixed(1)}°` : '—'} icon={<Thermometer size={14} />} />
            <Stat label="Quilómetros" value={car.odometerKm !== undefined ? car.odometerKm.toLocaleString('pt-PT') : '—'} />
            <Stat label="Software" value={car.software ?? '—'} />
            <Stat label="Sentinela" value={car.sentry === undefined ? '—' : car.sentry ? 'Ligada' : 'Desligada'} />
            <div className="col-span-2 sm:col-span-3 flex items-center gap-2 text-sm">
              <MapPin size={15} className="text-amber-300" />
              {car.lat !== undefined && car.lon !== undefined ? (
                <a
                  href={`https://www.openstreetmap.org/?mlat=${car.lat}&mlon=${car.lon}#map=16/${car.lat}/${car.lon}`}
                  target="_blank" rel="noreferrer"
                  className="text-amber-400 underline-offset-2 hover:underline"
                >
                  Ver no mapa ({car.lat.toFixed(4)}, {car.lon.toFixed(4)})
                </a>
              ) : <span className="text-zinc-400">Posição desconhecida</span>}
            </div>
          </section>
        </div>
      )}

      {car && (
        <CarControls
          key={car.vin}
          car={car}
          notify={notify}
          onPatch={patch => setCars(cs => cs.map(c => (c.vin === car.vin ? { ...c, ...patch } : c)))}
        />
      )}

      {car && <ChargingSection vin={car.vin} data={charging} loading={chargingBusy} />}

      {usage && (
        <p className="text-xs text-zinc-500">Chamadas à Tesla hoje: {usage.calls} de {usage.cap}. Um carro a dormir não é acordado: mostra a última leitura.</p>
      )}
      {canUse && connected && (
        // A new login, for a permission (scope) the current one lacks: Tesla says so as
        // "missing scopes …" in the error, and a token keeps the scopes it was given.
        <button onClick={() => void connect()} className="self-start text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
          Ligar de novo à Tesla (para dar permissões em falta)
        </button>
      )}
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-zinc-400 flex items-center gap-1">{icon}{label}</span>
      <span className="text-lg font-semibold text-zinc-50 tabular-nums">{value}</span>
    </div>
  );
}
