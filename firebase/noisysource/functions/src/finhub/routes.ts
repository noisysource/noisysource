// FinHub's backend routes: the Express server of the Strata Treasury app
// (AI Studio, 2026-11-23), kept route by route so the app behaves the same.
// What changed: no Express (api.ts calls these through the `finhubApi`
// callable, after checking the caller), Gemini through Vertex AI as the
// functions' own service account (no API key anywhere), the models from
// params, and every Gemini call counted against a daily cap (usage.ts).
import { GoogleGenAI, Type } from '@google/genai';
import { geminiLocation, geminiModel, geminiFallbackModel } from './params';
import { countAiCall } from './usage';

// Minimal request/response the route handlers were written against.
export interface Request {
  body: unknown;
  headers: { authorization?: string };
}
export interface Response {
  status(code: number): Response;
  json(body: unknown): void;
}
export type Route = (req: Request, res: Response) => Promise<void> | void;

let aiClient: GoogleGenAI | undefined;
function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error('No Google Cloud project in the environment.');
    aiClient = new GoogleGenAI({ vertexai: true, project, location: geminiLocation.value() });
  }
  return aiClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientGeminiError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  return (
    status === 503 ||
    status === 429 ||
    status === 502 ||
    status === 504 ||
    raw.includes('503') ||
    raw.includes('UNAVAILABLE') ||
    raw.includes('high demand') ||
    raw.includes('overloaded') ||
    raw.includes('429') ||
    raw.includes('RESOURCE_EXHAUSTED') ||
    raw.includes('ECONNRESET') ||
    raw.includes('ETIMEDOUT')
  );
}

async function generateContentWithFallback(
  ai: GoogleGenAI,
  request: Omit<Parameters<GoogleGenAI['models']['generateContent']>[0], 'model'>
) {
  const models = [geminiModel.value(), geminiFallbackModel.value()].filter((m, i, all) => m && all.indexOf(m) === i);
  let lastError: unknown;

  for (let mIdx = 0; mIdx < models.length; mIdx++) {
    const model = models[mIdx];
    const attempts = mIdx === 0 ? 2 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      // Before every attempt, retries included: a cap that only counted
      // requests would let a retry loop spend past it.
      await countAiCall();
      try {
        return await ai.models.generateContent({
          ...request,
          model,
        });
      } catch (err) {
        lastError = err;
        if (!isTransientGeminiError(err)) {
          throw err;
        }
        const delayMs = 800 + attempt * 1100;
        console.warn(
          `[Gemini] Transient error on ${model} (attempt ${attempt + 1}/${attempts}); ${
            attempt + 1 < attempts ? `retrying in ${delayMs}ms` : mIdx + 1 < models.length ? 'switching to fallback model' : 'no retries left'
          }.`
        );
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

function formatGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('GEMINI_API_KEY is not configured')) {
    return {
      status: 500,
      message: 'Server Gemini API key is missing. Configure GEMINI_API_KEY in Settings > Secrets.',
    };
  }
  if (raw.includes('PERMISSION_DENIED') || raw.includes('API_KEY_INVALID') || raw.includes('403') || raw.includes('400')) {
    return {
      status: 400,
      message: `Gemini API rejected the request: ${raw}. Verify your API key in Settings > Secrets.`,
    };
  }
  if (raw.includes('503') || raw.includes('UNAVAILABLE') || raw.includes('high demand') || raw.includes('overloaded')) {
    return {
      status: 503,
      message: 'AI extraction models are temporarily experiencing high demand. Please wait a few seconds and retry.',
    };
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429')) {
    return {
      status: 429,
      message: 'Gemini API rate limit or quota reached. Wait a moment and retry.',
    };
  }
  return {
    status: 500,
    message: raw || 'Unexpected error while calling Gemini extraction service.',
  };
}

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

function base64UrlToStandard(b64url: string): string {
  const normalized = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return normalized + '='.repeat(padLen);
}

interface ParseDocumentBody {
  filename?: string;
  mimeType?: string;
  base64Data?: string;
  textContent?: string;
  entityNames?: string[];
}

interface ReconcileSuggestBody {
  statementLines?: Array<{
    id: string;
    date: string;
    description: string;
    amount: number;
    direction: 'credit' | 'debit';
  }>;
  transactions?: Array<{
    id: string;
    date: string;
    description: string;
    amount: number;
    type: string;
    category: string;
  }>;
}

interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

function collectAttachments(
  part: GmailPart | undefined,
  out: Array<{ attachmentId: string; filename: string; mimeType: string; size: number }> = []
) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) {
    const lower = part.filename.toLowerCase();
    const mime = (part.mimeType || '').toLowerCase();
    const supported =
      mime.includes('pdf') ||
      mime.startsWith('image/') ||
      mime.includes('csv') ||
      lower.endsWith('.pdf') ||
      lower.endsWith('.png') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.csv');
    if (supported) {
      out.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType || (lower.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
        size: Number(part.body.size) || 0,
      });
    }
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      collectAttachments(child, out);
    }
  }
  return out;
}

