// MCP server for FinHub's book (apps/noisysource/finhub), for Claude Code.
//
// It reads the whole book and proposes changes; it never writes the book. A proposal is a
// pending document in finhub_books/noisysource-group/atlas_imports (createdBy "claude-code"),
// shown in FinHub's "From Atlas" tab, where Renato reviews it and commits or sets it aside.
// It signs in as the coding agent's own Firebase Auth account (claude-code@kidclub.pt,
// verified); the FinHub rules let that account read the book and create or update only its
// own pending proposals (isClaudeCode() in firebase/noisysource/firestore.rules).
//
// Env:
//   FINHUB_PROJECT   noisysource-dev (FinHub lives there today) or noisysource-prod
//   FINHUB_PASSWORD  the account's password (your gitignored .claude/settings.local.json or
//                    your shell, never git)
//   FINHUB_EMAIL     optional, default claude-code@kidclub.pt
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, getFirestore, limit, query, serverTimestamp, setDoc, where } from 'firebase/firestore';

// Public web configs (the same as the apps' .env.nsdev / .env.nsprod).
const CONFIGS = {
  'noisysource-prod': { apiKey: 'AIzaSyDhUNzgid_Lxu5X00TY76hD_ebdt215SLQ', authDomain: 'noisysource-prod.firebaseapp.com' },
  'noisysource-dev': { apiKey: 'AIzaSyBVVzcHuuB7UWKuiLwyp4cr8cjZc_DKH2U', authDomain: 'noisysource-dev.firebaseapp.com' },
};
const BOOK = 'finhub_books/noisysource-group';

const PROJECT = process.env.FINHUB_PROJECT;
const EMAIL = process.env.FINHUB_EMAIL || 'claude-code@kidclub.pt';
const PASSWORD = process.env.FINHUB_PASSWORD;
if (!CONFIGS[PROJECT]) {
  process.stderr.write(`FINHUB_PROJECT must be one of: ${Object.keys(CONFIGS).join(', ')}\n`);
  process.exit(1);
}
if (!PASSWORD) {
  process.stderr.write('FINHUB_PASSWORD is required\n');
  process.exit(1);
}

const app = initializeApp({ ...CONFIGS[PROJECT], projectId: PROJECT });
const auth = getAuth(app);
const db = getFirestore(app);
let signedIn;
const ensureSignedIn = () => (signedIn ??= signInWithEmailAndPassword(auth, EMAIL, PASSWORD).catch((e) => {
  signedIn = undefined;
  throw new Error(`sign-in as ${EMAIL} failed: ${e.code ?? e.message}`);
}));

// Keep in step with apps/noisysource/finhub/src/contexts/TreasuryContext.tsx.
const COLLECTIONS = [
  'entities', 'accounts', 'employmentContracts', 'payslips', 'creditFacilities', 'transactions',
  'statementLines', 'statementBatches', 'recurringExpenses', 'personalIncomes', 'invoiceDocuments',
  'forecastItems', 'reimbursements', 'taxSettings', 'atlas_imports',
];

