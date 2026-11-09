import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteDoc, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth } from '../../../lib/firebase';
import { col, docRef } from '../../../lib/db';
import { normalizeSubStatus } from '../../../lib/utils';
import TransportBoard from './TransportBoard';
import RunEditor from './RunEditor';
import {
  DAYS, DAYS_SHORT, RUNS_COLLECTION, VEHICLES, VEHICLE_IDS, buildRuns, moveBox, storedOf,
  type Part, type StoredRun, type SubInput, type TransportRun, type VehicleId,
} from './logic';

type Filter = 'both' | VehicleId;
interface UndoEntry { id: string; before: StoredRun | null }

const FILTER_KEY = 'transportBoard.show';
const now = new Date();
const TODAY = now.getDay() >= 1 && now.getDay() <= 5 ? now.getDay() - 1 : -1;
const TODAY_ISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
const withoutStamp = ({ updatedAt: _a, updatedBy: _b, ...rest }: StoredRun) => rest;
const asString = (v: unknown) => (typeof v === 'string' ? v : undefined);

const btn = 'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white';
const pressed = 'border-gray-900 bg-gray-900 text-white hover:bg-gray-800';

/**
 * Transportes: the dispatcher board for the van and the car. Admin-only (route and Firestore rules).
 * Who rides, which day, where and the requested time come live from transport subscriptions; the
 * board keeps only its plan for each leg (and planning-only runs) in `transportRuns`. It never
 * writes to subscriptions or billing.
 */
