import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { getDocs, query, where } from 'firebase/firestore';
import { col } from '../../lib/db';
import { callable } from '../../lib/callable';
import { familyService } from '../../services/familyService';
import { coerceSubscriptionDate } from '../../lib/utils';
import type { Child, StudyRoomEntry, TransportationSubscription } from '@shared/models';
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek,
  addMonths, isSameMonth, isToday, isBefore, startOfToday,
} from 'date-fns';
import { pt } from 'date-fns/locale';
import { reportClientError } from '../../lib/clientErrors';

/**
 * One calendar for the whole family.
 *
 * Replaces a four-step path — dashboard, subscriptions, child, subscription
 * detail — with a single screen. It also replaces the two schedule pages that
 * showed overlapping subsets of the same thing and were reachable only by
 * typing their URLs.
 *
 * It reads `reservationEvents` directly, which is the source of truth for what
 * is served and what was cancelled. The older per-child calendar goes through
 * `eventService` and the legacy `Event` model; this does not.
 *
 * Seeing every child and both services on one grid is also what makes data
 * problems visible: a subscription that generated no occurrences, or a day
 * with a leg missing, stands out here in a way it cannot on a per-subscription
 * page. The "sem ocorrências" warning below exists for exactly that.
 */

const ISO = (d: Date) => format(d, 'yyyy-MM-dd');

// Enough hues to stay distinguishable; wraps for very large families.
const CHILD_COLOURS = [
  { dot: 'bg-blue-500',   chip: 'bg-blue-50 text-blue-900 border-blue-200',       on: 'ring-blue-400' },
  { dot: 'bg-purple-500', chip: 'bg-purple-50 text-purple-900 border-purple-200', on: 'ring-purple-400' },
  { dot: 'bg-teal-500',   chip: 'bg-teal-50 text-teal-900 border-teal-200',       on: 'ring-teal-400' },
  { dot: 'bg-amber-500',  chip: 'bg-amber-50 text-amber-900 border-amber-200',    on: 'ring-amber-400' },
  { dot: 'bg-rose-500',   chip: 'bg-rose-50 text-rose-900 border-rose-200',       on: 'ring-rose-400' },
];

interface EventRow {
  id: string;
  date: string;
  childId: string;
  subscriptionId: string;
  type: 'study' | 'transport';
  status: 'EXPECTED' | 'CANCELLED' | 'VOIDED';
  legIndex?: number;
  time?: string;
  label?: string;
}

/**
 * The old per-child calendar (/client/children/:childId/calendar,
 * EventCalendarPage) queried subscriptions by childId and every family's
 * transport subscriptions, which the rules deny a parent: it failed with
 * permission-denied (Patrícia Tavares, 2026-10-20). That route now lands here
 * with the child pre-selected (Renato, 2026-10-31).
 */
export function ChildCalendarRedirect() {
  const { childId } = useParams();
  return <Navigate to={childId ? `/client/calendar?child=${encodeURIComponent(childId)}` : '/client/calendar'} replace />;
}

