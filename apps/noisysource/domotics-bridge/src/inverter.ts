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
  load: 3,          // W — tracks the house
  pv1Voltage: 5,    // ×0.1 V
  pv2Voltage: 6,    // ×0.1 V
  pv1Current: 7,    // ×0.1 A — 0.1 A resolution, so V×I lands a few % low
  pv2Current: 8,    // ×0.1 A
  pv1Power: 11,     // W
  pv2Power: 12,     // W
  gridPower: 22,    // signed W — near zero off-grid
  epsLoad: 50,      // VA — matches the documented map
  batteryPower: 72, // signed W, negative = discharging
  soc: 80,          // %
} as const;

export interface InverterReading {
  online: boolean;
  acVoltageV?: number;
  loadW?: number;
  gridPowerW?: number;
  epsLoadVA?: number;
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

export async function readInverter(): Promise<InverterReading> {
  try {
    // One block covering every register of interest — a single round trip is
    // both faster and kinder to the datalogger than six.
    const regs = await readInputRegisters(0, 90);
    const at = (i: number) => regs[i];

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

    return {
      online: true,
      acVoltageV: at(REG.acVoltage) / 10,
      loadW: at(REG.load),
      pvPowerW: pvStrings.reduce((sum, s) => sum + s.powerW, 0),
      pvStrings,
      gridPowerW: signed16(at(REG.gridPower)),
      epsLoadVA: at(REG.epsLoad),
      batteryPowerW: signed16(at(REG.batteryPower)),
      soc: at(REG.soc),
      readAt: Date.now(),
    };
  } catch (err) {
    console.warn('[inverter] read failed:', (err as Error).message);
    return { online: false, readAt: Date.now() };
  }
}
