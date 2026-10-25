import { createConnection } from 'node:net';

/**
 * RENAC N1HL (ESC50000-DS) over Modbus TCP.
 *
 * Raw sockets rather than a Modbus library: this reads one block of input
 * registers and nothing else, and the framing is a dozen lines. A dependency
 * would be more code to audit than the protocol it wraps.
 *
 * READ-ONLY BY DESIGN. Function 0x04 reads input registers; nothing here can
 * write. Inverter holding registers include grid-export limits and battery
 * charge settings, and a stray write there has consequences a thermostat does
 * not.
 */

const HOST = process.env.INVERTER_HOST ?? '192.168.1.117';
const PORT = Number(process.env.INVERTER_PORT ?? 502);
const UNIT = Number(process.env.INVERTER_UNIT_ID ?? 1);
const TIMEOUT_MS = 5000;

/**
 * Registers confirmed on this unit by watching which values actually move.
 *
 * A previous mapping listed 88 as "PV total W" and 82 as inverter power, but
 * both sat perfectly still for 25 seconds while the battery discharged —
 * instantaneous power cannot do that. They are almost certainly cumulative
 * energy counters, so they are deliberately absent here rather than reported
 * as watts.
 *
 * The PV registers were found by diffing a midnight dump against a morning one:
 * 5, 6, 7, 8, 11 and 12 were all zero in the dark and alive at sunrise. The
 * mapping then verified itself arithmetically — string voltage times current
 * matches the string power register on both strings, across samples taken
 * twenty seconds apart, with the values drifting together as the sun rose.
 *
 * There is no single "PV total" register on this model; the total is the sum of
 * the two strings.
 */
const REG = {
  acVoltage: 1,     // ×0.1 V — moves with the mains, unlike reg 42
  subLoad: 3,       // W — a subset of house load, ~25% low. NOT the total.
  pv1Voltage: 5,    // ×0.1 V
  pv2Voltage: 6,    // ×0.1 V
  pv1Current: 7,    // ×0.1 A — 0.1 A resolution, so V×I lands a few % low
  pv2Current: 8,    // ×0.1 A
  pv1Power: 11,     // W
  pv2Power: 12,     // W
  gridPower: 22,    // signed W — near zero off-grid
  subLoadVa: 50,    // VA — tracks reg 3 closely; same subset, different unit
  batteryPower: 72, // signed W, negative = discharging
  soc: 80,          // %
} as const;

export interface InverterReading {
  online: boolean;
  acVoltageV?: number;
  /**
   * Whole-house consumption. Derived, not measured — see readInverter().
   */
  consumptionW?: number;
  /**
   * A real load measurement, but only part of the house — consistently ~25%
   * below the true total (1090 W against 1450 W when checked against the
   * vendor app). It tracks load faithfully, so it measures *something* real;
   * exactly which circuits is unconfirmed. Never present this as consumption.
   */
  subLoadW?: number;
  gridPowerW?: number;
  subLoadVA?: number;
  batteryPowerW?: number;
  soc?: number;
  /** Sum of both strings — this model has no combined register. */
  pvPowerW?: number;
  pvStrings?: Array<{ voltageV: number; currentA: number; powerW: number }>;
  readAt: number;
}

function signed16(v: number) {
  return v > 32767 ? v - 65536 : v;
}

function readInputRegisters(start: number, count: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: HOST, port: PORT });
    let settled = false;
    const done = (err: Error | null, value?: number[]) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve(value!);
    };

    socket.setTimeout(TIMEOUT_MS);
    socket.on('timeout', () => done(new Error('inverter timeout')));
    socket.on('error', err => done(err));

    socket.on('connect', () => {
      const frame = Buffer.alloc(12);
      frame.writeUInt16BE(1, 0);      // transaction id
      frame.writeUInt16BE(0, 2);      // protocol id
      frame.writeUInt16BE(6, 4);      // length of what follows
      frame.writeUInt8(UNIT, 6);
      frame.writeUInt8(0x04, 7);      // read input registers
      frame.writeUInt16BE(start, 8);
      frame.writeUInt16BE(count, 10);
      socket.write(frame);
    });

    const chunks: Buffer[] = [];
    socket.on('data', chunk => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 9) return;
      if (buf[7] & 0x80) return done(new Error(`modbus exception ${buf[8]}`));
      const byteCount = buf[8];
      if (buf.length < 9 + byteCount) return;
      const out: number[] = [];
      for (let i = 0; i < byteCount; i += 2) out.push(buf.readUInt16BE(9 + i));
      done(null, out);
    });
  });
}

