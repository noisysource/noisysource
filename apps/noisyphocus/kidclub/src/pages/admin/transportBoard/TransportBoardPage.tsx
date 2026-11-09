import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteDoc, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth } from '../../../lib/firebase';
import { col, docRef } from '../../../lib/db';
import TransportBoard from './TransportBoard';
import RunEditor from './RunEditor';
import {
  DAYS, DAYS_SHORT, RUNS_COLLECTION, VEHICLES, VEHICLE_IDS, bodyOf, isRun, moveBox,
  type Part, type RunBody, type TransportRun, type VehicleId,
} from './logic';

type Filter = 'both' | VehicleId;
interface UndoEntry { id: string; before: RunBody | null }

const FILTER_KEY = 'transportBoard.show';
const weekday = new Date().getDay();
const TODAY = weekday >= 1 && weekday <= 5 ? weekday - 1 : -1;
/** Below this width the board shows one day at a time, with tabs. */
const NARROW = 760;
const LANE_MIN = 104;

function readFilter(): Filter {
  try {
    const saved = localStorage.getItem(FILTER_KEY);
    if (saved === 'van' || saved === 'car') return saved;
  } catch { /* storage blocked: show both */ }
  return 'both';
}

const btn = 'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white';
const pressed = 'border-gray-900 bg-gray-900 text-white hover:bg-gray-800';

/**
 * Transportes: the dispatcher board for the van and the car. Admin-only (route and Firestore rules).
 * Runs live in `transportRuns`, separate from transport subscriptions: changing a subscription
 * doesn't change the board, and the board never touches billing.
 */