async function extractInvoiceWithGemini(opts: {
  filename: string;
  mimeType: string;
  base64Data?: string;
  textContent?: string;
  entityNames?: string[];
}) {
  const ai = getAiClient();
  const entityHintPrompt =
    opts.entityNames && opts.entityNames.length > 0
      ? `Known entities in workspace: ${opts.entityNames.join(', ')}. Match entityHint to the closest entity name if the buyer/recipient matches one of them, otherwise return empty string.`
      : '';

  const promptText = `Extract structured Portuguese/international invoice (fatura / recibo) accounting data from this document (${opts.filename}).
Rules:
- Return positive gross total amount including tax in amount.
- Format date strictly as YYYY-MM-DD (use invoice issue date).
- For Portuguese invoices: detect IVA rate (23, 13, 6, or 0) and exact ivaAmount. If multiple rates appear, sum ivaAmount and return the dominant rate.
- Set ivaDeductible to true for normal business B2B invoices with Portuguese VAT/IVA, false for personal receipts or 0% VAT.
- Extract vendor (supplier name), vendorNif (tax ID / NIF / NIPC / VAT number if visible), invoiceNumber (e.g. FT 2025/104), category (concise accounting category), and description (short summary max 120 chars).
${entityHintPrompt}`;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  if (opts.base64Data) {
    parts.push({
      inlineData: {
        mimeType: opts.mimeType,
        data: opts.base64Data,
      },
    });
  }
  if (opts.textContent) {
    parts.push({
      text: `Invoice text content:\n${opts.textContent.slice(0, 60000)}`,
    });
  }
  parts.push({ text: promptText });

  const response = await generateContentWithFallback(ai, {
    contents: { parts },
    config: {
      systemInstruction:
        'You are a precision accounting invoice extraction engine for Portuguese and international invoices. Return clean structured JSON.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          vendor: { type: Type.STRING },
          vendorNif: { type: Type.STRING },
          invoiceNumber: { type: Type.STRING },
          date: { type: Type.STRING },
          amount: { type: Type.NUMBER },
          ivaRate: { type: Type.NUMBER },
          ivaAmount: { type: Type.NUMBER },
          ivaDeductible: { type: Type.BOOLEAN },
          category: { type: Type.STRING },
          description: { type: Type.STRING },
          entityHint: { type: Type.STRING },
          notes: { type: Type.STRING },
        },
        required: [
          'vendor',
          'vendorNif',
          'invoiceNumber',
          'date',
          'amount',
          'ivaRate',
          'ivaAmount',
          'ivaDeductible',
          'category',
          'description',
          'entityHint',
          'notes',
        ],
      },
    },
  });

  return JSON.parse((response.text ?? '{}').trim());
}

async function ensureDriveFolder(
  token: string,
  name: string,
  parentId?: string
): Promise<{ id: string; name: string }> {
  const safeName = name.replace(/'/g, "\\'").trim() || 'Strata Treasury';
  const parentClause = parentId ? `'${parentId}' in parents` : `'root' in parents`;
  const q = `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false and ${parentClause}`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
    q
  )}&fields=files(id,name)&pageSize=5`;

  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (searchRes.status === 401) {
    throw Object.assign(new Error('Google Drive authorization expired.'), { httpStatus: 401 });
  }
  if (!searchRes.ok) {
    const errText = await searchRes.text();
    throw new Error(`Drive folder lookup failed (${searchRes.status}): ${errText}`);
  }
  const searchJson = (await searchRes.json()) as { files?: Array<{ id: string; name: string }> };
  if (searchJson.files && searchJson.files.length > 0) {
    return searchJson.files[0];
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: name.trim() || 'Strata Treasury',
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Drive folder creation failed (${createRes.status}): ${errText}`);
  }
  return (await createRes.json()) as { id: string; name: string };
}