export default function TransportBoardPage() {
  const [subs, setSubs] = useState<SubInput[]>([]);
  const [stored, setStored] = useState<Map<string, StoredRun>>(new Map());
  const [loaded, setLoaded] = useState({ subs: false, plan: false });
  const [status, setStatus] = useState('A carregar o quadro…');
  const [readOnly, setReadOnly] = useState(false);
  const [filter, setFilter] = useState<Filter>(readFilter);
  const [onlyNew, setOnlyNew] = useState(false);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [editing, setEditing] = useState<{ key: number; id: string | null } | null>(null);
  const [day, setDay] = useState(TODAY < 0 ? 0 : TODAY);
  const [width, setWidth] = useState(1200);
  const wrapRef = useRef<HTMLDivElement>(null);
  const runs = useMemo(() => buildRuns(subs, stored, TODAY_ISO), [subs, stored]);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const storedRef = useRef(stored);
  storedRef.current = stored;
  // Live updates wait while a box is being dragged; the board catches up when it's dropped.
  const dragging = useRef(false);
  const pending = useRef<{ subs?: SubInput[]; stored?: Map<string, StoredRun> }>({});

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const unsubSubs = onSnapshot(col('transportationSubscriptions'), snap => {
      const next: SubInput[] = snap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id, status: normalizeSubStatus(x.status), childName: asString(x.childName),
          weekPattern: x.weekPattern, startDate: asString(x.startDate), endDate: asString(x.endDate),
          schedule: Array.isArray(x.schedule) ? x.schedule : [],
        };
      });
      if (dragging.current) pending.current.subs = next; else setSubs(next);
      setLoaded(l => (l.subs ? l : { ...l, subs: true }));
    }, () => setStatus('Não foi possível ler as inscrições de transporte. Recarregue a página.'));
    const unsubPlan = onSnapshot(col(RUNS_COLLECTION), snap => {
      const next = new Map(snap.docs.map(d => [d.id, d.data() as StoredRun]));
      if (dragging.current) pending.current.stored = next; else setStored(next);
      setLoaded(l => (l.plan ? l : { ...l, plan: true }));
    }, err => {
      setLoaded(l => ({ ...l, plan: true }));
      if (err.code === 'permission-denied') setReadOnly(true);
      setStatus(err.code === 'permission-denied'
        ? 'O plano do quadro não está acessível. As inscrições aparecem, mas as alterações não ficam guardadas.'
        : 'O quadro deixou de atualizar. Recarregue a página para ver o plano mais recente.');
    });
    return () => { unsubSubs(); unsubPlan(); };
  }, []);

  useEffect(() => {
    if (loaded.subs && loaded.plan && status === 'A carregar o quadro…') {
      setStatus(runs.length ? '' : 'Ainda não há inscrições de transporte nem percursos no quadro.');
    }
  }, [loaded, runs.length, status]);

  // Firestore shows a write on the board straight away and rolls it back if the server refuses it.
  const write = (id: string, body: StoredRun | null) => {
    const ref = docRef(RUNS_COLLECTION, id);
    return body ? setDoc(ref, { ...body, updatedAt: serverTimestamp(), updatedBy: auth.currentUser?.uid ?? null }) : deleteDoc(ref);
  };
  const failed = (err: unknown) => {
    if ((err as { code?: string } | null)?.code === 'permission-denied') {
      setReadOnly(true);
      setStatus('Não tem permissão para alterar este quadro.');
    } else {
      setStatus('A alteração não ficou guardada. Verifique a ligação e tente outra vez.');
    }
  };
  const commit = (id: string, body: StoredRun | null, message: string) => {
    const raw = storedRef.current.get(id);
    const entry: UndoEntry = { id, before: raw ? withoutStamp(raw) : null };
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
    commit(id, storedOf(out.run), out.message);
  };
  const onDragState = useCallback((on: boolean) => {
    dragging.current = on;
    if (on) return;
    const { subs: s, stored: p } = pending.current;
    pending.current = {};
    if (s) setSubs(s);
    if (p) setStored(p);
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
  const editingRun: TransportRun | null = editing?.id ? runs.find(r => r.id === editing.id) ?? null : null;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Transportes</h1>
        <p className="max-w-3xl text-sm text-gray-600">
          Cada inscrição de transporte ativa ou pendente aparece aqui, na carrinha até ser planeada. Cada percurso tem duas caixas, a recolha (cheia) e a entrega (só contorno), e o espaço entre elas é o tempo de viagem.{' '}
          {narrow ? 'Mantenha o dedo numa caixa para a arrastar, ou toque para editar.' : 'Arraste uma caixa para a mover, ou clique para editar o plano.'}{' '}
          O plano fica guardado para todos os administradores.
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
          <span className="inline-flex items-center gap-1.5"><i className="rounded-sm bg-amber-500 px-1 text-[0.62rem] font-bold not-italic text-white">PENDENTE</i>Inscrição por aprovar</span>
          <span className="inline-flex items-center gap-1.5"><i className="rounded-sm bg-gray-900 px-1 text-[0.62rem] font-bold not-italic text-white">PLANO</i>Só no quadro, sem inscrição</span>
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
              <button type="button" className={`${btn} ${pressed}`} onClick={() => setEditing({ key: Date.now(), id: null })}>Adicionar só no quadro</button>
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
          <li><strong>As crianças vêm das inscrições.</strong> Quem vai, em que dia, de onde, para onde e a hora pedida vêm da inscrição: para mudar isso, altere a inscrição. O quadro guarda só o plano (viatura, horas planeadas, notas) e nunca mexe em inscrições nem cobranças.</li>
          <li><strong>PLANO é só para planear.</strong> Use Adicionar só no quadro para uma criança que ainda não tem inscrição, e apague-o quando a inscrição existir, para não contar a criança duas vezes.</li>
          <li><strong>Mover caixas.</strong> A recolha leva a entrega consigo, por isso o tempo de viagem mantém-se. A entrega move-se sozinha, o que muda o tempo de viagem. Arrastar para a outra viatura leva o percurso todo; para outro dia, só num percurso PLANO.</li>
          <li><strong>O quadro conta lugares, não estradas.</strong> Soma quem vai a bordo entre a recolha e a entrega e avisa quando uma viatura passa os seus lugares. Não sabe se a viatura chega a tempo à paragem seguinte.</li>
          <li><strong>Uma hora com ~ é provisória,</strong> 15 minutos depois da recolha. Arraste a caixa ou edite o plano para a definir. Se o horário de uma inscrição mudar, confirme o plano dessa criança.</li>
        </ul>
      </section>

      {editing && (
        <RunEditor
          key={editing.key}
          run={editingRun}
          hasPlan={!!editing.id && stored.has(editing.id)}
          defaultDay={narrow ? day : TODAY < 0 ? 0 : TODAY}
          defaultVehicle={filter === 'car' ? 'car' : 'van'}
          onClose={() => setEditing(null)}
          onSave={next => {
            const id = editing.id ?? doc(col(RUNS_COLLECTION)).id;
            commit(id, storedOf({ ...next, id }), `Guardado: ${next.name}.`);
          }}
          onDuplicate={next => commit(doc(col(RUNS_COLLECTION)).id, storedOf(next), `Copiado: ${next.name}.`)}
          onDelete={() => {
            if (!editingRun) return;
            commit(editingRun.id, null, editingRun.source === 'sub'
              ? `Plano de ${editingRun.name} reposto: volta ao que diz a inscrição.`
              : `Apagado: ${editingRun.name}. Desfazer recupera-o.`);
          }}
        />
      )}
    </div>
  );
}
