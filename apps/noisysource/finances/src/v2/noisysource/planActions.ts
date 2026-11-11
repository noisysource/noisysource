// What the Plano screen writes. A change to a blueprint is a new event: the old version stays in
// the log, and the months ahead are recomputed from the latest one. Nothing generated is stored.

import { reversalId, REVERSAL } from '@shared/finhub/envelope';
import type { Blueprint } from '@shared/finhub/noisysource/blueprints';
import {
  nextFreeId, nsIds, type CalendarEntry, type CostPlan, type EcContractSigned, type EmploymentTerms,
  type IntercompanyPlan, type NsPayload, type PaymentRule,
} from '@shared/finhub/noisysource/events';
import { appendNsEvents, reverseNsEvent, type NewEvent } from './eventStore';

/** A new contract, or a correction of one: same number replaces it, so the old event is reversed. */
export async function saveContract(payload: EcContractSigned, replaces: string | null, taken: ReadonlySet<string>): Promise<void> {
  const events: NewEvent[] = [];
  if (replaces) {
    let n = 1;
    while (taken.has(reversalId(replaces, n))) n++;
    events.push({ type: REVERSAL, id: reversalId(replaces, n), payload: {}, reverses: replaces, note: 'corrigido no Plano', effectiveDate: payload.startDate });
  }
  events.push({ type: 'ec.contract.signed', id: nextFreeId(nsIds.ecContract(payload.number), taken), payload });
  await appendNsEvents(events);
}

export const endContract = (payload: NsPayload<'ec.contract.ended'>, taken: ReadonlySet<string>) =>
  appendNsEvents([{ type: 'ec.contract.ended', id: nextFreeId(nsIds.ecContractEnd(payload.number), taken), payload }]);

export const saveTerms = (payload: EmploymentTerms, taken: ReadonlySet<string>) =>
  appendNsEvents([{ type: 'employment.terms.set', id: nextFreeId(nsIds.terms(payload.personId, payload.from), taken), payload }]);

export const endEmployment = (payload: NsPayload<'employment.ended'>, taken: ReadonlySet<string>) =>
  appendNsEvents([{ type: 'employment.ended', id: nextFreeId(nsIds.employmentEnd(payload.personId), taken), payload }]);

export const saveCost = (payload: CostPlan, taken: ReadonlySet<string>) =>
  appendNsEvents([{ type: 'cost.plan.set', id: nextFreeId(nsIds.cost(payload.key, payload.from), taken), payload }]);

export const saveIntercompany = (payload: IntercompanyPlan, taken: ReadonlySet<string>) =>
  appendNsEvents([{ type: 'intercompany.plan.set', id: nextFreeId(nsIds.intercompany(payload.key, payload.from), taken), payload }]);

export const saveRule = (payload: PaymentRule, taken: ReadonlySet<string>) =>
  appendNsEvents([{ type: 'payment.rule.set', id: nextFreeId(nsIds.rule(payload.what, payload.from), taken), payload }]);

export const saveHolidays = (payload: NsPayload<'holidays.set'>, taken: ReadonlySet<string>) =>
  appendNsEvents([{ type: 'holidays.set', id: nextFreeId(nsIds.holidays(payload.calendarId, payload.year), taken), payload }]);

export const saveCalendarEntry = (payload: CalendarEntry, taken: ReadonlySet<string>) =>
  appendNsEvents([{ type: 'calendar.entry.set', id: nextFreeId(nsIds.calendar(payload.personId, payload.kind, [...payload.dates].sort()[0]), taken), payload }]);

/** Confirms blueprints as they stand: each confirmation names the versions it covers. */
export async function confirmBlueprints(list: Blueprint[], today: string, taken: ReadonlySet<string>): Promise<void> {
  const used = new Set(taken);
  const events: NewEvent[] = list.map(b => {
    const id = nextFreeId(nsIds.confirmed(b.id), used);
    used.add(id);
    return { type: 'plan.blueprint.confirmed', id, effectiveDate: today, payload: { blueprintId: b.id, eventIds: b.eventIds } };
  });
  for (let k = 0; k < events.length; k += 400) await appendNsEvents(events.slice(k, k + 400));
}

export const undoEvent = (eventId: string, taken: ReadonlySet<string>, note: string) => reverseNsEvent(eventId, taken, note);
