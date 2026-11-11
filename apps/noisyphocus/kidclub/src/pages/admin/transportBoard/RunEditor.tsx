import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DAYS, VEHICLES, VEHICLE_IDS, dropOf, type TransportRun, type VehicleId } from './logic';

interface Props {
  /** The run being edited, or null to add a planning-only run. */
  run: TransportRun | null;
  /** The board has a stored plan for this subscription leg, so it can be reset. */
  hasPlan: boolean;
  defaultDay: number;
  defaultVehicle: VehicleId;
  onSave: (run: TransportRun) => void;
  onDuplicate: (run: TransportRun) => void;
  onDelete: () => void;
  onClose: () => void;
}

const field = 'w-full min-h-[38px] rounded-md border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm font-normal';
const label = 'grid gap-1 text-xs font-semibold text-gray-700 min-w-0';
const button = 'rounded-md border border-gray-300 px-3 py-1.5 text-sm font-semibold hover:bg-gray-50';

/**
 * Edit dialog: also the way to move a run without dragging. Mounted fresh each time it opens.
 * A subscription leg only edits its plan (vehicle, times, notes); who, which day and where come
 * from the subscription. A planning-only run edits everything.
 */
export default function RunEditor({ run, hasPlan, defaultDay, defaultVehicle, onSave, onDuplicate, onDelete, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const dropRef = useRef<HTMLInputElement>(null);
  const fromSub = run?.source === 'sub';
  const [name, setName] = useState(run?.name ?? '');
  const [vehicle, setVehicle] = useState<VehicleId>(run?.vehicle ?? defaultVehicle);
  const [day, setDay] = useState(run?.day ?? defaultDay);
  const [time, setTime] = useState(run?.time ?? '17:00');
  const [drop, setDrop] = useState(run?.dropAt ? dropOf(run).time : '');
  const [from, setFrom] = useState(run?.from ?? '');
  const [to, setTo] = useState(run?.to ?? '');
  const [by, setBy] = useState(run?.by ?? '');
  const [seats, setSeats] = useState(String(run?.seats ?? 1));
  const [note, setNote] = useState(run?.note ?? '');
  const [flag, setFlag] = useState(!!run?.flag);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => {
    dropRef.current?.setCustomValidity(drop && time && drop <= time ? 'A entrega tem de ser depois da recolha.' : '');
  }, [drop, time]);

  const readForm = (): TransportRun => {
    const base: TransportRun = run ?? { id: '', source: 'plan', name: '', day, vehicle, time };
    const next: TransportRun = {
      ...base, vehicle, time,
      dropAt: drop ? (run?.dropAt && dropOf(run).time === drop ? run.dropAt : drop) : undefined,
      by: by || undefined,
      note: note.trim() || undefined,
      flag: flag || undefined,
    };
    if (!fromSub) {
      const n = Math.min(8, Math.max(1, Number(seats) || 1));
      Object.assign(next, { name: name.trim(), day, from: from.trim() || undefined, to: to.trim() || undefined, seats: n > 1 ? n : undefined });
    }
    return next;
  };
  const close = () => dialogRef.current?.close();

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="w-[min(480px,calc(100vw-32px))] rounded-xl border border-gray-200 p-5 text-gray-900 backdrop:bg-black/50"
    >
      <form
        ref={formRef}
        onSubmit={e => {
          e.preventDefault();
          const next = readForm();
          if (!next.name || !next.time) return;
          onSave(next);
          close();
        }}
      >
        <h2 className="mb-1 text-lg font-bold">{run ? run.name : 'Novo percurso só no quadro'}</h2>
        {fromSub && run ? (
          <p className="mb-3 text-sm text-gray-600">
            {DAYS[run.day]} · {run.from || '?'} → {run.to || '?'} · pedido às {run.requested}
            {run.status === 'pending' ? ' · inscrição pendente' : ''}.{' '}
            <Link to={`/admin/subscriptions?highlight=${run.subId}`} className="text-indigo-600 hover:underline">Ver inscrição</Link>
          </p>
        ) : (
          <p className="mb-3 text-sm text-gray-600">
            Para uma criança que ainda não tem inscrição. Apague-o quando a inscrição existir, para não contar duas vezes.
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!fromSub && (
            <label className={`${label} sm:col-span-2`} htmlFor="tb-name">Nome
              <input id="tb-name" className={field} required maxLength={80} autoComplete="off" value={name} onChange={e => setName(e.target.value)} />
            </label>
          )}
          <label className={label} htmlFor="tb-vehicle">Viatura
            <select id="tb-vehicle" className={field} value={vehicle} onChange={e => setVehicle(e.target.value as VehicleId)}>
              {VEHICLE_IDS.map(v => <option key={v} value={v}>{VEHICLES[v].label}</option>)}
            </select>
          </label>
          {!fromSub && (
            <label className={label} htmlFor="tb-day">Dia
              <select id="tb-day" className={field} value={day} onChange={e => setDay(Number(e.target.value))}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          )}
          <label className={label} htmlFor="tb-time">{fromSub ? 'Recolha planeada' : 'Hora de recolha'}
            <input id="tb-time" type="time" step={60} required className={field} value={time} onChange={e => setTime(e.target.value)} />
          </label>
          <label className={label} htmlFor="tb-drop">Hora de entrega
            <input id="tb-drop" ref={dropRef} type="time" step={60} className={field} value={drop} onChange={e => setDrop(e.target.value)} />
          </label>
          {!fromSub && (
            <>
              <label className={`${label} sm:col-span-2`} htmlFor="tb-from">Local de recolha
                <input id="tb-from" className={field} maxLength={120} autoComplete="off" value={from} onChange={e => setFrom(e.target.value)} />
              </label>
              <label className={`${label} sm:col-span-2`} htmlFor="tb-to">Local de entrega
                <input id="tb-to" className={field} maxLength={120} autoComplete="off" value={to} onChange={e => setTo(e.target.value)} />
              </label>
            </>
          )}
          <label className={label} htmlFor="tb-by">Chegar até às
            <input id="tb-by" type="time" step={60} className={field} value={by} onChange={e => setBy(e.target.value)} />
          </label>
          {!fromSub && (
            <label className={label} htmlFor="tb-seats">Crianças
              <input id="tb-seats" type="number" min={1} max={8} step={1} required className={field} value={seats} onChange={e => setSeats(e.target.value)} />
            </label>
          )}
          <label className={`${label} sm:col-span-2`} htmlFor="tb-note">Nota
            <input id="tb-note" className={field} maxLength={120} autoComplete="off" value={note} onChange={e => setNote(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2" htmlFor="tb-flag">
            <input id="tb-flag" type="checkbox" className="h-4 w-4" checked={flag} onChange={e => setFlag(e.target.checked)} />Por combinar
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {run && (!fromSub || hasPlan) && (
            <button
              type="button"
              className="rounded-md border border-red-600 px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50"
              onClick={() => { if (!armed) { setArmed(true); return; } onDelete(); close(); }}
            >
              {armed ? 'Clique outra vez para confirmar' : fromSub ? 'Repor plano' : 'Apagar'}
            </button>
          )}
          {run && !fromSub && (
            <button type="button" className={button} onClick={() => { if (!formRef.current?.reportValidity()) return; onDuplicate(readForm()); close(); }}>
              Duplicar
            </button>
          )}
          <span className="ml-auto flex gap-2">
            <button type="button" className={button} onClick={close}>Cancelar</button>
            <button type="submit" className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-700">Guardar</button>
          </span>
        </div>
      </form>
    </dialog>
  );
}
