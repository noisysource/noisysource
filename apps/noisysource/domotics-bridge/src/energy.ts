/**
 * Energy history for the app's Energia page: `domotics_energy/{yyyy-mm-dd}`,
 * one document per Lisbon day, one field per 15-minute slot (`q00`, `q01`, ...).
 *
 * Integrated from the inverter's power readings, which the bridge already takes
 * every poll (~30 s). Not from the inverter's own kWh registers: the candidates
 * (inverter.ts) are still unconfirmed, and a counter read wrong would be wrong
 * on every bill this feeds. Integration is honest about what it misses instead:
 * every slot carries how many seconds of it were covered by readings, and
 * nothing is integrated across a gap longer than MAX_GAP_MS (bridge restart,
 * inverter offline, Pi down), so the app can say "no data from 03:10 to 04:25"
 * rather than drawing a straight line through it.
 *
 * Pure, like automation.ts and incidents.ts: it is fed one reading per poll and
 * hands back the fields to write; index.ts does the writing. Writes stay low: a
 * slot is written once, when it ends, so ~96 writes a day, never one per poll.
 * Each write touches only its own slot fields (the REST update mask), so a lost
 * state file costs the open slot, never a slot already written.
 */

export const SLOT_MS = 15 * 60_000;
/**
 * Two readings further apart than this are not joined: the time between them is
 * a gap. The poll is ~30 s, and a slow Tuya round can stretch it to a minute or
 * so; three minutes is past anything a working bridge does.
 */
export const MAX_GAP_MS = 3 * 60_000;

/** One inverter reading, in the bridge's own signs. */
export interface PowerReading {
  t: number;
  pvW: number;
  /** + = exporting to the grid, − = importing. */
  gridW: number;
  /** + = charging, − = discharging. */
  batteryW: number;
  soc?: number;
}

/** Energy flows over one slot, in Wh. Every other flow is derived from these (see the app's energyBill). */
export interface Slot {
  /** PV produced (both strings, DC side). */
  pv: number;
  /** House consumption: pv − battery − grid, as the vendor app computes it. */
  load: number;
  /** Bought from the grid. */
  imp: number;
  /** Sent to the grid. */
  exp: number;
  /** Into the battery. */
  chg: number;
  /** Out of the battery. */
  dis: number;
  /** PV used by the house as it was produced. */
  pvLoad: number;
  /** Battery used by the house. */
  batLoad: number;
  /** Grid energy that went into the battery (charging from the grid, e.g. in vazio). */
  gridBat: number;
  /** Seconds of the slot covered by readings, 0–900. */
  sec: number;
  /** Battery % at the slot's last reading. */
  soc?: number;
}

const FLOWS = ['pv', 'load', 'imp', 'exp', 'chg', 'dis', 'pvLoad', 'batLoad', 'gridBat'] as const;
type Flow = (typeof FLOWS)[number];
type Flows = Record<Flow, number>;

// --- Lisbon calendar ----------------------------------------------------------
// Portugal (mainland) follows the EU rule: UTC+1 from 01:00 UTC on the last
// Sunday of March to 01:00 UTC on the last Sunday of October, UTC+0 otherwise.
// Done by hand rather than with Intl so it can't depend on the Pi's ICU data or
// system time zone; the tests check it against Intl on a machine that has both.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 01:00 UTC on the last Sunday of `month` (0-based). */
function lastSunday0100(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
}

/** Lisbon's offset from UTC at instant `t`, in ms. */
export function lisbonOffsetMs(t: number): number {
  const y = new Date(t).getUTCFullYear();
  return t >= lastSunday0100(y, 2) && t < lastSunday0100(y, 9) ? HOUR : 0;
}

/** The Lisbon calendar date at instant `t`, as 'YYYY-MM-DD'. */
export function lisbonDate(t: number): string {
  return new Date(t + lisbonOffsetMs(t)).toISOString().slice(0, 10);
}

/**
 * The instant Lisbon's day `date` begins. The clocks change at 01:00 UTC, never
 * near midnight, so the offset an hour before UTC midnight is the one in force.
 */