async function downloadDriveFilePayload(
  token: string,
  fileId: string,
  fallbackName = 'document.pdf',
  fallbackMime = 'application/pdf'
) {
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,parents`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (metaRes.status === 401) {
    throw Object.assign(new Error('Google Drive session expired. Please reconnect.'), { httpStatus: 401 });
  }
  const meta = metaRes.ok
    ? ((await metaRes.json()) as {
        id: string;
        name: string;
        mimeType: string;
        webViewLink?: string;
        parents?: string[];
      })
    : { id: fileId, name: fallbackName, mimeType: fallbackMime, webViewLink: '', parents: [] };

  const resolvedName = meta.name || fallbackName;
  const resolvedMime = meta.mimeType || fallbackMime;
  const isGoogleSheet = resolvedMime === 'application/vnd.google-apps.spreadsheet';

  const mediaUrl = isGoogleSheet
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/csv`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&alt=media`;

  const mediaRes = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (mediaRes.status === 401) {
    throw Object.assign(new Error('Google Drive session expired. Please reconnect.'), { httpStatus: 401 });
  }
  if (!mediaRes.ok) {
    const errText = await mediaRes.text();
    throw Object.assign(new Error(`Failed to download Drive file: ${errText}`), {
      httpStatus: mediaRes.status,
    });
  }

  const buf = Buffer.from(await mediaRes.arrayBuffer());
  const lower = resolvedName.toLowerCase();
  const isText =
    isGoogleSheet ||
    resolvedMime.includes('csv') ||
    resolvedMime.includes('text/plain') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.txt');

  return {
    meta: {
      ...meta,
      name: resolvedName,
      mimeType: isGoogleSheet ? 'text/csv' : resolvedMime,
    },
    isText,
    base64Data: isText ? undefined : buf.toString('base64'),
    textContent: isText ? buf.toString('utf8') : undefined,
  };
}

async function extractPayslipsWithGemini(opts: {
  filename: string;
  mimeType: string;
  base64Data?: string;
  textContent?: string;
}) {
  const ai = getAiClient();
  const promptText = `Extract structured payroll figures for EVERY distinct employee present in this payslip document (${opts.filename}), AND extract a deduplicated Employment Contract configuration per distinct worker.
Return exact numeric amounts (positive numbers, no currency symbols).
Rules for payslips (items):
- Many Portuguese payroll PDFs (such as Filosoft SIGEP) contain multiple employees across multiple pages, and print "Original" + "Duplicado" on the same page for the same employee — deduplicate so each employee appears ONCE per pay period.
- Include tax-exempt voucher allowances (such as Vale Infância / 989 Vale Infância or Cartão Refeição) in grossPay and netPay when they are compensated separately from bank cash (e.g., 950 base + 312.50 Vale Infância = 1262.50 grossPay; 671.50 bank net + 312.50 Vale Infância = 984.00 netPay), and note the cash vs voucher split in notes.
- If an employee is on 100% leave (e.g., Licença Paternidade with Total Ilíquido €0.00 and Líquido €0.00), return 0 for grossPay, netPay, employeeWithholdings, employerTaxes, and employerContributions.
- If employerTaxes (Portuguese TSU) are not printed on the slip and contributory salary incidence > 0, estimate 23.75% of contributory gross salary and mention it in notes; if incidence is 0, set 0.
- Format all dates strictly as YYYY-MM-DD. Set payDate to the last workable weekday of the payroll month and taxDueDate to the 20th of the following month.

Rules for suggestedContracts (one entry per distinct employee in this document):
- workerName: full employee name.
- roleTitle: job title/category printed on slip (e.g. "Gerente", "Administrativa", "Software Engineer").
- employerName: company name printed on payslip header if visible.
- isOwnerHint: true if role indicates Gerente, Sócio-Gerente, Administrador, or Owner; otherwise false.
- paySchedule: "12_months" if duodécimos are explicitly paid monthly, otherwise "14_months" (Portuguese standard).
- baseGrossMonthly: contracted monthly Vencimento Base (e.g. 2000 even if employee was on leave that month).
- irsRate: IRS withholding percentage (0-100) computed from IRS withheld / IRS incidence (or YTD withheld / YTD incidence if on leave).
- employeeSsRate: employee Social Security percentage (default 11 in Portugal).
- employerSsRate: employer TSU percentage (default 23.75 in Portugal).
- mealPaymentMethod: "card" if meal card/Cartão Refeição, "cash" if cash subsídio alimentação, else "none".
- mealAllowanceDaily: daily meal allowance in EUR if printed, else 0.
- childVoucherMonthly: monthly Vale Infância amount if present, else 0.
- otherBenefitName & otherBenefitMonthly: any other recurring allowance.`;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  if (opts.base64Data) {
    parts.push({
      inlineData: {
        mimeType: opts.mimeType,
        data: opts.base64Data,
      },
    });
  }
  if (opts.textContent) {
    parts.push({
      text: `Document text/CSV content:\n${opts.textContent.slice(0, 80000)}`,
    });
  }
  parts.push({ text: promptText });

  const payslipItemSchema = {
    type: Type.OBJECT,
    properties: {
      employeeName: { type: Type.STRING, description: 'Full name of employee or contractor' },
      periodStart: { type: Type.STRING, description: 'Pay period start date YYYY-MM-DD' },
      periodEnd: { type: Type.STRING, description: 'Pay period end date YYYY-MM-DD' },
      payDate: { type: Type.STRING, description: 'Disbursement pay date YYYY-MM-DD' },
      taxDueDate: { type: Type.STRING, description: 'Tax and statutory remittance due date YYYY-MM-DD' },
      grossPay: { type: Type.NUMBER, description: 'Gross earnings amount including vouchers' },
      netPay: { type: Type.NUMBER, description: 'Net take-home pay amount including vouchers' },
      employeeWithholdings: { type: Type.NUMBER, description: 'Employee IRS + SS tax withholdings' },
      employerTaxes: { type: Type.NUMBER, description: 'Employer payroll taxes (TSU 23.75%)' },
      employerContributions: { type: Type.NUMBER, description: 'Additional employer social/insurance contributions' },
      notes: { type: Type.STRING, description: 'Brief extraction note or cash vs voucher split' },
    },
    required: [
      'employeeName',
      'periodStart',
      'periodEnd',
      'payDate',
      'taxDueDate',
      'grossPay',
      'netPay',
      'employeeWithholdings',
      'employerTaxes',
      'employerContributions',
      'notes',
    ],
  };

  const contractSchema = {
    type: Type.OBJECT,
    properties: {
      workerName: { type: Type.STRING },
      roleTitle: { type: Type.STRING },
      employerName: { type: Type.STRING },
      isOwnerHint: { type: Type.BOOLEAN },
      paySchedule: { type: Type.STRING, description: '14_months or 12_months' },
      baseGrossMonthly: { type: Type.NUMBER },
      irsRate: { type: Type.NUMBER },
      employeeSsRate: { type: Type.NUMBER },
      employerSsRate: { type: Type.NUMBER },
      mealAllowanceDaily: { type: Type.NUMBER },
      mealPaymentMethod: { type: Type.STRING, description: 'card, cash, or none' },
      childVoucherMonthly: { type: Type.NUMBER },
      otherBenefitName: { type: Type.STRING },
      otherBenefitMonthly: { type: Type.NUMBER },
      notes: { type: Type.STRING },
    },
    required: [
      'workerName',
      'roleTitle',
      'employerName',
      'isOwnerHint',
      'paySchedule',
      'baseGrossMonthly',
      'irsRate',
      'employeeSsRate',
      'employerSsRate',
      'mealAllowanceDaily',
      'mealPaymentMethod',
      'childVoucherMonthly',
      'otherBenefitName',
      'otherBenefitMonthly',
      'notes',
    ],
  };

  const response = await generateContentWithFallback(ai, {
    contents: { parts },
    config: {
      systemInstruction:
        'You are a precision Portuguese and international payroll extraction engine. Return clean JSON with items (payslips) and suggestedContracts (employment contracts).',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          items: { type: Type.ARRAY, items: payslipItemSchema },
          suggestedContracts: { type: Type.ARRAY, items: contractSchema },
        },
        required: ['items', 'suggestedContracts'],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{"items":[],"suggestedContracts":[]}').trim()) as {
    items?: Array<Record<string, unknown>>;
    suggestedContracts?: Array<Record<string, unknown>>;
  };
  return {
    items: Array.isArray(parsed.items) ? parsed.items : [],
    suggestedContracts: Array.isArray(parsed.suggestedContracts) ? parsed.suggestedContracts : [],
  };
}

async function extractStatementWithGemini(opts: {
  filename: string;
  mimeType: string;
  base64Data?: string;
  textContent?: string;
}) {
  const ai = getAiClient();
  const promptText = `Extract all bank transaction line items from this bank statement (${opts.filename}).
Rules:
- Return positive numeric amounts for each line and set direction to "credit" for deposits/inflows or "debit" for withdrawals/payments/fees.
- Format every line date strictly as YYYY-MM-DD.
- Keep descriptions concise (max 180 chars) and clean.
- Extract statementPeriod (e.g. "Oct 2026" or "2026-10-01 to 2026-10-31"), openingBalance, and closingBalance if present (use 0 if unavailable).`;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  if (opts.base64Data) {
    parts.push({
      inlineData: {
        mimeType: opts.mimeType,
        data: opts.base64Data,
      },
    });
  }
  if (opts.textContent) {
    parts.push({
      text: `Statement text/CSV content:\n${opts.textContent.slice(0, 120000)}`,
    });
  }
  parts.push({ text: promptText });

  const response = await generateContentWithFallback(ai, {
    contents: { parts },
    config: {
      systemInstruction:
        'You are a bank statement normalization engine. Extract every transaction accurately without inventing entries.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          statementPeriod: { type: Type.STRING },
          openingBalance: { type: Type.NUMBER },
          closingBalance: { type: Type.NUMBER },
          lines: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                date: { type: Type.STRING, description: 'Transaction date YYYY-MM-DD' },
                description: { type: Type.STRING, description: 'Bank merchant or transfer description' },
                amount: { type: Type.NUMBER, description: 'Absolute positive transaction amount' },
                direction: { type: Type.STRING, description: 'Either credit or debit' },
              },
              required: ['date', 'description', 'amount', 'direction'],
            },
          },
        },
        required: ['statementPeriod', 'openingBalance', 'closingBalance', 'lines'],
      },
    },
  });

  return JSON.parse((response.text ?? '{}').trim()) as {
    statementPeriod?: string;
    openingBalance?: number;
    closingBalance?: number;
    lines?: Array<{ date: string; description: string; amount: number; direction: 'credit' | 'debit' }>;
  };
}

async function discoverPatternsFromLinesWithGemini(opts: {
  lines: Array<{ date: string; description: string; amount: number; direction: string }>;
  entityNames?: string[];
}) {
  const ai = getAiClient();
  const indexed = opts.lines.slice(0, 140).map((l, idx) => ({
    lineIndex: idx,
    date: l.date,
    description: l.description,
    amount: l.amount,
    direction: l.direction,
  }));

  const entityPrompt =
    opts.entityNames && opts.entityNames.length > 0
      ? `Workspace entities: ${opts.entityNames.join(', ')}.`
      : '';

  const promptText = `Analyze these bank statement lines and generate structured accounting records.
${entityPrompt}
Produce three clean lists:
1. suggestedSubscriptions: Deduplicated recurring subscriptions, SaaS tools (Google Workspace, AWS, Figma, Adobe, Microsoft, OpenAI, Netflix, Spotify), telecom/utilities (Vodafone, MEO, NOS, EDP, Águas), accounting, insurance, or memberships seen in direct debits (DD / Débito Direto / SEPA / Card Subscriptions) or repeated merchants.
   - billingDay: 1..31 from the charge date.
   - billingMonth: 1..12 (if annual, use charge month; if monthly, use 1).
   - frequency: "monthly" or "annual".
   - ivaRate: 23 (standard PT), 6, or 0 for SaaS/reverse-charge outside PT if apparent; ivaDeductible: true for business expenses, false for personal entertainment (Netflix/Spotify).
   - hasInvoice: true for B2B vendors/telecom/SaaS that issue invoices.
2. suggestedCreditFacilities: Any bank loan installments, mortgages, equipment leasing, financing, or recurring credit card auto-repayments (e.g. Prestação Empréstimo, Financiamento, Leasing, Crédito Habitação, Cartão Crédito).
   - facilityType: one of "term_loan", "credit_line", "credit_card", "mortgage", "equipment_loan".
3. suggestedTransactions: One categorized ledger entry for EVERY input line (preserving lineIndex 0..${indexed.length - 1}):
   - type: "income" for credits, "debt_payment" for loan/credit card repayments, "transfer" for internal transfers between own accounts, "payroll" for salary/TSU/AT payroll taxes, or "expense" for normal purchases/fees/subscriptions.
   - vendor: clean merchant name.
   - category: concise category (Software & Cloud, Telecom & Utilities, Bank Fees, Taxes & SS, Client Revenue, Groceries, Childcare & School, Hardware & Office, Debt Service, etc.).
   - ivaRate (0..23) and ivaDeductible boolean.

Input lines:
${JSON.stringify(indexed)}`;

  const response = await generateContentWithFallback(ai, {
    contents: promptText,
    config: {
      systemInstruction:
        'You are a precision treasury and Portuguese accounting classifier. Deduplicate subscriptions and credit facilities cleanly and classify every statement line.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          suggestedSubscriptions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                vendor: { type: Type.STRING },
                category: { type: Type.STRING },
                amount: { type: Type.NUMBER },
                frequency: { type: Type.STRING, description: 'monthly or annual' },
                billingDay: { type: Type.INTEGER },
                billingMonth: { type: Type.INTEGER },
                ivaRate: { type: Type.NUMBER },
                ivaDeductible: { type: Type.BOOLEAN },
                hasInvoice: { type: Type.BOOLEAN },
                matchCount: { type: Type.INTEGER },
                sampleDates: { type: Type.ARRAY, items: { type: Type.STRING } },
                notes: { type: Type.STRING },
              },
              required: [
                'name',
                'vendor',
                'category',
                'amount',
                'frequency',
                'billingDay',
                'billingMonth',
                'ivaRate',
                'ivaDeductible',
                'hasInvoice',
                'matchCount',
                'sampleDates',
                'notes',
              ],
            },
          },
          suggestedCreditFacilities: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                lender: { type: Type.STRING },
                facilityType: {
                  type: Type.STRING,
                  description: 'term_loan, credit_line, credit_card, mortgage, or equipment_loan',
                },
                monthlyPayment: { type: Type.NUMBER },
                dueDay: { type: Type.INTEGER },
                apr: { type: Type.NUMBER },
                matchCount: { type: Type.INTEGER },
                notes: { type: Type.STRING },
              },
              required: [
                'name',
                'lender',
                'facilityType',
                'monthlyPayment',
                'dueDay',
                'apr',
                'matchCount',
                'notes',
              ],
            },
          },
          suggestedTransactions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                lineIndex: { type: Type.INTEGER },
                date: { type: Type.STRING },
                description: { type: Type.STRING },
                vendor: { type: Type.STRING },
                category: { type: Type.STRING },
                type: {
                  type: Type.STRING,
                  description: 'income, expense, transfer, debt_payment, or payroll',
                },
                amount: { type: Type.NUMBER },
                ivaRate: { type: Type.NUMBER },
                ivaDeductible: { type: Type.BOOLEAN },
                notes: { type: Type.STRING },
              },
              required: [
                'lineIndex',
                'date',
                'description',
                'vendor',
                'category',
                'type',
                'amount',
                'ivaRate',
                'ivaDeductible',
                'notes',
              ],
            },
          },
        },
        required: ['suggestedSubscriptions', 'suggestedCreditFacilities', 'suggestedTransactions'],
      },
    },
  });

  const parsed = JSON.parse(
    (response.text ?? '{"suggestedSubscriptions":[],"suggestedCreditFacilities":[],"suggestedTransactions":[]}').trim()
  ) as {
    suggestedSubscriptions?: unknown[];
    suggestedCreditFacilities?: unknown[];
    suggestedTransactions?: unknown[];
  };
  return {
    suggestedSubscriptions: Array.isArray(parsed.suggestedSubscriptions) ? parsed.suggestedSubscriptions : [],
    suggestedCreditFacilities: Array.isArray(parsed.suggestedCreditFacilities)
      ? parsed.suggestedCreditFacilities
      : [],
    suggestedTransactions: Array.isArray(parsed.suggestedTransactions) ? parsed.suggestedTransactions : [],
  };
}

export const routes: Record<string, Route> = {};

routes['health'] = (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'strata-treasury' });
};

routes['parse/payslip'] = async (req: Request, res: Response) => {
  try {
    const body = req.body as ParseDocumentBody;
    const filename = body.filename || 'payslip';
    const mimeType = body.mimeType || 'application/pdf';

    if (!body.base64Data && !body.textContent) {
      res.status(400).json({ error: 'No payslip file content provided.' });
      return;
    }

    const { items, suggestedContracts } = await extractPayslipsWithGemini({
      filename,
      mimeType,
      base64Data: body.base64Data,
      textContent: body.textContent,
    });

    res.json({
      data: items[0] ?? null,
      items,
      suggestedContracts,
    });
  } catch (err) {
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
};

routes['parse/statement'] = async (req: Request, res: Response) => {
  try {
    const body = req.body as ParseDocumentBody;
    const filename = body.filename || 'statement';
    const mimeType = body.mimeType || 'application/pdf';

    if (!body.base64Data && !body.textContent) {
      res.status(400).json({ error: 'No bank statement content provided.' });
      return;
    }

    const parsed = await extractStatementWithGemini({
      filename,
      mimeType,
      base64Data: body.base64Data,
      textContent: body.textContent,
    });
    res.json({ data: parsed });
  } catch (err) {
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
};

routes['parse/invoice'] = async (req: Request, res: Response) => {
  try {
    const body = req.body as ParseDocumentBody;
    const filename = body.filename || 'invoice.pdf';
    const mimeType = body.mimeType || 'application/pdf';

    if (!body.base64Data && !body.textContent) {
      res.status(400).json({ error: 'No invoice file content provided.' });
      return;
    }

    const parsed = await extractInvoiceWithGemini({
      filename,
      mimeType,
      base64Data: body.base64Data,
      textContent: body.textContent,
      entityNames: body.entityNames,
    });

    res.json({ data: { ...parsed, filename } });
  } catch (err) {
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
};

routes['reconcile/suggest'] = async (req: Request, res: Response) => {
  try {
    const body = req.body as ReconcileSuggestBody;
    const lines = body.statementLines ?? [];
    const transactions = body.transactions ?? [];

    if (lines.length === 0 || transactions.length === 0) {
      res.json({ matches: [] });
      return;
    }

    const ai = getAiClient();
    const promptText = `Match unmatched bank statement lines to candidate ledger transactions.
Only match when amounts are identical or within 0.05 (unless clear bank fee difference) and dates are within 7 days and descriptions plausibly refer to the same counterparty or payment.

Statement lines:
${JSON.stringify(lines.slice(0, 60))}

Candidate ledger transactions:
${JSON.stringify(transactions.slice(0, 120))}`;

    const response = await generateContentWithFallback(ai, {
      contents: promptText,
      config: {
        systemInstruction:
          'You are a treasury reconciliation matcher. Only suggest high-confidence matches where lineId and transactionId come verbatim from the input lists.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            matches: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  lineId: { type: Type.STRING },
                  transactionId: { type: Type.STRING },
                  confidence: { type: Type.NUMBER, description: 'Confidence 0 to 1' },
                  reason: { type: Type.STRING },
                },
                required: ['lineId', 'transactionId', 'confidence', 'reason'],
              },
            },
          },
          required: ['matches'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{"matches":[]}').trim());
    res.json({ matches: Array.isArray(parsed.matches) ? parsed.matches : [] });
  } catch (err) {
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
};

// ---------------------------------------------------------------------------
// Google Workspace Gmail & Drive Proxy Routes (Bearer Token From Client Only)
// ---------------------------------------------------------------------------
routes['workspace/gmail/scan'] = async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Google Workspace session token.' });
    return;
  }

  try {
    const { q, afterDate, beforeDate, maxResults = 25 } = req.body as {
      q?: string;
      afterDate?: string;
      beforeDate?: string;
      maxResults?: number;
    };

    const parts: string[] = [];
    parts.push(
      q && q.trim()
        ? `(${q.trim()})`
        : '(invoice OR fatura OR recibo OR receipt OR statement OR extrato)'
    );
    parts.push('has:attachment');
    if (afterDate && /^\d{4}-\d{2}-\d{2}$/.test(afterDate)) {
      parts.push(`after:${afterDate.replace(/-/g, '/')}`);
    }
    if (beforeDate && /^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
      parts.push(`before:${beforeDate.replace(/-/g, '/')}`);
    }

    const queryString = parts.join(' ');
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(
      40,
      Math.max(1, Number(maxResults) || 25)
    )}&q=${encodeURIComponent(queryString)}`;

    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (listRes.status === 401) {
      res.status(401).json({ error: 'Gmail session expired. Please reconnect your Google Workspace session.' });
      return;
    }
    if (!listRes.ok) {
      const errText = await listRes.text();
      res.status(listRes.status).json({ error: `Gmail search error: ${errText}` });
      return;
    }

    const listJson = (await listRes.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
    };
    const rawMessages = listJson.messages ?? [];

    const candidates = await Promise.all(
      rawMessages.slice(0, 25).map(async (m) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!msgRes.ok) return null;
        const msg = (await msgRes.json()) as {
          id: string;
          threadId: string;
          snippet?: string;
          internalDate?: string;
          payload?: GmailPart & {
            headers?: Array<{ name: string; value: string }>;
          };
        };

        const headers = msg.payload?.headers ?? [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

        const attachments = collectAttachments(msg.payload, []);
        if (attachments.length === 0) return null;

        const internalMs = Number(msg.internalDate);
        const dateIso = Number.isFinite(internalMs)
          ? new Date(internalMs).toISOString().slice(0, 10)
          : '';

        return {
          messageId: msg.id,
          threadId: msg.threadId,
          subject: getHeader('Subject') || '(No Subject)',
          from: getHeader('From') || 'Unknown sender',
          dateIso,
          snippet: msg.snippet || '',
          attachments,
        };
      })
    );

    res.json({ messages: candidates.filter(Boolean) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to scan Gmail.';
    res.status(500).json({ error: msg });
  }
};