/**
 * Registers that count up in 0.1 kWh steps — probably the inverter's own
 * energy counters (today's and lifetime), but which flow each one is has not
 * been confirmed. Watched on 25/10 17:45–19:00 (dark: the house on the battery,
 * nothing from or to the grid): 28, 51, 90 rose together by 0.1 kWh per
 * ~100 Wh, and so did 30, 52, 82; 29, 54, 59, 91 (today?) and 56, 88, 111, 113
 * (lifetime?) stood still. Telling them apart needs a day with sun, export and
 * charging, so the energy recorder logs them on the Pi next to its own
 * integrated slots (energy-store.ts) until someone compares the two. Not
 * reported anywhere until then.
 */
export const COUNTER_CANDIDATES = [28, 29, 30, 51, 52, 54, 56, 59, 82, 88, 90, 91, 111, 113] as const;
let lastCounters: { t: number; values: Record<number, number> } | undefined;
/** The candidate counters as of the last successful read (see above). */
export const lastCounterCandidates = () => lastCounters;

export async function readInverter(): Promise<InverterReading> {
  try {
    // One block covering every register of interest — a single round trip is
    // both faster and kinder to the datalogger than six. To 119 for the
    // counter candidates above; still one request (the limit is 125).
    const regs = await readInputRegisters(0, 120);
    const at = (i: number) => regs[i];
    lastCounters = {
      t: Date.now(),
      values: Object.fromEntries(COUNTER_CANDIDATES.map(r => [r, regs[r]])),
    };

    const gridPowerW = signed16(at(REG.gridPower));
    const batteryPowerW = signed16(at(REG.batteryPower));

    const pvStrings = [
      {
        voltageV: at(REG.pv1Voltage) / 10,
        currentA: at(REG.pv1Current) / 10,
        powerW: at(REG.pv1Power),
      },
      {
        voltageV: at(REG.pv2Voltage) / 10,
        currentA: at(REG.pv2Current) / 10,
        powerW: at(REG.pv2Power),
      },
    ];

    const pvPowerW = pvStrings.reduce((sum, str) => sum + str.powerW, 0);

    return {
      online: true,
      acVoltageV: at(REG.acVoltage) / 10,
      pvPowerW,
      pvStrings,
      gridPowerW,
      batteryPowerW,
      subLoadW: at(REG.subLoad),
      subLoadVA: at(REG.subLoadVa),
      // House consumption has no register on this model — the vendor app
      // derives it, and its own displayed figures balance to the watt:
      // PV 570 + battery 880 - export 50 = 1400, exactly what it showed.
      //
      // Registers 3 and 50 look like consumption and are not. Checked against
      // the vendor app at the same moment: app 1450 W, derived 1406 W (3% off,
      // explained by the app lagging), reg 3 just 1090 W — 25% low. A scan of
      // all 400 input registers, 16- and 32-bit, found no register matching the
      // derived figure, so no whole-house total is exposed at all. Reporting
      // reg 3 as consumption would understate every bill this eventually feeds.
      //
      // Signs: battery is negative while discharging, grid positive while
      // exporting, so both are subtracted.
      consumptionW: pvPowerW - batteryPowerW - gridPowerW,
      soc: at(REG.soc),
      readAt: Date.now(),
    };
  } catch (err) {
    console.warn('[inverter] read failed:', (err as Error).message);
    return { online: false, readAt: Date.now() };
  }
}