export function dayStart(date: string): number {
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  return midnightUtc - lisbonOffsetMs(midnightUtc - HOUR);
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}

/** Slots in a Lisbon day: 96, or 92 / 100 on the days the clocks change. */
export function slotsInDay(date: string): number {
  return Math.round((dayStart(nextDate(date)) - dayStart(date)) / SLOT_MS);
}

/** Field name of a slot: `q00` … `q99`. Fixed width so they sort. */
export const slotField = (i: number) => `q${String(i).padStart(2, '0')}`;

/** Which day and slot instant `t` falls in. Slots count real time from local midnight, so 25/10 has q00–q99. */
export function slotOf(t: number): { date: string; index: number; start: number } {
  const date = lisbonDate(t);
  const s = dayStart(date);
  const index = Math.floor((t - s) / SLOT_MS);
  return { date, index, start: s + index * SLOT_MS };
}

// --- Flows -------------------------------------------------------------------

/**
 * Instantaneous flows from one reading. Each kWh of consumption is assigned a
 * source in a fixed order — PV first, then battery, then grid — and each kWh
 * into the battery likewise (PV first, then grid). That is how a hybrid
 * inverter prioritises, and it is what lets the app split a saving into
 * "solar used directly" and "battery".
 */
export function flowsOf(r: PowerReading): Flows {
  const pv = Math.max(0, r.pvW);
  const chg = Math.max(0, r.batteryW);
  const dis = Math.max(0, -r.batteryW);
  const exp = Math.max(0, r.gridW);
  const imp = Math.max(0, -r.gridW);
  // Slightly negative on noise when nothing much is happening; never real.
  const load = Math.max(0, pv - r.batteryW - r.gridW);
  const pvLoad = Math.min(pv, load);
  const batLoad = Math.min(dis, load - pvLoad);
  const pvBat = Math.min(pv - pvLoad, chg);
  const gridBat = Math.max(0, Math.min(chg - pvBat, imp));
  return { pv, load, imp, exp, chg, dis, pvLoad, batLoad, gridBat };
}

export const emptySlot = (): Slot => ({
  pv: 0, load: 0, imp: 0, exp: 0, chg: 0, dis: 0, pvLoad: 0, batLoad: 0, gridBat: 0, sec: 0,
});

/** Whole Wh and seconds for storage: a slot is ~10 numbers, and decimals would only add noise. */
export function roundSlot(s: Slot): Slot {
  const out = emptySlot();
  for (const f of FLOWS) out[f] = Math.round(s[f]);
  out.sec = Math.min(SLOT_MS / 1000, Math.round(s.sec));
  if (s.soc !== undefined) out.soc = Math.round(s.soc);
  return out;
}

// --- Aggregator ----------------------------------------------------------------

/** Day metadata written with every slot, so a document is readable on its own. */
export interface DayMeta {
  date: string;
  /** When the Lisbon day began. */
  start: Date;
  /** How many slots it has (92 / 96 / 100). */
  slots: number;
  /** What the figures come from. */
  source: 'integrated';
  v: 1;
}

/** What survives a restart. Small: the open slot, the last reading, and writes not yet confirmed. */
export interface EnergySnapshot {
  open: { date: string; index: number; slot: Slot } | null;
  last: PowerReading | null;
  /**
   * End of the last slot closed. Nothing is ever added before it: a closed slot
   * may already be written, and reopening it would overwrite the whole slot with
   * a sliver of it. (A reading taken at 10:14:59.999 and processed at 10:15:00
   * closes q40; the stretch from it to the next reading must start at 10:15.)
   */
  closedUntil: number;
  /** By document id, then field. */
  pending: Record<string, Record<string, Slot>>;
}

export const INITIAL_ENERGY: EnergySnapshot = { open: null, last: null, closedUntil: 0, pending: {} };

/** Writes not yet confirmed are kept this long, then dropped (two weeks of a dead network). */
const PENDING_DAYS = 14;

