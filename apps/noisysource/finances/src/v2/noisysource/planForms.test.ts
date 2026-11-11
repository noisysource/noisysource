import { describe, expect, it, vi } from 'vitest';
import { centsInput, parseCents, parseNumber } from './format';

vi.mock('../../lib/firebase', () => ({ auth: {}, db: {} }));

describe('numbers typed in a form', () => {
  it('reads the Portuguese way and with a point', () => {
    expect(parseCents('123,45')).toBe(12345);
    expect(parseCents('1 234,56 €')).toBe(123456);
    expect(parseCents('1.234,56')).toBe(123456);
    expect(parseCents('12.5')).toBe(1250);
    expect(parseNumber('1,375')).toBe(1.375);
    expect(parseNumber('23,75%')).toBe(23.75);
    expect(parseCents(centsInput(12345))).toBe(12345);
  });

  it('refuses what it can\'t read instead of guessing', () => {
    expect(() => parseCents('abc')).toThrow('Número inválido');
    expect(() => parseCents('')).toThrow('Número inválido');
    expect(() => parseCents('1,2,3')).toThrow('Número inválido');
  });
});

describe('dates typed in a form', () => {
  it('reads ISO, dd/mm/yyyy and dd/mm with the form\'s year', async () => {
    const { parseDates } = await import('./planForms');
    expect(parseDates('2027-04-02, 3/8/2027\n1/5', 2027)).toEqual(['2027-04-02', '2027-08-03', '2027-05-01']);
    expect(() => parseDates('amanhã', 2027)).toThrow('Data inválida');
    expect(() => parseDates('1/5')).toThrow('Data inválida');
  });
});
