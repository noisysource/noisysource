import type { ParsedBpiStatement, ParsedBpiTransaction } from './bpiXlsx';
import { bpiTxId } from './bpiXlsx';

// BPI monthly "EXTRACTO DE CONTA" (PDF). Two parts:
//   1. pdfjs → positioned text items (extractPdfTextItems), the only part that needs pdfjs;
//   2. pure functions: items → text lines (groupTextLines) → statement (parseBpiPdfLines).
// Every movement is checked against the running balance (SALDO ANTERIOR → each SALDO →
// SALDO ACTUAL CONTABILISTICO); any mismatch refuses the whole statement.

export interface PdfTextItem {
  page: number;   // 1-based
  x: number;      // left edge, PDF points
  y: number;      // baseline, PDF points (grows upwards)
  width: number;
  text: string;
}

export interface PdfTextLine {
  page: number;
  y: number;
  cells: { x: number; width: number; text: string }[]; // left to right
}

// Thrown for anything that makes the statement unsafe to import. The message is shown as is.
export class BpiPdfError extends Error {}

// ── Part 1: pdfjs ─────────────────────────────────────────────────────────────

type PdfJs = Pick<typeof import('pdfjs-dist'), 'getDocument'>;

export async function extractPdfTextItems(data: ArrayBuffer | Uint8Array, pdfjs: PdfJs): Promise<PdfTextItem[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  try {
    const items: PdfTextItem[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      for (const it of content.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        items.push({ page, x: it.transform[4], y: it.transform[5], width: it.width, text: it.str });
      }
    }
    return items;
  } finally {
    await doc.destroy();
  }
}

// Loaded on demand: pdfjs is large and only the statement import needs it. The legacy build
// supports older browsers, and it's the build the real-statement test runs in Node.
async function loadPdfJs(): Promise<PdfJs> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

export async function parseBpiPdf(buffer: ArrayBuffer): Promise<ParsedBpiStatement> {
  let items: PdfTextItem[];
  try {
    items = await extractPdfTextItems(buffer, await loadPdfJs());
  } catch {
    throw new BpiPdfError('Não foi possível ler o PDF.');
  }
  return parseBpiPdfLines(groupTextLines(items));
}

// PDF ids also carry the running balance (handoff §5.8): two identical movements on the same
// day (same amount and text) would otherwise collapse into one. XLSX ids are unchanged.
export function bpiPdfTxId(accountId: string, tx: ParsedBpiTransaction): string {
  const bal = tx.balanceCents >= 0 ? `p${tx.balanceCents}` : `n${-tx.balanceCents}`;
  return `${bpiTxId(accountId, tx)}_${bal}`;
}

// ── Part 2: pure ──────────────────────────────────────────────────────────────

// Items of one row sit within ~0.2pt of each other; rows are ~11.8pt apart. The closest
// unrelated lines in the header block are ~2.6pt apart.
const SAME_LINE_TOLERANCE = 2;

export function groupTextLines(items: PdfTextItem[]): PdfTextLine[] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: PdfTextLine[] = [];
  let current: PdfTextLine | null = null;
  for (const it of sorted) {
    if (!current || current.page !== it.page || current.y - it.y > SAME_LINE_TOLERANCE) {
      current = { page: it.page, y: it.y, cells: [] };
      lines.push(current);
    }
    current.cells.push({ x: it.x, width: it.width, text: it.text.trim() });
  }
  for (const line of lines) line.cells.sort((a, b) => a.x - b.x);
  return lines;
}

// "1 234,56" / "-1 000,00" / "-0,07" → cents. Whole cell only, so descriptions never match.
const PT_AMOUNT = /^(-?)(\d{1,3}(?:[ .  ]\d{3})*),(\d{2})$/;

export function parsePtAmountCents(text: string): number | null {
  const m = text.trim().match(PT_AMOUNT);
  if (!m) return null;
  const cents = Number(m[2].replace(/\D/g, '')) * 100 + Number(m[3]);
  return m[1] ? -cents : cents;
}

const DAY_MONTH = /^(\d{2})\/(\d{2})$/;