routes['workspace/gmail/extract-attachment'] = async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Google Workspace session token.' });
    return;
  }

  try {
    const {
      messageId,
      attachmentId,
      filename = 'invoice.pdf',
      mimeType = 'application/pdf',
      runAiExtract = true,
      entityNames = [],
    } = req.body as {
      messageId?: string;
      attachmentId?: string;
      filename?: string;
      mimeType?: string;
      runAiExtract?: boolean;
      entityNames?: string[];
    };

    if (!messageId || !attachmentId) {
      res.status(400).json({ error: 'messageId and attachmentId are required.' });
      return;
    }

    const attRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
        messageId
      )}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (attRes.status === 401) {
      res.status(401).json({ error: 'Gmail session expired. Please reconnect.' });
      return;
    }
    if (!attRes.ok) {
      const errText = await attRes.text();
      res.status(attRes.status).json({ error: `Failed to fetch Gmail attachment: ${errText}` });
      return;
    }

    const attJson = (await attRes.json()) as { data?: string };
    if (!attJson.data) {
      res.status(400).json({ error: 'Attachment returned empty payload.' });
      return;
    }

    const base64Data = base64UrlToStandard(attJson.data);
    let extracted = null;
    if (runAiExtract) {
      const isCsv = mimeType.includes('csv') || filename.toLowerCase().endsWith('.csv');
      const textContent = isCsv ? Buffer.from(base64Data, 'base64').toString('utf8') : undefined;
      const parsed = await extractInvoiceWithGemini({
        filename,
        mimeType,
        base64Data: isCsv ? undefined : base64Data,
        textContent,
        entityNames,
      });
      extracted = { ...parsed, filename };
    }

    res.json({ filename, mimeType, base64Data, extracted });
  } catch (err) {
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
};

