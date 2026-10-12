import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPdfTextItems, groupTextLines, parseBpiPdfLines } from './bpiPdf';

// Runs the whole pipeline, pdfjs included, on a real statement kept outside the repo:
//   BPI_PDF=~/dev/noisysource/prodata/Extrato_Conta_2026-09-30.pdf pnpm --filter finances test
// Skipped otherwise. Prints counts only, never names.
const file = process.env.BPI_PDF;

describe.skipIf(!file)('real BPI PDF statement (BPI_PDF)', () => {
  it('parses with every balance matching', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const items = await extractPdfTextItems(readFileSync(file!), pdfjs);
    const stmt = parseBpiPdfLines(groupTextLines(items)); // throws on any balance mismatch

    const credits = stmt.transactions.filter(t => t.amountCents > 0);
    const sum = stmt.transactions.reduce((s, t) => s + t.amountCents, 0);
    expect(stmt.openingBalanceCents! + sum).toBe(stmt.closingBalanceCents);
    console.log(
      `${stmt.dateFrom} → ${stmt.dateTo}: ${stmt.transactions.length} movements ` +
      `(${credits.length} credits, ${stmt.transactions.length - credits.length} debits), all balances match`,
    );
  });
});
