// What the Mês screen writes: confirmations of suggestions, classifications, written reasons, and
// their undo (a reversal). Every write is an event; the screen reloads the log afterwards.

import { nextFreeId, nsIds } from '@shared/finhub/noisysource/events';
import type { PlannedItem } from '@shared/finhub/noisysource/plan';
import { toMatchItem, type LineStatus } from '@shared/finhub/noisysource/reconcile';
import type { MovementState } from '@shared/finhub/noisysource/state';
import { appendNsEvents, reverseNsEvent, type NewEvent } from './eventStore';

/** Ids already used, plus the ones handed out in this batch. */
function idAllocator(taken: ReadonlySet<string>) {
  const used = new Set(taken);
  return (base: string) => {
    const id = nextFreeId(base, used);
    used.add(id);
    return id;
  };
}

export function matchEvent(alloc: (base: string) => string, m: MovementState, items: PlannedItem[], basis: string): NewEvent<'bank.movement.matched'> {
  return {
    type: 'bank.movement.matched',
    id: alloc(nsIds.match(m.id)),
    effectiveDate: m.date,
    payload: { movementId: m.id, items: items.map(toMatchItem), basis },
  };
}

export function classifyEvent(alloc: (base: string) => string, m: MovementState, category: string, description: string): NewEvent<'bank.movement.classified'> {
  return {
    type: 'bank.movement.classified',
    id: alloc(nsIds.classified(m.id)),
    effectiveDate: m.date,
    payload: { movementId: m.id, category, vatCode: 'por_confirmar', description: description.trim() || category },
  };
}

/** Confirms suggestions as they are (matches and classifications). */
export async function confirmLines(lines: LineStatus[], items: Map<string, { item: PlannedItem }>, taken: ReadonlySet<string>): Promise<number> {
  const alloc = idAllocator(taken);
  const events: NewEvent[] = [];
  for (const l of lines) {
    if (l.state === 'sugerido') {
      events.push(matchEvent(alloc, l.movement, l.itemIds.map(id => items.get(id)!.item), `sugestão confirmada: ${l.basis ?? ''}`.trim()));
    } else if (l.state === 'classificacao-sugerida' && l.category) {
      events.push(classifyEvent(alloc, l.movement, l.category, l.description ?? l.movement.description));
    }
  }
  for (let k = 0; k < events.length; k += 400) await appendNsEvents(events.slice(k, k + 400));
  return events.length;
}

export async function matchByHand(m: MovementState, items: PlannedItem[], taken: ReadonlySet<string>): Promise<void> {
  await appendNsEvents([matchEvent(idAllocator(taken), m, items, 'escolhido à mão')]);
}

export async function classify(m: MovementState, category: string, description: string, taken: ReadonlySet<string>): Promise<void> {
  await appendNsEvents([classifyEvent(idAllocator(taken), m, category, description)]);
}

export async function explainItem(item: PlannedItem, reason: string, taken: ReadonlySet<string>): Promise<void> {
  await appendNsEvents([{
    type: 'plan.item.explained',
    id: idAllocator(taken)(nsIds.explained(item.id)),
    payload: { itemId: item.id, month: item.month, reason: reason.trim() },
  }]);
}

export async function undo(eventId: string, taken: ReadonlySet<string>): Promise<void> {
  await reverseNsEvent(eventId, taken, 'desfeito no ecrã Mês');
}
