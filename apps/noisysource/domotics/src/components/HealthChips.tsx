import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Device, HeatPumpDevice } from '@shared/models/Device';
import type { DeviceStatus } from '../App';
import { faultMeaning } from '../data/heatpumpFaults';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

const TONE: Record<Tone, { chip: string; dot: string }> = {
  ok: { chip: 'bg-emerald-950/70 text-emerald-300', dot: 'bg-emerald-400' },
  warn: { chip: 'bg-amber-950/70 text-amber-300', dot: 'bg-amber-400' },
  bad: { chip: 'bg-red-950 text-red-300', dot: 'bg-red-400' },
  idle: { chip: 'bg-zinc-800 text-zinc-400', dot: 'bg-zinc-500' },
};

/**
 * A health indicator that is always there, green included. The old header
 * only ever showed bad news, so a working house looked identical to a page
 * that hadn't loaded anything yet.
 */
function StatusChip({ tone, title, onClick, children }: {
  tone: Tone; title?: string; onClick?: () => void; children: ReactNode;
}) {
  const cls = `flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg whitespace-nowrap ${TONE[tone].chip}`;
  const dot = <span className={`w-1.5 h-1.5 rounded-full ${TONE[tone].dot}`} />;
  return onClick ? (
    <button className={`${cls} hover:brightness-125 transition`} title={title} onClick={onClick}>
      {dot}{children}
    </button>
  ) : (
    <span className={cls} title={title}>{dot}{children}</span>
  );
}

export function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/**
 * Past this, the reading is older than the bridge would ever leave it. Away
 * from home nothing tells the bridge it's being watched (only LAN requests
 * do), so it publishes to the relay at its idle rate — every 5 min — and a
 * 3-minute-old reading is normal, not a warning. The relay itself gives up at
 * 15 min (bridge.ts), where the chip turns red instead.
 */
const STALE_AFTER_MS = 7 * 60_000;

interface Props {
  devices: Device[];
  deviceStatus: DeviceStatus;
  /** Local LAN bridge serving the Tuya climate devices. */
  bridgeStatus: DeviceStatus;
  /** When the bridge's state was read from the devices (ms epoch). */
  bridgeUpdatedAt?: number;
  onSignIn: () => Promise<void>;
}

/** "Clima · 7/7" and "Luzes e estores" — whether each half of the house is answering. */
export default function HealthChips({
  devices, deviceStatus, bridgeStatus, bridgeUpdatedAt, onSignIn,
}: Props) {
  /** Ticks so "updated N s ago" stays honest between polls. */
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const climate = devices.filter(d => d.vendor === 'tuya');
  const climateOnline = climate.filter(d => d.online !== false).length;
  const bridgeAge = bridgeUpdatedAt ? now - bridgeUpdatedAt : undefined;

  const climateChip: { tone: Tone; text: string } =
    bridgeStatus === 'loading' ? { tone: 'idle', text: 'Clima…' }
    : bridgeStatus !== 'ok' ? { tone: 'bad', text: 'Clima offline' }
    : {
        tone: climateOnline < climate.length || (bridgeAge ?? 0) > STALE_AFTER_MS ? 'warn' : 'ok',
        text: `Clima · ${climateOnline}/${climate.length}${
          bridgeAge !== undefined && bridgeAge > STALE_AFTER_MS ? ` · há ${ago(bridgeAge)}` : ''
        }`,
      };

  const lightsChip: { tone: Tone; text: string } =
    deviceStatus === 'ok' ? { tone: 'ok', text: 'Luzes e estores' }
    : deviceStatus === 'signin' ? { tone: 'warn', text: 'Luzes: entrar' }
    : deviceStatus === 'loading' ? { tone: 'idle', text: 'Luzes…' }
    : { tone: 'bad', text: 'Luzes offline' };

  return (
    <>
      <StatusChip
        tone={climateChip.tone}
        title={bridgeAge !== undefined
          ? `Termóstatos e bomba de calor, via ponte (Raspberry Pi) — lido há ${ago(bridgeAge)}`
          : 'Termóstatos e bomba de calor, via ponte (Raspberry Pi)'}
      >
        {climateChip.text}
      </StatusChip>
      <StatusChip
        tone={lightsChip.tone}
        title={deviceStatus === 'signin'
          ? 'As luzes e estores (Legrand) precisam de sessão iniciada — toque para entrar'
          : 'Luzes e estores (Legrand / Netatmo)'}
        onClick={deviceStatus === 'signin' ? () => void onSignIn() : undefined}
      >
        {lightsChip.text}
      </StatusChip>
    </>
  );
}

/**
 * A fault is the one thing that must not depend on opening the right
 * popover — it goes across the top, whatever else is on screen.
 */
export function FaultBanner({ devices }: { devices: Device[] }) {
  const faulty = devices.filter(
    (d): d is HeatPumpDevice => d.type === 'heatpump' && d.state.faults.length > 0,
  );
  if (faulty.length === 0) return null;
  return (
    <div className="flex items-start gap-3 px-4 sm:px-6 py-2.5 bg-red-950 border-b border-red-800 text-sm text-red-100 shrink-0">
      <AlertTriangle size={18} className="text-red-400 shrink-0 mt-px" />
      <div className="flex-1 min-w-0">
        {faulty.map(d => (
          <p key={d.id}>
            <b>Avaria — {d.name}:</b>{' '}
            {d.state.faults.map(code => `${code} ${faultMeaning(code)}`).join(' · ')}
          </p>
        ))}
      </div>
    </div>
  );
}