export function createEnergyRecorder(initial?: EnergySnapshot) {
  const s: EnergySnapshot = structuredClone(initial ?? INITIAL_ENERGY);

  function closeOpen() {
    const o = s.open;
    if (!o) return;
    if (o.slot.sec > 0) (s.pending[o.date] ??= {})[slotField(o.index)] = roundSlot(o.slot);
    s.closedUntil = Math.max(s.closedUntil, dayStart(o.date) + (o.index + 1) * SLOT_MS);
    s.open = null;
    const days = Object.keys(s.pending).sort();
    while (days.length > PENDING_DAYS) delete s.pending[days.shift()!];
  }

  /** The open slot for instant `t`, closing the previous one if `t` is past it. */
  function slotAt(t: number): Slot {
    const { date, index } = slotOf(t);
    if (s.open && (s.open.date !== date || s.open.index !== index)) closeOpen();
    s.open ??= { date, index, slot: emptySlot() };
    return s.open.slot;
  }

  /** Add the energy between two readings, split across the slots it spans. */
  function integrate(a: PowerReading, b: PowerReading) {
    const fa = flowsOf(a);
    const fb = flowsOf(b);
    let t = Math.max(a.t, s.closedUntil);
    while (t < b.t) {
      const { start } = slotOf(t);
      const end = Math.min(b.t, start + SLOT_MS);
      const slot = slotAt(t);
      const hours = (end - t) / HOUR;
      // Trapezoid: the mean of the two readings over the stretch. Linear in the
      // readings, so the balance pv + dis + imp = load + chg + exp still holds.
      for (const f of FLOWS) slot[f] += ((fa[f] + fb[f]) / 2) * hours;
      slot.sec += (end - t) / 1000;
      t = end;
    }
  }

  return {
    /**
     * One poll. `reading` is undefined when the inverter didn't answer; `now`
     * still closes a slot that has ended, so a dead inverter doesn't hold the
     * last good slot back forever.
     */
    observe(reading: PowerReading | undefined, now: number) {
      // The Pi has no clock battery: its time can be corrected after boot. A
      // small step back is ignored until real time passes it again, so a slot
      // already written is never reopened; a big one means the clock had been
      // wrong (days ahead), and waiting for it would mean recording nothing, so
      // that starts afresh.
      if (reading && s.closedUntil - reading.t > DAY) {
        console.warn(`[energy] clock went back ${Math.round((s.closedUntil - reading.t) / HOUR)} h, starting afresh`);
        s.open = null;
        s.last = null;
        s.closedUntil = 0;
      }
      const last = s.last;
      const stepBack = !!reading && !!last && reading.t <= last.t;
      if (reading && !stepBack) {
        if (last && reading.t > last.t && reading.t - last.t <= MAX_GAP_MS) integrate(last, reading);
        // The reading's own slot is opened even after a gap, so its SoC lands.
        if (reading.t >= s.closedUntil) {
          const slot = slotAt(reading.t);
          if (reading.soc !== undefined) slot.soc = reading.soc;
        }
        s.last = reading;
      }
      if (s.open) {
        const end = dayStart(s.open.date) + (s.open.index + 1) * SLOT_MS;
        if (now >= end) closeOpen();
      }
    },
    /** Slots closed and not yet confirmed written — for the store, to save its state when one closes. */
    pendingCount: () => Object.values(s.pending).reduce((n, p) => n + Object.keys(p).length, 0),
    /** Documents to write: id → fields (slots plus the day's metadata). Doesn't clear anything. */
    pendingWrites(): Array<{ id: string; fields: Record<string, unknown> }> {
      return Object.entries(s.pending).map(([date, slots]) => ({
        id: date,
        fields: { ...slots, ...dayMeta(date) },
      }));
    },
    /** A write landed. Only the slots it carried are dropped: one closed meanwhile stays queued. */
    written(id: string, fields: Record<string, unknown>) {
      const p = s.pending[id];
      if (!p) return;
      for (const k of Object.keys(fields)) if (p[k] === fields[k]) delete p[k];
      if (Object.keys(p).length === 0) delete s.pending[id];
    },
    snapshot: (): EnergySnapshot => s,
  };
}

export function dayMeta(date: string): DayMeta {
  return { date, start: new Date(dayStart(date)), slots: slotsInDay(date), source: 'integrated', v: 1 };
}
