import { useEffect, useMemo, useRef } from 'react';
import RunCard from './RunCard';
import {
  DAYS, STEP, VEHICLES, buildGrid, cellKey, dropOf, isNewRun, laneKey, peakAfterPickups, seatsDuring, slotOf, toMin, toTime,
  type Part, type TransportRun, type VehicleId,
} from './logic';

interface Props {
  runs: TransportRun[];
  days: number[];
  lanes: VehicleId[];
  today: number;
  /** Phone-sized: taller rows for fingers. */
  narrow: boolean;
  /** The table fits its container, so the header can stick to the top while scrolling. */
  fits: boolean;
  minWidth: number;
  onlyNew: boolean;
  readOnly: boolean;
  onMove: (id: string, part: Part, day: number, vehicle: VehicleId, slot: string) => void;
  onEdit: (id: string) => void;
  /** Called when a drag starts and ends, so the page can hold back live updates meanwhile. */
  onDragState: (dragging: boolean) => void;
}

const LANE_BG: Record<VehicleId, string> = { van: 'bg-blue-50', car: 'bg-orange-50' };
const STRIP: Record<VehicleId, string> = { van: '#3b82f6', car: '#f97316' };
const DANGER = '#dc2626';
const ACCENT = '#6366f1';
const LANE_HEAD: Record<VehicleId, string> = { van: 'bg-blue-100 text-blue-900', car: 'bg-orange-100 text-orange-900' };

interface Press { id: string; part: Part; card: HTMLElement; x: number; y: number; touch: boolean; timer: number }
interface Drag { id: string; part: Part; card: HTMLElement; ghost: HTMLElement; zone: HTMLElement | null; x: number; y: number; offX: number; offY: number }

/**
 * The weekly board: hours down the side in 5-minute rows, each day split into one lane per vehicle.
 * Drag and drop uses pointer events so it works with a mouse and on touch (press and hold, so a swipe
 * still scrolls). Highlights during a drag are set straight on the DOM: re-rendering ~1,000 cells on
 * every pointer move would be too slow.
 */