export default function TransportBoardPage() {
  const [runs, setRuns] = useState<TransportRun[]>([]);
  const [status, setStatus] = useState('A carregar o quadro…');
  const [readOnly, setReadOnly] = useState(false);
  const [filter, setFilter] = useState<Filter>(readFilter);
  const [onlyNew, setOnlyNew] = useState(false);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [editing, setEditing] = useState<{ key: number; id: string | null } | null>(null);
  const [day, setDay] = useState(TODAY < 0 ? 0 : TODAY);
  const [width, setWidth] = useState(1200);
  const wrapRef = useRef<HTMLDivElement>(null);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const dragging = useRef(false);
  const pending = useRef<TransportRun[] | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let loaded = false;
    const slow = window.setTimeout(() => {
      if (!loaded) setStatus("O quadro ainda não respondeu. Aparece assim que a ligação voltar.");
    }, 10000);
    const unsub = onSnapshot(col(RUNS_COLLECTION), snap => {
      const next = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(isRun);
      if (!loaded && (!snap.metadata.fromCache || next.length)) {
        loaded = true;
        window.clearTimeout(slow);
        setStatus(next.length ? '' : 'Ainda não há percursos. Use Adicionar para criar o primeiro.');
      }
      // Hold live updates back during a drag; the board catches up when it ends.
      if (dragging.current) pending.current = next; else setRuns(next);
    }, err => {
      window.clearTimeout(slow);
      setStatus(err.code === 'permission-denied'
        ? 'Não tem acesso a este quadro.'
        : 'O quadro deixou de atualizar. Recarregue a página para ver os percursos mais recentes.');
    });
    return () => { window.clearTimeout(slow); unsub(); };
  }, []);

  // Firestore shows a write on the board straight away and rolls it back if the server refuses it.
  const write = (id: string, body: RunBody | null) => {
    const ref = docRef(RUNS_COLLECTION, id);
    return body
      ? setDoc(ref, { ...bodyOf(body), updatedAt: serverTimestamp(), updatedBy: auth.currentUser?.uid ?? null })
      : deleteDoc(ref);
  };
  const failed = (err: unknown) => {
    if ((err as { code?: string } | null)?.code === 'permission-denied') {
      setReadOnly(true);
      setStatus('Não tem permissão para alterar este quadro.');
    } else {
      setStatus('A alteração não ficou guardada. Verifique a ligação e tente outra vez.');
    }
  };
  const commit = (id: string, body: RunBody | null, message: string) => {
    const current = runsRef.current.find(r => r.id === id);
    const entry: UndoEntry = { id, before: current ? bodyOf(current) : null };
    setUndoStack(s => [...s, entry]);
    write(id, body)
      .then(() => setStatus(message))
      .catch(err => { setUndoStack(s => s.filter(x => x !== entry)); failed(err); });
  };
  const undo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack(s => s.slice(0, -1));
    write(last.id, last.before).then(() => setStatus('Desfeito.')).catch(failed);
  };

  const onMove = (id: string, part: Part, toDay: number, vehicle: VehicleId, slot: string) => {
    const r = runsRef.current.find(x => x.id === id);
    if (!r) return;
    const out = moveBox(r, part, toDay, vehicle, slot);
    if (!out) return;
    if ('error' in out) { setStatus(out.error); return; }
    commit(id, out.body, out.message);
  };
  const onDragState = useCallback((on: boolean) => {
    dragging.current = on;
    if (!on && pending.current) { setRuns(pending.current); pending.current = null; }
  }, []);
  const chooseFilter = (f: Filter) => {
    setFilter(f);
    try { localStorage.setItem(FILTER_KEY, f); } catch { /* not remembered, still applied */ }
  };

  const narrow = width < NARROW;
  const days = narrow ? [day] : [0, 1, 2, 3, 4];
  const lanes = filter === 'both' ? VEHICLE_IDS : [filter];
  const minWidth = 52 + days.length * lanes.length * LANE_MIN;
  const fits = width >= minWidth;
  const editingRun = editing?.id ? runs.find(r => r.id === editing.id) ?? null : null;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Transportes</h1>
        <p className="max-w-3xl text-sm text-gray-600">
          Cada percurso tem duas caixas, a recolha (cheia) e a entrega (só contorno), e o espaço entre elas é o tempo de viagem.{' '}
          {narrow ? 'Mantenha o dedo numa caixa para a arrastar, ou toque para editar.' : 'Arraste uma caixa para a mover, ou clique para editar o percurso.'}{' '}
          As alterações ficam guardadas para todos os administradores.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-600">
          <span className="inline-flex items-center gap-1.5"><i className="h-3.5 w-[18px] rounded-sm border border-blue-500 bg-blue-100" />{VEHICLES.van.label}, {VEHICLES.van.seats} lugares</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-3.5 w-[18px] rounded-sm border border-orange-500 bg-orange-100" />{VEHICLES.car.label}, {VEHICLES.car.seats} lugares</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-3.5 w-[18px] rounded-sm border border-gray-500 bg-gray-400" />Recolha</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-3.5 w-[18px] rounded-sm border border-gray-500 bg-white" />Entrega</span>
          <span className="inline-flex items-center gap-1.5"><b className="font-mono">~</b>Hora de entrega por definir</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-3.5 w-[5px] bg-gray-500" />Crianças a bordo (mais escuro, mais cheio)</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-3.5 w-[18px] rounded-sm border-2 border-dashed border-amber-600" />Por combinar</span>
          <span className="inline-flex items-center gap-1.5"><i className="rounded-sm bg-gray-900 px-1 text-[0.62rem] font-bold not-italic text-white">NOVO</i>Ainda não ativo na app</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <div className="inline-flex" role="group" aria-label="Mostrar viaturas">
            {(['both', ...VEHICLE_IDS] as Filter[]).map((f, i, all) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => chooseFilter(f)}
                className={`${btn} ${filter === f ? pressed : ''} ${i === 0 ? 'rounded-r-none' : i === all.length - 1 ? '-ml-px rounded-l-none' : '-ml-px rounded-none'}`}
              >
                {f === 'both' ? 'Ambas' : VEHICLES[f].label}
              </button>
            ))}
          </div>
          <button type="button" aria-pressed={onlyNew} className={`${btn} ${onlyNew ? pressed : ''}`} onClick={() => setOnlyNew(v => !v)}>Destacar novos</button>
          {!readOnly && (
            <>
              <button type="button" className={btn} disabled={!undoStack.length} onClick={undo}>Desfazer</button>
              <button type="button" className={`${btn} ${pressed}`} onClick={() => setEditing({ key: Date.now(), id: null })}>Adicionar</button>
            </>
          )}
        </div>
      </div>
      <p className="min-h-[1.25rem] text-sm text-gray-600" aria-live="polite">{status}</p>

      <div ref={wrapRef} className="min-w-0 space-y-2">
        {narrow && (
          <div className="grid grid-cols-5 gap-1">
            {DAYS_SHORT.map((d, i) => (
              <button key={d} type="button" aria-label={DAYS[i]} aria-pressed={day === i} onClick={() => setDay(i)} className={`${btn} px-0.5 py-2.5 ${day === i ? pressed : ''}`}>{d}</button>
            ))}
          </div>
        )}
        <TransportBoard
          runs={runs}
          days={days}
          lanes={lanes}
          today={TODAY}
          narrow={narrow}
          fits={fits}
          minWidth={minWidth}
          onlyNew={onlyNew}
          readOnly={readOnly}
          onMove={onMove}
          onEdit={id => setEditing({ key: Date.now(), id })}
          onDragState={onDragState}
        />
      </div>

      <section className="max-w-3xl space-y-2">
        <h2 className="text-lg font-bold">A saber</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-700">
          <li><strong>Mover caixas.</strong> A recolha leva a entrega consigo, por isso o tempo de viagem mantém-se. A entrega move-se sozinha, o que muda o tempo de viagem. Arrastar qualquer uma para outro dia ou viatura leva o percurso todo.</li>
          <li><strong>O quadro conta lugares, não estradas.</strong> Soma quem vai a bordo entre a recolha e a entrega e avisa quando uma viatura passa os seus lugares. Não sabe se a viatura chega a tempo à paragem seguinte.</li>
          <li><strong>Uma hora com ~ é provisória,</strong> normalmente 15 minutos depois da recolha. Arraste a caixa ou edite o percurso para a definir.</li>
          <li><strong>O quadro é separado das inscrições.</strong> Uma inscrição nova, alterada ou cancelada não aparece aqui sozinha, e mexer no quadro não muda inscrições nem cobranças.</li>
        </ul>
      </section>

      {editing && (
        <RunEditor
          key={editing.key}
          run={editingRun}
          defaultDay={narrow ? day : TODAY < 0 ? 0 : TODAY}
          defaultVehicle={filter === 'car' ? 'car' : 'van'}
          onClose={() => setEditing(null)}
          onSave={body => {
            const id = editing.id ?? doc(col(RUNS_COLLECTION)).id;
            commit(id, body, `Guardado: ${body.name}.`);
          }}
          onDuplicate={body => commit(doc(col(RUNS_COLLECTION)).id, body, `Copiado: ${body.name}.`)}
          onDelete={() => { if (editingRun) commit(editingRun.id, null, `Apagado: ${editingRun.name}. Desfazer recupera-o.`); }}
        />
      )}
    </div>
  );
}