routes['workspace/drive/list'] = async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Google Workspace session token.' });
    return;
  }

  try {
    const { folderId, query } = req.body as { folderId?: string; query?: string };

    const foldersUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      "mimeType='application/vnd.google-apps.folder' and trashed=false"
    )}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,parents,webViewLink)&orderBy=name&pageSize=100`;

    const fileFilterParts = [
      "trashed=false",
      "mimeType!='application/vnd.google-apps.folder'",
      "(mimeType='application/pdf' or mimeType contains 'image/' or mimeType='text/csv' or mimeType='text/plain' or mimeType='application/vnd.google-apps.spreadsheet')",
    ];
    if (folderId) {
      fileFilterParts.push(`'${folderId}' in parents`);
    }
    if (query && query.trim()) {
      const safeQ = query.trim().replace(/'/g, "\\'");
      fileFilterParts.push(`name contains '${safeQ}'`);
    }

    const filesUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      fileFilterParts.join(' and ')
    )}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,modifiedTime,size,webViewLink,parents)&orderBy=modifiedTime desc&pageSize=100`;

    const [foldersRes, filesRes] = await Promise.all([
      fetch(foldersUrl, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(filesUrl, { headers: { Authorization: `Bearer ${token}` } }),
    ]);

    if (foldersRes.status === 401 || filesRes.status === 401) {
      res.status(401).json({ error: 'Google Drive session expired. Please reconnect.' });
      return;
    }

    const foldersJson = foldersRes.ok ? ((await foldersRes.json()) as { files?: unknown[] }) : { files: [] };
    const filesJson = filesRes.ok ? ((await filesRes.json()) as { files?: unknown[] }) : { files: [] };

    res.json({
      folders: foldersJson.files ?? [],
      files: filesJson.files ?? [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to list Google Drive.';
    res.status(500).json({ error: msg });
  }
};

routes['workspace/drive/extract-file'] = async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Google Workspace session token.' });
    return;
  }

  try {
    const { fileId, filename = 'invoice.pdf', mimeType = 'application/pdf', entityNames = [] } =
      req.body as {
        fileId?: string;
        filename?: string;
        mimeType?: string;
        entityNames?: string[];
      };

    if (!fileId) {
      res.status(400).json({ error: 'fileId is required.' });
      return;
    }

    const { meta, base64Data, textContent } = await downloadDriveFilePayload(
      token,
      fileId,
      filename,
      mimeType
    );

    const parsed = await extractInvoiceWithGemini({
      filename: meta.name,
      mimeType: meta.mimeType,
      base64Data,
      textContent,
      entityNames,
    });

    res.json({
      file: meta,
      extracted: { ...parsed, filename: meta.name },
    });
  } catch (err) {
    const httpStatus = (err as { httpStatus?: number }).httpStatus;
    if (httpStatus === 401) {
      res.status(401).json({ error: 'Google Drive session expired. Please reconnect.' });
      return;
    }
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
};

routes['workspace/drive/extract-statement'] = async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Google Workspace session token.' });
    return;
  }

  try {
    const { fileId, filename = 'statement.pdf', mimeType = 'application/pdf' } = req.body as {
      fileId?: string;
      filename?: string;
      mimeType?: string;
    };
    if (!fileId) {
      res.status(400).json({ error: 'fileId is required.' });
      return;
    }

    const { meta, base64Data, textContent } = await downloadDriveFilePayload(
      token,
      fileId,
      filename,
      mimeType
    );

    const parsed = await extractStatementWithGemini({
      filename: meta.name,
      mimeType: meta.mimeType,
      base64Data,
      textContent,
    });

    res.json({
      file: meta,
      data: {
        filename: meta.name,
        statementPeriod: parsed.statementPeriod || '',
        openingBalance: Number(parsed.openingBalance) || 0,
        closingBalance: Number(parsed.closingBalance) || 0,
        lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      },
    });
  } catch (err) {
    const httpStatus = (err as { httpStatus?: number }).httpStatus;
    if (httpStatus === 401) {
      res.status(401).json({ error: 'Google Drive session expired. Please reconnect.' });
      return;
    }
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
};

