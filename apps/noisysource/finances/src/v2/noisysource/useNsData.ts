import { useCallback, useEffect, useMemo, useState } from 'react';
import { todayInLisbon } from '@shared/finhub/dates';
import { reconcile, type Reconciliation } from '@shared/finhub/noisysource/reconcile';
import { rebuildNsState, type NsState } from '@shared/finhub/noisysource/state';
import type { NsEvent } from '@shared/finhub/noisysource/events';
import { readNsEvents, type InvalidEvent } from './eventStore';

export interface NsData {
  loading: boolean;
  error: string | null;
  events: NsEvent[];
  invalid: InvalidEvent[];
  state: NsState | null;
  today: string;
  /** Bank accounts with imported lines, the busiest first. */
  accounts: string[];
  /** The company's main account (the busiest): what Tesouraria and Mês show. */
  accountId: string | null;
  /** Bank lines vs plan for the main account: confirmed + suggestions (never stored). */
  rec: Reconciliation | null;
  /** Every id in the log, reversed ones included (new ids must avoid them). */
  eventIds: Set<string>;
  reload: () => void;
}

/** Loads NoisySource's events once and rebuilds the state in the browser (nothing derived is stored). */
export function useNsData(): NsData {
  const [events, setEvents] = useState<NsEvent[]>([]);
  const [invalid, setInvalid] = useState<InvalidEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    readNsEvents()
      .then(r => { if (!cancelled) { setEvents(r.events); setInvalid(r.invalid); } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tick]);

  const state = useMemo(() => (events.length ? rebuildNsState(events) : null), [events]);
  const accounts = useMemo(() => {
    const count = new Map<string, number>();
    for (const m of state?.movements ?? []) count.set(m.accountId, (count.get(m.accountId) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [state]);
  const accountId = accounts[0] ?? null;
  const rec = useMemo(() => (state && accountId ? reconcile(state, { accountId }) : null), [state, accountId]);
  const eventIds = useMemo(() => new Set([...events.map(e => e.id), ...invalid.map(i => i.id)]), [events, invalid]);
  const reload = useCallback(() => setTick(t => t + 1), []);

  return { loading, error, events, invalid, state, today: todayInLisbon(), accounts, accountId, rec, eventIds, reload };
}
