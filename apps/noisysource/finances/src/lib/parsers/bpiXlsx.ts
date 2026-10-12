import * as XLSX from 'xlsx';

export interface ParsedBpiTransaction {
  date: string;        // YYYY-MM-DD
  valueDate: string;   // YYYY-MM-DD
  description: string;
  amountCents: number; // signed
  balanceCents: number;
}

export interface ParsedBpiStatement {
  accountNumber: string;
  holderName: string;
  openingBalanceCents?: number; // PDF only (SALDO ANTERIOR)
  closingBalanceCents: number;
  transactions: ParsedBpiTransaction[];
  dateFrom: string;  // YYYY-MM-DD (oldest)
  dateTo: string;    // YYYY-MM-DD (newest)
}

// Portuguese number format: "1.234,56" → 123456 cents
function parsePtCents(raw: string | number): number {
  if (typeof raw === 'number') return Math.round(raw * 100);
  const clean = String(raw).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

// BPI dates: "DD-MM-YYYY" string or Excel serial number
function parsePtDate(raw: string | number): string {
  if (typeof raw === 'number') {
    const d = XLSX.SSF.parse_date_code(raw);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(raw).trim();
  // Try DD-MM-YYYY or DD/MM/YYYY
  const m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s;
}

function cellStr(row: any[], col: number): string {
  return row[col] != null ? String(row[col]).trim() : '';
}

export function parseBpiXlsx(buffer: ArrayBuffer): ParsedBpiStatement {
  const workbook = XLSX.read(buffer, { type: 'array', cellText: true, cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // Convert to array of rows (with raw values)
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
  }) as any[][];

  // Extract metadata from early rows
  let accountNumber = '';
  let holderName = '';
  let closingBalanceCents = 0;

  for (let i = 0; i < Math.min(16, rows.length); i++) {
    const row = rows[i];
    const joined = row.map(String).join(' ');
    // Account number: "5-6055211.000.001" style or row label
    if (/conta[:\s]/i.test(joined)) {
      const match = joined.match(/\d[\d\-\.]+\d{3}/);
      if (match) accountNumber = match[0];
    }
    // Holder name: a row with all-caps company name
    if (!holderName && /^[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÇ\s\-,\.]{5,}$/.test(String(row[1] ?? '').trim())) {
      const candidate = String(row[1] ?? '').trim();
      if (candidate.length > 4 && !/^\d/.test(candidate)) holderName = candidate;
    }
    // Closing balance: row labelled "Saldo" or similar
    if (/saldo/i.test(joined) && !joined.includes('Saldo em EUR')) {
      const numCols = row.filter(c => typeof c === 'number' || /[\d,]/.test(String(c)));
      if (numCols.length > 0) {
        const last = numCols[numCols.length - 1];
        closingBalanceCents = parsePtCents(last);
      }
    }
  }

  // Row 17 (index 16) = headers, row 18+ = data
  const transactions: ParsedBpiTransaction[] = [];
  const dataStartIdx = 17;

  for (let i = dataStartIdx; i < rows.length; i++) {
    const row = rows[i];
    // Skip empty or separator rows
    if (!row || row.every(c => c === '' || c == null)) continue;
    const dateRaw = row[0];
    if (!dateRaw) continue;

    const date = parsePtDate(dateRaw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skip non-data rows

    const valueDate = parsePtDate(row[1] || row[0]);
    const description = cellStr(row, 2);
    const amountCents = parsePtCents(row[3]);
    const balanceCents = parsePtCents(row[4]);

    if (!description) continue;

    transactions.push({ date, valueDate, description, amountCents, balanceCents });
  }

  // Transactions are newest-first in BPI — reverse to oldest-first for dateFrom/dateTo
  const sortedDates = transactions.map(t => t.date).sort();
  const dateFrom = sortedDates[0] ?? '';
  const dateTo = sortedDates[sortedDates.length - 1] ?? '';

  // Use last balance row if not found in header
  if (!closingBalanceCents && transactions.length > 0) {
    // newest-first: first transaction has the most recent balance
    closingBalanceCents = transactions[0].balanceCents;
  }

  return { accountNumber, holderName, closingBalanceCents, transactions, dateFrom, dateTo };
}

// Deterministic dedup ID for a transaction
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
  return (h >>> 0) & 0xffffff;
}

export function bpiTxId(accountId: string, tx: ParsedBpiTransaction): string {
  const descHash = djb2(tx.description).toString(16).padStart(6, '0');
  const sign = tx.amountCents >= 0 ? 'p' : 'n';
  return `${accountId}_${tx.date.replace(/-/g, '')}_${sign}${Math.abs(tx.amountCents)}_${descHash}`;
}