routes['workspace/drive/extract-payslip'] = async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Google Workspace session token.' });
    return;
  }

  try {
    const { fileId, filename = 'payslip.pdf', mimeType = 'application/pdf' } = req.body as {
      fileId?: string;
      filename?: string;
      mimeType?: string;
    };
    if (!fileId) {
      res.status(400).json({ error: 'fileId is required.' });
      return;
    }

    const { meta, base64Data, textContent } = await downloadDriveFilePayload(
      token,
      fileId,
      filename,
      mimeType
    );

    const { items, suggestedContracts } = await extractPayslipsWithGemini({
      filename: meta.name,
      mimeType: meta.mimeType,
      base64Data,
      textContent,
    });

    res.json({
      file: meta,
      data: items[0] ?? null,
      items,
      suggestedContracts,
    });
  } catch (err) {
    const httpStatus = (err as { httpStatus?: number }).httpStatus;
    if (httpStatus === 401) {
      res.status(401).json({ error: 'Google Drive session expired. Please reconnect.' });
      return;
    }
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
};

routes['workspace/discover-patterns'] = async (req: Request, res: Response) => {
  try {
    const { lines = [], entityNames = [] } = req.body as {
      lines?: Array<{ date: string; description: string; amount: number; direction: string }>;
      entityNames?: string[];
    };

    if (!Array.isArray(lines) || lines.length === 0) {
      res.json({
        suggestedSubscriptions: [],
        suggestedCreditFacilities: [],
        suggestedTransactions: [],
      });
      return;
    }

    const discovery = await discoverPatternsFromLinesWithGemini({
      lines,
      entityNames,
    });
    res.json(discovery);
  } catch (err) {
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
};

routes['workspace/drive/file-invoice'] = async (req: Request, res: Response) => {
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Google Workspace session token.' });
    return;
  }

  try {
    const {
      rootFolderId,
      rootFolderName = 'Strata Treasury',
      entityName = 'General',
      year = String(new Date().getUTCFullYear()),
      docCategory = 'Invoices',
      filename = 'invoice.pdf',
      mimeType = 'application/pdf',
      base64Data,
      existingDriveFileId,
    } = req.body as {
      rootFolderId?: string;
      rootFolderName?: string;
      entityName?: string;
      year?: string;
      docCategory?: string;
      filename?: string;
      mimeType?: string;
      base64Data?: string;
      existingDriveFileId?: string;
    };

    const rootFolder = rootFolderId
      ? { id: rootFolderId, name: rootFolderName || 'Custom Folder' }
      : await ensureDriveFolder(token, rootFolderName);
    const entityFolder = await ensureDriveFolder(token, entityName, rootFolder.id);
    const yearFolder = await ensureDriveFolder(token, year, entityFolder.id);
    const targetFolder = await ensureDriveFolder(token, docCategory, yearFolder.id);

    const driveFolderPath = `${rootFolder.name} / ${entityFolder.name} / ${yearFolder.name} / ${targetFolder.name}`;

    if (existingDriveFileId) {
      const metaRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          existingDriveFileId
        )}?fields=id,name,parents,webViewLink`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (metaRes.status === 401) {
        res.status(401).json({ error: 'Google Drive session expired. Please reconnect.' });
        return;
      }
      const metaJson = (await metaRes.json()) as { parents?: string[] };
      const removeParents = (metaJson.parents ?? [])
        .filter((p) => p !== targetFolder.id)
        .join(',');

      const patchUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        existingDriveFileId
      )}?addParents=${encodeURIComponent(targetFolder.id)}${
        removeParents ? `&removeParents=${encodeURIComponent(removeParents)}` : ''
      }&fields=id,name,webViewLink`;

      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: filename }),
      });

      if (!patchRes.ok) {
        const errText = await patchRes.text();
        res.status(patchRes.status).json({ error: `Drive file move failed: ${errText}` });
        return;
      }

      const moved = (await patchRes.json()) as {
        id: string;
        name: string;
        webViewLink?: string;
      };

      res.json({
        driveFileId: moved.id,
        driveWebViewLink:
          moved.webViewLink || `https://drive.google.com/file/d/${moved.id}/view`,
        driveFolderId: targetFolder.id,
        driveFolderPath,
      });
      return;
    }

    if (!base64Data) {
      res.status(400).json({ error: 'Either base64Data or existingDriveFileId is required.' });
      return;
    }

    const boundary = `strata_${Date.now()}`;
    const metadata = JSON.stringify({
      name: filename,
      parents: [targetFolder.id],
    });
    const fileBuffer = Buffer.from(base64Data, 'base64');

    const headerPart = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf8'
    );
    const footerPart = Buffer.from(`\r\n--${boundary}--`, 'utf8');
    const multipartBody = Buffer.concat([headerPart, fileBuffer, footerPart]);

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      }
    );

    if (uploadRes.status === 401) {
      res.status(401).json({ error: 'Google Drive session expired. Please reconnect.' });
      return;
    }
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      res.status(uploadRes.status).json({ error: `Drive upload failed: ${errText}` });
      return;
    }

    const uploaded = (await uploadRes.json()) as {
      id: string;
      name: string;
      webViewLink?: string;
    };

    res.json({
      driveFileId: uploaded.id,
      driveWebViewLink:
        uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
      driveFolderId: targetFolder.id,
      driveFolderPath,
    });
  } catch (err) {
    const httpStatus = (err as { httpStatus?: number }).httpStatus;
    if (httpStatus === 401) {
      res.status(401).json({ error: 'Google Drive session expired. Please reconnect.' });
      return;
    }
    const msg = err instanceof Error ? err.message : 'Unable to file document in Google Drive.';
    res.status(500).json({ error: msg });
  }
};