export default function FamilyCalendarPage() {
  const user = useUser();
  const [searchParams] = useSearchParams();
  const preselectChild = searchParams.get('child');
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [children, setChildren] = useState<Child[]>([]);
  const [subs, setSubs] = useState<(StudyRoomEntry | TransportationSubscription)[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [hiddenChildren, setHiddenChildren] = useState<Set<string>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [onlyCancelled, setOnlyCancelled] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const fam = await familyService.getOrCreateFamily(
        user.uid, user.name || user.email?.split('@')[0] || 'Utilizador', user.email || ''
      );
      const kids = await familyService.getFamilyChildren(fam.id, false, user.uid);
      setChildren(kids);

      const perChild = await Promise.all(kids.map(async c => {
        try { return await familyService.getChildSubscriptions(c.id, user.uid); }
        catch { return { study: [], transport: [] }; }
      }));
      const allSubs = perChild.flatMap(p => [...p.study, ...p.transport]);
      setSubs(allSubs);

      // One query for the whole family and month, rather than one per
      // subscription: firestore.rules scopes reservationEvents to the owning
      // family, so this is both cheaper and exactly what the parent may read.
      const from = ISO(startOfWeek(startOfMonth(month), { weekStartsOn: 1 }));
      const to = ISO(endOfWeek(endOfMonth(month), { weekStartsOn: 1 }));
      const snap = await getDocs(query(
        col('reservationEvents'),
        where('familyId', '==', fam.id),
        where('date', '>=', from),
        where('date', '<=', to),
      ));

      const subById = new Map(allSubs.map(s => [s.id, s as any]));
      const rows: EventRow[] = snap.docs.map(d => {
        const e = d.data() as any;
        const sub = subById.get(e.subscriptionId);
        let time: string | undefined;
        let label: string | undefined;
        if (e.subscriptionType === 'transport') {
          const leg = sub?.schedule?.[e.legIndex ?? 0];
          time = leg?.pickupTime;
          label = leg?.dropoffLocation ? `→ ${String(leg.dropoffLocation).split(',')[0]}` : undefined;
        } else {
          const day = sub?.days?.find((x: any) => x.day === format(new Date(`${e.date}T12:00:00`), 'EEEE').toLowerCase());
          time = day?.hour;
        }
        return {
          id: d.id, date: e.date, childId: e.childId, subscriptionId: e.subscriptionId,
          type: e.subscriptionType, status: e.status, legIndex: e.legIndex, time, label,
        };
      });
      rows.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
      setEvents(rows);
    } catch (e: any) {
      console.error('[FamilyCalendarPage] load failed', e);
      setError(e?.message ?? 'Não foi possível carregar o calendário.');
    } finally {
      setLoading(false);
    }
  }, [user, month]);

  useEffect(() => { load(); }, [load]);

  // ?child=<id> (from a child's page): show only that child to start with.
  // The other children's chips stay there to switch back on.
  const [preselected, setPreselected] = useState(false);
  useEffect(() => {
    if (preselected || !preselectChild || !children.length) return;
    if (children.some(c => c.id === preselectChild)) {
      setHiddenChildren(new Set(children.filter(c => c.id !== preselectChild).map(c => c.id)));
    }
    setPreselected(true);
  }, [children, preselectChild, preselected]);

  const childIndex = useMemo(
    () => new Map(children.map((c, i) => [c.id, i % CHILD_COLOURS.length])), [children]
  );
  const childName = useMemo(
    () => new Map(children.map(c => [c.id, `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || 'Criança'])), [children]
  );

  const visible = useMemo(() => events.filter(e =>
    e.status !== 'VOIDED'
    && !hiddenChildren.has(e.childId)
    && !hiddenTypes.has(e.type)
    && (!onlyCancelled || e.status === 'CANCELLED')
  ), [events, hiddenChildren, hiddenTypes, onlyCancelled]);

  const byDate = useMemo(() => {
    const m = new Map<string, EventRow[]>();
    for (const e of visible) (m.get(e.date) ?? m.set(e.date, []).get(e.date)!).push(e);
    return m;
  }, [visible]);

  // A subscription that is active but produced nothing this month. Under flat
  // pricing that still bills in full, so it is worth surfacing rather than
  // leaving as a blank row — it is the difference between "no school this
  // month" and "generation failed".
  const silentSubs = useMemo(() => {
    const withEvents = new Set(events.map(e => e.subscriptionId));
    return subs.filter(s => {
      const status = (s as any).status;
      if (!['active', 'confirmed'].includes(status)) return false;
      if (withEvents.has(s.id)) return false;
      const start = coerceSubscriptionDate((s as any).startDate, 'start');
      return !start || start <= endOfMonth(month);
    });
  }, [subs, events, month]);

  const toggle = async (e: EventRow) => {
    if (busyId) return;
    setBusyId(e.id);
    setError(null);
    const next = e.status === 'CANCELLED' ? 'EXPECTED' : 'CANCELLED';
    // Optimistic: the grid is dense and a full reload on every click made it
    // feel broken. Reverted below if the callable refuses.
    setEvents(prev => prev.map(x => x.id === e.id ? { ...x, status: next } : x));
    try {
      const fn = callable<{ eventId: string; status: 'EXPECTED' | 'CANCELLED' }, { ok: boolean }>('setReservationEventStatus');
      await fn({ eventId: e.id, status: next });
    } catch (err: any) {
      reportClientError('[FamilyCalendarPage] change day failed', err);
      setEvents(prev => prev.map(x => x.id === e.id ? { ...x, status: e.status } : x));
      setError(err?.message ?? 'Não foi possível alterar este dia.');
    } finally {
      setBusyId(null);
    }
  };

  const days = useMemo(() => eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }),
  }), [month]);

  const counts = useMemo(() => ({
    expected: visible.filter(e => e.status === 'EXPECTED' && isSameMonth(new Date(`${e.date}T12:00:00`), month)).length,
    cancelled: visible.filter(e => e.status === 'CANCELLED' && isSameMonth(new Date(`${e.date}T12:00:00`), month)).length,
  }), [visible, month]);

  const toggleIn = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    apply(next);
  };

  if (loading && !events.length) {
    return <div className="flex justify-center items-center h-64 text-gray-500">A carregar calendário…</div>;
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Calendário da família</h1>
          <p className="text-sm text-gray-500">
            Todos os filhos e serviços num só sítio. Clique num dia para cancelar ou repor.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setMonth(m => addMonths(m, -1))}
            className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">←</button>
          <span className="px-3 text-sm font-semibold capitalize min-w-[9rem] text-center">
            {format(month, 'MMMM yyyy', { locale: pt })}
          </span>
          <button onClick={() => setMonth(m => addMonths(m, 1))}
            className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">→</button>
          <button onClick={() => setMonth(startOfMonth(new Date()))}
            className="ml-1 px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 text-sm hover:bg-gray-50">Hoje</button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {children.map(c => {
          const i = childIndex.get(c.id) ?? 0;
          const off = hiddenChildren.has(c.id);
          return (
            <button key={c.id}
              onClick={() => toggleIn(hiddenChildren, c.id, setHiddenChildren)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm transition ${
                off ? 'bg-gray-50 text-gray-400 border-gray-200 line-through' : CHILD_COLOURS[i].chip}`}>
              <span className={`w-2.5 h-2.5 rounded-full ${off ? 'bg-gray-300' : CHILD_COLOURS[i].dot}`} />
              {childName.get(c.id)}
            </button>
          );
        })}
        <span className="w-px h-6 bg-gray-200 mx-1" />
        {(['study', 'transport'] as const).map(t => (
          <button key={t}
            onClick={() => toggleIn(hiddenTypes, t, setHiddenTypes)}
            className={`px-3 py-1.5 rounded-full border text-sm transition ${
              hiddenTypes.has(t) ? 'bg-gray-50 text-gray-400 border-gray-200 line-through'
                                 : 'bg-white text-gray-700 border-gray-300'}`}>
            {t === 'study' ? '📚 Sala de Estudo' : '🚌 Transporte'}
          </button>
        ))}
        <button onClick={() => setOnlyCancelled(v => !v)}
          className={`px-3 py-1.5 rounded-full border text-sm transition ${
            onlyCancelled ? 'bg-red-50 text-red-700 border-red-200' : 'bg-white text-gray-700 border-gray-300'}`}>
          Só faltas
        </button>
        <span className="ml-auto text-xs text-gray-500">
          {counts.expected} previsto(s) · {counts.cancelled} falta(s) neste mês
        </span>
      </div>

      {error && (
        <p className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
      )}

      {silentSubs.length > 0 && (
        <div className="mb-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <strong>Sem ocorrências geradas</strong> neste mês para:{' '}
          {silentSubs.map(s => `${(s as any).childName ?? 'criança'} (${(s as any).days ? 'estudo' : 'transporte'})`).join(', ')}.
          {' '}A inscrição está ativa, por isso o mês é faturado na mesma — avise-nos se isto não estiver certo.
        </div>
      )}

      {/* Grid */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="grid grid-cols-7 bg-gray-50 border-b border-gray-200">
          {['2ª', '3ª', '4ª', '5ª', '6ª', 'Sáb', 'Dom'].map(d => (
            <div key={d} className="px-2 py-2 text-[11px] font-semibold text-gray-500 text-center">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map(day => {
            const iso = ISO(day);
            const dayEvents = byDate.get(iso) ?? [];
            const outside = !isSameMonth(day, month);
            const past = isBefore(day, startOfToday());
            return (
              <div key={iso}
                className={`min-h-[6rem] border-b border-r border-gray-100 p-1.5 ${outside ? 'bg-gray-50/60' : ''}`}>
                <div className={`text-[11px] mb-1 flex items-center justify-between ${
                  outside ? 'text-gray-300' : past ? 'text-gray-400' : 'text-gray-600'}`}>
                  <span className={isToday(day) ? 'bg-blue-600 text-white rounded-full w-5 h-5 grid place-items-center font-semibold' : ''}>
                    {format(day, 'd')}
                  </span>
                </div>
                <div className="space-y-1">
                  {dayEvents.map(e => {
                    const i = childIndex.get(e.childId) ?? 0;
                    const c = CHILD_COLOURS[i];
                    const cancelled = e.status === 'CANCELLED';
                    return (
                      <button key={e.id}
                        onClick={() => toggle(e)}
                        disabled={busyId === e.id}
                        title={`${childName.get(e.childId)} · ${e.type === 'study' ? 'Sala de Estudo' : 'Transporte'}`
                          + `${e.time ? ` · ${e.time}` : ''}${e.label ? ` ${e.label}` : ''}`
                          + `\n${cancelled ? 'Cancelado — clique para repor' : 'Clique para cancelar'}`}
                        className={`w-full text-left text-[10px] leading-tight px-1.5 py-1 rounded border transition
                          disabled:opacity-40 ${cancelled
                            ? 'bg-gray-50 border-gray-200 text-gray-400 line-through'
                            : `${c.chip} hover:ring-2 ${c.on}`}`}>
                        <span className="block truncate font-medium">
                          {e.type === 'study' ? '📚' : '🚌'} {e.time ?? ''}
                        </span>
                        <span className="block truncate opacity-75">{childName.get(e.childId)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-3 text-xs text-gray-400">
        As faltas contam para o crédito mensal a partir de 3 faltas no mesmo serviço.
        Se o mês já estiver pago, o crédito é descontado na fatura do mês seguinte.
        Precisa de alterar horários ou cancelar uma inscrição?{' '}
        <Link to="/client/subscriptions" className="text-blue-600 hover:underline">Ver inscrições</Link>.
      </p>
    </div>
  );
}
