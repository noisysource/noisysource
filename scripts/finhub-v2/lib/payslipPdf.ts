// Reads NoisySource's payslips ("RECIBO DE REMUNERAÇÕES", Filosoft SIGEP, one page per worker
// with an Original and a Duplicado copy) into payslip lines. Pure: takes the text lines that
// bpiPdf.ts's groupTextLines builds from pdfjs. Unknown line codes stop the import.

import { parsePtAmountCents, type PdfTextLine } from '../../../apps/noisysource/finances/src/lib/parsers/bpiPdf';
import type { PayslipLine } from '../../../packages/shared/finhub/noisysource/events';

export interface ParsedPayslip {
  page: number;
  employeeNo: string;
  /** Document date, YYYY-MM-DD. */
  date: string;
  month: string;
  baseMonthlyCents: number;
  lines: PayslipLine[];
  irsRatePct: number;
  irsBaseCents: number;
  irsCents: number;
  ssRatePct: number;
  ssCents: number;
  totalIliquidoCents: number;
  netCents: number;
}

const euro = (s: string) => {
  const v = parsePtAmountCents(s.replace(/€/g, '').trim());
  if (v == null) throw new Error(`not an amount: "${s}"`);
  return v;
};
const num = (s: string) => Number(s.replace(/D$/, '').replace(/\./g, '').replace(',', '.'));
const pct = (s: string) => Number(s.replace('%', '').replace(',', '.'));

/** Offsets that cancel a voucher line (the card is loaded, not paid in cash). */
const OFFSET_CODES = new Set(['649', '650', '662']);

export function parsePayslipLines(all: PdfTextLine[]): ParsedPayslip[] {
  const pages = [...new Set(all.map(l => l.page))];
  return pages.map(page => parsePage(page, all.filter(l => l.page === page)));
}

function parsePage(page: number, lines: PdfTextLine[]): ParsedPayslip {
  const rows: string[][] = [];
  for (const l of lines) {
    const cells = l.cells.map(c => c.text.trim()).filter(Boolean);
    if (cells.includes('Duplicado')) break; // only the Original copy
    rows.push(cells);
  }
  const out: Partial<ParsedPayslip> & { lines: PayslipLine[] } = { page, lines: [] };
  let inDescontos = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const head = r[0];
    const empNo = r.find(c => /^\d{5}$/.test(c));
    if (empNo && !out.employeeNo) out.employeeNo = empNo;
    const date = r.join(' ').match(/(\d{2})[-/](\d{2})[-/](\d{4})/); // 30-06-2026 or 31/01/2026
    if (r[0].startsWith('NIF:') && date) {
      out.date = `${date[3]}-${date[2]}-${date[1]}`;
      out.month = `${date[3]}-${date[2]}`;
    }
    if (head === 'Salário' && r.includes('Base:')) out.baseMonthlyCents = euro(r[r.length - 1]);
    if (head === 'DESCONTOS') inDescontos = true;
    if (head === 'Total Ilíquido:') out.totalIliquidoCents = euro(r[r.length - 1]);
    if (head === 'Líquido a receber:') {
      // Same row ("Líquido a receber: | € 1,00") or alone on the next one, depending on the layout.
      const cell = r.length > 1 ? r[1] : rows[i + 1]?.length === 1 ? rows[i + 1][0] : undefined;
      if (!cell) throw new Error(`page ${page}: net pay not found`);
      out.netCents = euro(cell);
    }

    const m = head.match(/^(\d{3}) (.+)$/);
    if (!m) continue;
    const [, code, label] = m;
    const rest = r.slice(1);
    if (inDescontos) {
      // A subsidy month has a second IRS line (withheld separately on the subsidy): add them up.
      if (/Imposto/.test(label)) {
        out.irsRatePct ??= pct(rest[0]);
        out.irsBaseCents = (out.irsBaseCents ?? 0) + euro(rest[1]);
        out.irsCents = (out.irsCents ?? 0) + euro(rest[2]);
      } else if (/Segurança Social/.test(label)) {
        out.ssRatePct ??= pct(rest[0]);
        out.ssCents = (out.ssCents ?? 0) + euro(rest[2]);
      } else {
        throw new Error(`page ${page}: unknown deduction ${code} ${label}`);
      }
      continue;
    }
    if (OFFSET_CODES.has(code)) continue;
    const amount = () => euro(rest[rest.length - 1]);
    if (code === '001' && /Vencimento/.test(label)) {
      out.lines.push({ code, label, kind: 'base', amountCents: out.baseMonthlyCents ?? NaN });
    } else if (/Subs[ií]dio F[ée]rias/i.test(label)) {
      out.lines.push({ code, label, kind: 'subsidio-ferias', amountCents: amount(), quantity: num(rest[0]) });
    } else if (/Natal/i.test(label)) {
      out.lines.push({ code, label, kind: 'subsidio-natal', amountCents: amount(), quantity: num(rest[0]) });
    } else if (/Licen[çc]a/i.test(label)) {
      out.lines.push({ code, label, kind: 'licenca', amountCents: amount(), quantity: num(rest[0]) });
    } else if (/Ajudas de custo/i.test(label)) {
      out.lines.push({ code, label, kind: 'ajudas', amountCents: amount(), paidAs: 'conta' });
    } else if (/Aliment/i.test(label)) {
      out.lines.push({ code, label, kind: 'refeicao', amountCents: amount(), quantity: num(rest[0]), unitCents: euro(rest[1]), paidAs: 'cartao' });
    } else if (/Vale (Inf[âa]ncia|Educa[çc][ãa]o)/i.test(label)) {
      out.lines.push({ code, label, kind: 'beneficio', amountCents: amount(), paidAs: 'cartao' });
    } else {
      throw new Error(`page ${page}: unknown line ${code} ${label}`);
    }
  }
  for (const k of ['employeeNo', 'date', 'baseMonthlyCents', 'totalIliquidoCents', 'netCents'] as const) {
    if (out[k] == null) throw new Error(`page ${page}: ${k} not found`);
  }
  // No IRS/SS lines at all when the month pays nothing (e.g. a whole month of leave).
  out.irsRatePct ??= 0;
  out.irsBaseCents ??= 0;
  out.irsCents ??= 0;
  out.ssRatePct ??= 0;
  out.ssCents ??= 0;
  return out as ParsedPayslip;
}