export default function TransportBoard(props: Props) {
  const { runs, days, lanes, today, narrow, fits, minWidth, onlyNew, readOnly } = props;
  const grid = useMemo(() => buildGrid(runs), [runs]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const press = useRef<Press | null>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const scroller = () => (scrollRef.current?.closest('main') as HTMLElement | null) ?? (document.scrollingElement as HTMLElement);
    const setTarget = (zone: HTMLElement | null, on: boolean) => {
      if (!zone) return;
      zone.style.boxShadow = on ? `inset 0 0 0 2px ${ACCENT}` : '';
      zone.style.backgroundColor = on ? '#e0e7ff' : '';
    };
    // The ghost shows the time it would land on and, for a drop-off, the new drive time.
    const preview = (d: Drag) => {
      const r = live.current.runs.find(x => x.id === d.id);
      const slot = d.zone?.dataset.slot;
      if (!r || !slot) return;
      const current = d.part === 'pick' ? r.time : dropOf(r).time;
      const time = slotOf(current) === slot ? current : slot;
      const t = d.ghost.querySelector('[data-role="time"]');
      if (t) t.textContent = time;
      const drive = d.ghost.querySelector('[data-role="drive"]');
      if (drive) {
        const mins = toMin(time) - toMin(r.time);
        drive.textContent = mins > 0 ? `${mins} min` : 'Antes da recolha';
      }
    };
    const place = () => {
      const d = drag.current;
      if (!d) return;
      d.ghost.style.transform = `translate(${d.x - d.offX}px, ${d.y - d.offY}px)`;
      const under = document.elementFromPoint(d.x, d.y);
      const zone = (under?.closest('td[data-zone]') as HTMLElement | null) ?? null;
      if (zone !== d.zone) {
        setTarget(d.zone, false);
        setTarget(zone, true);
        d.zone = zone;
        preview(d);
      }
    };
    const tick = () => {
      const d = drag.current;
      if (!d) return;
      const edge = 56;
      const box = scroller().getBoundingClientRect();
      let dy = 0;
      if (d.y < box.top + edge) dy = -12; else if (d.y > box.bottom - edge) dy = 12;
      if (dy) scroller().scrollBy(0, dy);
      const wrap = scrollRef.current;
      let dx = 0;
      if (wrap) {
        const rect = wrap.getBoundingClientRect();
        if (d.x < rect.left + edge) dx = -12; else if (d.x > rect.right - edge) dx = 12;
        if (dx) wrap.scrollLeft += dx;
      }
      if (dy || dx) place();
      requestAnimationFrame(tick);
    };
    const start = (x: number, y: number) => {
      const p = press.current;
      if (!p) return;
      const rect = p.card.getBoundingClientRect();
      const ghost = p.card.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('data-card');
      Object.assign(ghost.style, {
        position: 'fixed', top: '0', left: '0', zIndex: '50', pointerEvents: 'none', width: `${rect.width}px`,
        boxShadow: '0 8px 22px rgba(10, 14, 20, 0.35)', outline: '', opacity: '1',
      });
      document.body.append(ghost);
      p.card.style.opacity = '0.35';
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      drag.current = { id: p.id, part: p.part, card: p.card, ghost, zone: null, x, y, offX: p.x - rect.left, offY: p.y - rect.top };
      press.current = null;
      live.current.onDragState(true);
      place();
      requestAnimationFrame(tick);
    };
    const finish = (drop: boolean) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      d.ghost.remove();
      d.card.style.opacity = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setTarget(d.zone, false);
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 60);
      live.current.onDragState(false);
      const z = d.zone?.dataset;
      if (drop && z?.day && z.vehicle && z.slot) live.current.onMove(d.id, d.part, Number(z.day), z.vehicle as VehicleId, z.slot);
    };
    const cancelPress = () => {
      if (press.current) window.clearTimeout(press.current.timer);
      press.current = null;
    };

    const down = (e: PointerEvent) => {
      const card = (e.target as HTMLElement | null)?.closest('[data-card]') as HTMLElement | null;
      if (!card || !scrollRef.current?.contains(card) || live.current.readOnly || e.button !== 0) return;
      const p: Press = { id: card.dataset.id!, part: card.dataset.part as Part, card, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', timer: 0 };
      if (p.touch) p.timer = window.setTimeout(() => { if (press.current === p) start(p.x, p.y); }, 220);
      press.current = p;
    };
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (d) { d.x = e.clientX; d.y = e.clientY; place(); return; }
      const p = press.current;
      if (!p) return;
      const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (p.touch) { if (dist > 10) cancelPress(); return; }
      if (dist > 5) start(e.clientX, e.clientY);
    };
    const up = () => { cancelPress(); finish(true); };
    const cancel = () => { cancelPress(); finish(false); };
    const touchMove = (e: TouchEvent) => { if (drag.current) e.preventDefault(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && drag.current) finish(false); };

    document.addEventListener('pointerdown', down);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('touchmove', touchMove, { passive: false });
    document.addEventListener('keydown', key);
    return () => {
      finish(false);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('touchmove', touchMove);
      document.removeEventListener('keydown', key);
    };
  }, []);

  // Pointing at either box of a run outlines both, so its pair is easy to find in a busy lane.
  const pairOn = (id: string | null) => {
    const root = scrollRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-paired]').forEach(c => { c.style.outline = ''; c.removeAttribute('data-paired'); });
    if (!id) return;
    root.querySelectorAll<HTMLElement>(`[data-card][data-id="${CSS.escape(id)}"]`).forEach(c => {
      c.style.outline = `2px solid ${ACCENT}`;
      c.style.outlineOffset = '1px';
      c.setAttribute('data-paired', '');
    });
  };
  const cardIdAt = (target: EventTarget) => ((target as HTMLElement).closest('[data-card]') as HTMLElement | null)?.dataset.id ?? null;

  const rows: React.ReactNode[] = [];
  let prev: string | null = null;
  const colSpan = 1 + days.length * lanes.length;
  for (const slot of grid.slots) {
    const start = toMin(slot);
    if (prev !== null && start - toMin(prev) > STEP) {
      rows.push(
        <tr key={`gap-${slot}`}>
          <td colSpan={colSpan} className="border-t border-gray-300 bg-gray-50 px-2 py-1 text-center text-xs text-gray-500">
            Sem percursos entre {toTime(toMin(prev) + STEP)} e {slot}
          </td>
        </tr>,
      );
    }
    prev = slot;
    const line = start % 60 === 0 ? 'border-t border-gray-300' : start % 15 === 0 ? 'border-t border-gray-200' : '';
    let has = false;
    const cells = days.flatMap(d => lanes.map((v, i) => {
      const lane = grid.lanes.get(laneKey(d, v)) ?? [];
      const boxes = grid.cells.get(cellKey(d, v, slot)) ?? [];
      if (boxes.length) has = true;
      const cap = VEHICLES[v].seats;
      const aboard = seatsDuring(lane, start);
      const peak = peakAfterPickups(lane, boxes.filter(b => b.part === 'pick').map(b => b.time));
      const over = peak > cap;
      return (
        <td
          key={`${d}-${v}`}
          data-zone
          data-day={d}
          data-vehicle={v}
          data-slot={slot}
          title={aboard ? `${aboard} a bordo` : undefined}
          className={`relative p-0 pl-[9px] pr-[3px] align-top ${LANE_BG[v]} ${line} ${i === 0 ? 'border-l-2 border-l-gray-700' : 'border-l border-l-gray-200'}`}
          style={{ height: narrow ? 16 : 9, boxShadow: over ? `inset 0 0 0 2px ${DANGER}` : undefined }}
        >
          {aboard > 0 && (
            <span aria-hidden className="absolute inset-y-0 left-0" style={{ width: 5, background: over ? DANGER : STRIP[v], opacity: 0.35 + 0.65 * Math.min(1, aboard / cap) }} />
          )}
          {boxes.length > 0 && (
            <div className="grid gap-0.5 py-0.5">
              {boxes.map(b => (
                <RunCard key={`${b.run.id}-${b.part}`} run={b.run} part={b.part} dimmed={onlyNew && !isNewRun(b.run)} readOnly={readOnly} />
              ))}
              {over && <span className="text-[0.7rem] font-bold text-red-600">{peak} de {cap} lugares</span>}
            </div>
          )}
        </td>
      );
    }));
    rows.push(
      <tr key={slot}>
        <th
          scope="row"
          aria-label={slot}
          className={`sticky left-0 z-10 bg-white px-1.5 py-0 text-left align-top font-mono text-[0.72rem] font-semibold leading-tight tabular-nums ${has ? 'text-gray-900' : 'text-gray-400'} ${line}`}
        >
          {has || start % 15 === 0 ? slot : ''}
        </th>
        {cells}
      </tr>,
    );
  }

  const stickyTop = fits ? 'sticky z-20' : '';
  return (
    <div
      ref={scrollRef}
      className={`rounded-lg border border-gray-200 bg-white ${fits ? '' : 'overflow-x-auto'}`}
      onClick={e => {
        const id = cardIdAt(e.target);
        if (!id || suppressClick.current || readOnly) return;
        props.onEdit(id);
      }}
      onContextMenu={e => { if (press.current || drag.current) e.preventDefault(); }}
      onPointerOver={e => { if (!drag.current) pairOn(cardIdAt(e.target)); }}
      onPointerLeave={() => { if (!drag.current) pairOn(null); }}
      onFocus={e => { const id = cardIdAt(e.target); if (id) pairOn(id); }}
      onBlur={() => { if (!drag.current) pairOn(null); }}
    >
      <table className="w-full table-fixed border-separate border-spacing-0" style={{ minWidth: fits ? undefined : minWidth }}>
        <colgroup>
          <col style={{ width: 52 }} />
          {days.map(d => lanes.map(v => <col key={`${d}-${v}`} />))}
        </colgroup>
        <thead>
          <tr>
            <th rowSpan={2} scope="col" className={`left-0 bg-white px-1.5 pb-1 text-left align-bottom text-xs font-normal text-gray-500 border-b-2 border-gray-800 ${fits ? 'sticky top-0 z-30' : 'sticky z-30'}`}>
              Horas
            </th>
            {days.map(d => (
              <th
                key={d}
                colSpan={lanes.length}
                scope="colgroup"
                className={`h-[30px] border-l-2 border-l-gray-700 bg-white px-2 text-left text-sm font-bold ${d === today ? 'text-indigo-600' : 'text-gray-900'} ${stickyTop}`}
                style={fits ? { top: 0 } : undefined}
              >
                {DAYS[d]}
              </th>
            ))}
          </tr>
          <tr>
            {days.map(d => lanes.map((v, i) => (
              <th
                key={`${d}-${v}`}
                scope="col"
                className={`border-b-2 border-gray-800 px-2 py-0.5 text-left text-xs font-semibold ${LANE_HEAD[v]} ${i === 0 ? 'border-l-2 border-l-gray-700' : 'border-l border-l-gray-200'} ${stickyTop}`}
                style={fits ? { top: 30 } : undefined}
              >
                {VEHICLES[v].label}
              </th>
            )))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