interface Columns {
  movX: number;        // DATA MOV
  valX: number;        // DATA VAL
  descX: number;       // DESCRIÇÃO DO MOVIMENTO
  valorRight: number;  // VALOR (right-aligned)
  saldoRight: number;  // SALDO (right-aligned)
}

interface Row {
  mov?: string;        // dd/mm
  val?: string;        // dd/mm
  desc: string;
  valor?: number;      // cents
  saldo?: number;      // cents
  stray: string[];     // text left of the description that isn't a date (footers)
}

function findColumns(line: PdfTextLine): Columns | null {
  const desc = line.cells.find(c => c.text.startsWith('DESCRIÇÃO DO MOVIMENTO'));
  if (!desc) return null;
  const dates = line.cells.filter(c => c.text === 'DATA');
  const valor = line.cells.find(c => c.text === 'VALOR');
  const saldo = line.cells.find(c => c.text === 'SALDO');
  if (dates.length !== 2 || !valor || !saldo) {
    throw new BpiPdfError('Cabeçalho da tabela de movimentos não reconhecido.');
  }
  return {
    movX: dates[0].x,
    valX: dates[1].x,
    descX: desc.x,
    valorRight: valor.x + valor.width,
    saldoRight: saldo.x + saldo.width,
  };
}

function readRow(line: PdfTextLine, cols: Columns): Row {
  const row: Row = { desc: '', stray: [] };
  const desc: string[] = [];
  for (const c of line.cells) {
    // VALOR and SALDO are right-aligned under their headers.
    const amount = parsePtAmountCents(c.text);
    const right = c.x + c.width;
    const toSaldo = Math.abs(right - cols.saldoRight);
    const toValor = Math.abs(right - cols.valorRight);
    if (amount !== null && Math.min(toSaldo, toValor) < 15) {
      if (toSaldo < toValor) row.saldo = amount;
      else row.valor = amount;
    } else if (c.x < cols.descX - 5) {
      const isMov = Math.abs(c.x - cols.movX) < Math.abs(c.x - cols.valX);
      if (!DAY_MONTH.test(c.text)) row.stray.push(c.text);
      else if (isMov) row.mov = c.text;
      else row.val = c.text;
    } else {
      desc.push(c.text);
    }
  }
  row.desc = desc.join(' ').replace(/\s+/g, ' ').trim();
  return row;
}

// yyyy-mm-dd, or null if the day doesn't exist (31/09, 29/02 in a common year…).
function iso(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Lines carry dd/mm only. Pick the year that puts the date nearest the statement period,
// so a December → January statement, or a value date just before the period, gets it right.
function withYear(dayMonth: string, from: string, to: string, where: string): string {
  const [, dd, mm] = dayMonth.match(DAY_MONTH)!;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  let best: string | null = null;
  let bestDistance = Infinity;
  for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)) + 1; y++) {
    const candidate = iso(y, Number(mm), Number(dd));
    if (!candidate) continue;
    const ms = Date.parse(candidate);
    const distance = ms < fromMs ? fromMs - ms : ms > toMs ? ms - toMs : 0;
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  if (!best) throw new BpiPdfError(`Data inválida ${dayMonth} (${where}).`);
  return best;
}