const SETUP_SCHEMA = {
  type: 'object',
  description: 'Entities, accounts and loans to create when he OKs it. Never bank account numbers (IBANs): he adds those.',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'entityType'],
        properties: { name: { type: 'string' }, entityType: { enum: ['company', 'personal'] }, registrationCode: { type: 'string', description: 'NIPC or NIF' } },
      },
    },
    accounts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['entityName', 'name', 'institution', 'balance'],
        properties: {
          entityName: { type: 'string', description: 'One of the entities (here or already in the book)' },
          name: { type: 'string' },
          institution: { type: 'string' },
          accountType: { enum: ['checking', 'savings', 'treasury', 'cash', 'meal_voucher', 'child_voucher'] },
          balance: { type: 'number', description: 'The balance on balanceDate' },
          balanceDate: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
    loans: {
      type: 'array',
      items: {
        type: 'object',
        required: ['entityName', 'name', 'lender', 'currentBalance'],
        properties: {
          entityName: { type: 'string' },
          accountName: { type: 'string', description: 'The account it is paid from' },
          name: { type: 'string' },
          lender: { type: 'string' },
          facilityType: { enum: ['term_loan', 'credit_line', 'credit_card', 'mortgage', 'equipment_loan'] },
          principalOrLimit: { type: 'number' },
          currentBalance: { type: 'number', description: 'What is still owed' },
          apr: { type: 'number', description: 'Percent' },
          monthlyPayment: { type: 'number' },
          dueDay: { type: 'integer' },
          maturityDate: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
  },
};

const TOOLS = [
  {
    name: 'finhub_read',
    description: `Read one collection of FinHub's book (the bookkeeping of NoisySource, Noisy Phocus and the household). Collections: ${COLLECTIONS.join(', ')}. Optional field/value filter (equality), up to 500 documents.`,
    inputSchema: {
      type: 'object',
      required: ['collection'],
      properties: {
        collection: { enum: COLLECTIONS },
        where: { type: 'object', properties: { field: { type: 'string' }, value: {} }, required: ['field', 'value'] },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: 'finhub_get',
    description: 'Read one document of the book by collection and id.',
    inputSchema: { type: 'object', required: ['collection', 'id'], properties: { collection: { enum: COLLECTIONS }, id: { type: 'string' } } },
  },
  {
    name: 'finhub_propose',
    description:
      'Propose changes to the book for his OK: a pending document in FinHub\'s "From Atlas" tab, marked as from Claude Code. Nothing in the book changes until he commits it there. Give a setup (entities, accounts, loans; "Create these") and/or drafts for the review workbench (statements, payslips, contracts, subscriptions, facilities, in the shapes of apps/noisysource/finhub/src/lib/atlasImports.ts). Proposing again with the same id replaces it while it is still pending.',
    inputSchema: {
      type: 'object',
      required: ['id', 'entityHint', 'month', 'summary'],
      properties: {
        id: { type: 'string', description: 'Letters, digits, - and _ (e.g. setup-2026)' },
        entityHint: { type: 'string', description: 'Whose it is, by name (matched ignoring case and "Lda")' },
        month: { type: 'string', description: 'YYYY-MM the proposal is about' },
        summary: { type: 'string', description: 'What it is and where it came from, for him to read (up to 4000 characters)' },
        sources: { type: 'array', items: { type: 'object', properties: { kind: { enum: ['drive', 'gmail'] }, name: { type: 'string' }, id: { type: 'string' }, link: { type: 'string' } } } },
        setup: SETUP_SCHEMA,
        statements: { type: 'array', items: { type: 'object' } },
        payslips: { type: 'array', items: { type: 'object' } },
        contracts: { type: 'array', items: { type: 'object' } },
        subscriptions: { type: 'array', items: { type: 'object' } },
        facilities: { type: 'array', items: { type: 'object' } },
      },
    },
  },
];

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const plain = (snap) => JSON.parse(JSON.stringify({ id: snap.id, ...snap.data() }, (_k, v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v)));

const run = async (name, a) => {
  if (name === 'finhub_read') {
    if (!COLLECTIONS.includes(a.collection)) throw new Error(`collection: one of ${COLLECTIONS.join(', ')}`);
    const parts = [collection(db, `${BOOK}/${a.collection}`)];
    if (a.where) parts.push(where(String(a.where.field), '==', a.where.value));
    parts.push(limit(Math.min(500, Math.max(1, Number(a.limit) || 200))));
    const snap = await getDocs(query(...parts));
    return { collection: a.collection, count: snap.size, documents: snap.docs.map(plain) };
  }
  if (name === 'finhub_get') {
    if (!COLLECTIONS.includes(a.collection) || !ID.test(String(a.id))) throw new Error('collection and id');
    const snap = await getDoc(doc(db, `${BOOK}/${a.collection}/${a.id}`));
    return snap.exists() ? plain(snap) : { missing: true };
  }
  if (name === 'finhub_propose') {
    if (!ID.test(String(a.id))) throw new Error('id: letters, digits, - and _');
    if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(String(a.month))) throw new Error('month: YYYY-MM');
    const list = (v) => (Array.isArray(v) ? v : []);
    const setup = a.setup ? { entities: list(a.setup.entities), accounts: list(a.setup.accounts), loans: list(a.setup.loans) } : undefined;
    const ref = doc(db, `${BOOK}/atlas_imports/${a.id}`);
    const before = await getDoc(ref);
    await setDoc(ref, {
      entityHint: String(a.entityHint).slice(0, 100),
      month: a.month,
      summary: String(a.summary).slice(0, 4000),
      sources: list(a.sources),
      statements: list(a.statements),
      payslips: list(a.payslips),
      contracts: list(a.contracts),
      subscriptions: list(a.subscriptions),
      facilities: list(a.facilities),
      ...(setup ? { setup } : {}),
      status: 'pending',
      createdBy: 'claude-code',
      createdAt: before.exists() ? before.data().createdAt : serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { proposed: a.id, waiting: 'for his OK in FinHub → Documents → From Atlas' };
  }
  throw new Error(`Unknown tool ${name}`);
};

const server = new Server({ name: `finhub-${PROJECT}`, version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    await ensureSignedIn();
    const data = await run(request.params.name, request.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `${e.code ?? 'error'}: ${e.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
