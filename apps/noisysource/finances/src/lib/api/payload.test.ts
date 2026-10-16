import { describe, expect, it } from 'vitest';
import { diffPayload, nullsToUndefinedDeep, stripUndefinedDeep } from './payload';

const ts = (iso: string) => ({ toDate: () => new Date(iso) }); // a Firestore Timestamp, as read back

describe('diffPayload — the seed import preview', () => {
  it('creates when nothing is stored', () => {
    expect(diffPayload(undefined, { name: 'Ana', active: true })).toEqual({ status: 'create', changed: ['name', 'active'] });
  });

  it('is unchanged when every payload field matches, whatever else the doc holds', () => {
    const stored = { name: 'Ana', active: true, createdAt: ts('2026-01-01T00:00:00Z'), balanceCents: 1234 };
    expect(diffPayload(stored, { name: 'Ana', active: true })).toEqual({ status: 'unchanged', changed: [] });
  });

  it('compares a Date with the Timestamp it was stored as, and objects regardless of key order', () => {
    const when = '2026-03-26T12:00:00.000Z';
    const stored = { startDate: ts(when), benefits: [{ type: 'MEAL', perDayCents: 600 }] };
    const payload = { startDate: new Date(when), benefits: [{ perDayCents: 600, type: 'MEAL' }] };
    expect(diffPayload(stored, payload).status).toBe('unchanged');
  });

  it('lists the fields that differ', () => {
    const stored = { name: 'Ana', irsRatePct: 10, nonWorkingDays: ['2026-01-01'] };
    const payload = { name: 'Ana', irsRatePct: 12, nonWorkingDays: ['2026-01-01', '2026-01-02'] };
    expect(diffPayload(stored, payload)).toEqual({ status: 'update', changed: ['irsRatePct', 'nonWorkingDays'] });
  });

  it('cleans payloads like the saves do: no undefined, nulls left out', () => {
    expect(stripUndefinedDeep(nullsToUndefinedDeep({ a: 1, b: null, c: undefined, d: [{ e: null, f: 2 }] })))
      .toEqual({ a: 1, d: [{ f: 2 }] });
  });
});