function findPeriod(lines: PdfTextLine[]): { from: string; to: string } {
  for (const line of lines) {
    const m = line.cells.map(c => c.text).join(' ')
      .match(/De (\d{2})\/(\d{2})\/(\d{4}) a (\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) continue;
    const from = iso(Number(m[3]), Number(m[2]), Number(m[1]));
    const to = iso(Number(m[6]), Number(m[5]), Number(m[4]));
    if (!from || !to || from > to) throw new BpiPdfError(`Período do extrato inválido: ${m[0]}.`);
    return { from, to };
  }
  throw new BpiPdfError('Período do extrato não encontrado. É um extrato BPI em PDF?');
}

// "Conta  0-0000000-000-001  <HOLDER NAME>" on one line of the address block.
function findAccount(lines: PdfTextLine[]): { accountNumber: string; holderName: string } {
  for (const line of lines) {
    if (line.cells[0]?.text !== 'Conta') continue;
    const i = line.cells.findIndex(c => /^\d[\d-]*\d$/.test(c.text));
    if (i < 0) continue;
    return { accountNumber: line.cells[i].text, holderName: line.cells[i + 1]?.text ?? '' };
  }
  return { accountNumber: '', holderName: '' };
}

const fmt = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const NO_CLOSING = 'Saldo final (SALDO ACTUAL CONTABILISTICO) não encontrado no extrato.';

export function parseBpiPdfLines(lines: PdfTextLine[]): ParsedBpiStatement {
  const period = findPeriod(lines);
  const { accountNumber, holderName } = findAccount(lines);

  const transactions: ParsedBpiTransaction[] = [];
  let cols: Columns | null = null;
  let page = 0;
  let openingBalanceCents: number | null = null;
  let closingBalanceCents: number | null = null;
  let running = 0;
  let lastMov: string | null = null;

  for (const line of lines) {
    // Every page repeats the column header; nothing above it is a movement.
    if (line.page !== page) { page = line.page; cols = null; }
    const header = findColumns(line);
    if (header) { cols = header; continue; }
    if (!cols) continue;

    const row = readRow(line, cols);

    if (/^SALDO ANTERIOR\b/.test(row.desc)) {
      if (openingBalanceCents !== null) {
        throw new BpiPdfError('O extrato tem mais do que uma conta. Só é suportada uma conta por extrato.');
      }
      if (row.saldo === undefined) throw new BpiPdfError('Saldo anterior sem valor.');
      openingBalanceCents = running = row.saldo;
      continue;
    }
    if (openingBalanceCents === null || closingBalanceCents !== null) continue;

    if (/^SALDO ACTUAL\b/.test(row.desc)) {
      if (!/^SALDO ACTUAL CONTABIL/.test(row.desc)) throw new BpiPdfError(NO_CLOSING);
      if (row.saldo === undefined) throw new BpiPdfError('Saldo final sem valor.');
      if (row.saldo !== running) {
        throw new BpiPdfError(
          `O saldo final do extrato (${fmt(row.saldo)}) não bate com a soma dos movimentos (${fmt(running)}).`,
        );
      }
      closingBalanceCents = row.saldo;
      continue;
    }

    // Footers, legal text and repeated header labels have no amounts and no dates.
    if (row.valor === undefined && row.saldo === undefined && !row.mov && !row.val) continue;

    const where = `página ${line.page}, "${row.desc || '(sem descrição)'}"`;
    if (row.valor === undefined || row.saldo === undefined || !row.val || !row.desc || row.stray.length) {
      throw new BpiPdfError(`Linha não reconhecida (${where}).`);
    }
    const mov: string | null = row.mov ?? lastMov; // a blank DATA MOV means the date of the line above
    if (!mov) throw new BpiPdfError(`Primeiro movimento sem data (${where}).`);
    lastMov = mov;

    const date = withYear(mov, period.from, period.to, where);
    if (date < period.from || date > period.to) {
      throw new BpiPdfError(`Data ${mov} fora do período do extrato (${where}).`);
    }
    const expected = running + row.valor;
    if (expected !== row.saldo) {
      throw new BpiPdfError(
        `Saldo não bate em ${mov} (${where}): ${fmt(running)} ${row.valor < 0 ? '−' : '+'} ` +
        `${fmt(Math.abs(row.valor))} = ${fmt(expected)}, mas o extrato diz ${fmt(row.saldo)}. Importação recusada.`,
      );
    }
    running = expected;
    transactions.push({
      date,
      valueDate: withYear(row.val, period.from, period.to, where),
      description: row.desc,
      amountCents: row.valor,
      balanceCents: row.saldo,
    });
  }

  if (openingBalanceCents === null) throw new BpiPdfError('Saldo anterior não encontrado no extrato.');
  if (closingBalanceCents === null) throw new BpiPdfError(NO_CLOSING);

  // Oldest first, as printed. dateFrom/dateTo are the statement period: the closing balance
  // is as of its last day, even when the last movement is earlier.
  return {
    accountNumber,
    holderName,
    openingBalanceCents,
    closingBalanceCents,
    transactions,
    dateFrom: period.from,
    dateTo: period.to,
  };
}
