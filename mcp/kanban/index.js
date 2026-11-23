// MCP server for the Tasks kanban (apps/noisysource/tasks), for Claude Code.
//
// It signs in as the coding agent's own Firebase Auth account
// (claude-code@kidclub.pt, verified) and calls the kanban* callables
// (firebase/noisysource/functions/src/tasks/callables.ts). That account can use
// those callables and nothing else in the project: no Firestore rule knows it,
// and the house callables refuse it. It can't delete cards or boards.
//
// Env:
//   KANBAN_PROJECT   noisysource-prod (the real boards) or noisysource-dev
//   KANBAN_PASSWORD  the account's password (keep it in your gitignored
//                    .claude/settings.local.json or your shell, never in git)
//   KANBAN_EMAIL     optional, default claude-code@kidclub.pt
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

// Public web configs (the same as the apps' .env.nsdev / .env.nsprod).
const CONFIGS = {
  'noisysource-prod': { apiKey: 'AIzaSyDhUNzgid_Lxu5X00TY76hD_ebdt215SLQ', authDomain: 'noisysource-prod.firebaseapp.com' },
  'noisysource-dev': { apiKey: 'AIzaSyBVVzcHuuB7UWKuiLwyp4cr8cjZc_DKH2U', authDomain: 'noisysource-dev.firebaseapp.com' },
};

const PROJECT = process.env.KANBAN_PROJECT;
const EMAIL = process.env.KANBAN_EMAIL || 'claude-code@kidclub.pt';
const PASSWORD = process.env.KANBAN_PASSWORD;
if (!CONFIGS[PROJECT]) {
  process.stderr.write(`KANBAN_PROJECT must be one of: ${Object.keys(CONFIGS).join(', ')}\n`);
  process.exit(1);
}
if (!PASSWORD) {
  process.stderr.write('KANBAN_PASSWORD is required\n');
  process.exit(1);
}

const app = initializeApp({ ...CONFIGS[PROJECT], projectId: PROJECT });
const auth = getAuth(app);
const fns = getFunctions(app, 'europe-west3');
let signedIn;
const ensureSignedIn = () => (signedIn ??= signInWithEmailAndPassword(auth, EMAIL, PASSWORD).catch((e) => {
  signedIn = undefined;
  throw new Error(`sign-in as ${EMAIL} failed: ${e.code ?? e.message}`);
}));

// Keep in step with packages/shared/lib/kanban.ts.
const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done'];
const PRIORITIES = ['p0', 'p1', 'p2', 'p3'];
const ASSIGNEES = ['renato', 'marisa', 'atlas', 'claude-code'];

const cardFields = {
  title: { type: 'string', description: 'Short, imperative. At most 200 characters.' },
  description: { type: 'string', description: 'Markdown: context, acceptance criteria, notes.' },
  testPlan: {
    type: 'string',
    description:
      'How Renato tests it, in Markdown: where (dev preview URL, local), setup (seed data, env, accounts), numbered steps with the expected result, and what must still work. The board adds the checkout commands from the linked PR itself.',
  },
  status: { type: 'string', enum: STATUSES },
  priority: { type: 'string', enum: PRIORITIES, description: 'p0 urgent … p3 low. Default p2.' },
  assignee: { type: ['string', 'null'], enum: [...ASSIGNEES, null] },
  roadmap: { type: 'boolean', description: 'Also show on the "All systems" roadmap.' },
  labels: { type: 'array', items: { type: 'string' }, description: 'Up to 10, e.g. bug, infra.' },
  links: {
    type: 'array',
    description: 'Up to 10, e.g. the PR or issue. Replaces the whole list.',
    items: { type: 'object', required: ['label', 'url'], properties: { label: { type: 'string' }, url: { type: 'string' } } },
  },
};

const TOOLS = [
  {
    name: 'kanban_list',
    description:
      'List the boards and their open cards. Boards: one per app (kidclub, finhub, domotics, atlas, website, tasks…) and "systems" (All systems: cross-app work). Done cards are left out unless includeDone or status=done.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'Only this board.' },
        roadmap: { type: 'boolean', description: 'Only cards on the All systems roadmap.' },
        status: { type: 'string', enum: STATUSES },
        assignee: { type: 'string', enum: ASSIGNEES },
        includeDone: { type: 'boolean' },
      },
    },
  },
  {
    name: 'kanban_get',
    description: 'One card with its latest 50 activity entries (changes and comments).',
    inputSchema: { type: 'object', required: ['cardId'], properties: { cardId: { type: 'string' } } },
  },
  {
    name: 'kanban_create',
    description: 'Create a card at the bottom of its column. boardId and title are required; status defaults to backlog.',
    inputSchema: { type: 'object', required: ['boardId', 'title'], properties: { boardId: { type: 'string' }, ...cardFields } },
  },
  {
    name: 'kanban_update',
    description:
      'Change a card: only the fields given. Moving it (status or boardId) puts it at the bottom of the new column. Flow: take a card (assignee claude-code, status in_progress); open the PR and add it to links (status review); once the dev preview is deployed, write testPlan and move it to testing, assigned to renato. Renato merges from the board, which moves it to done.',
    inputSchema: {
      type: 'object',
      required: ['cardId'],
      properties: { cardId: { type: 'string' }, boardId: { type: 'string' }, ...cardFields },
    },
  },
  {
    name: 'kanban_prs',
    description:
      'The pull requests linked to a card: state, base and head branch, conflicts, and every check run (the deploy jobs). Use it to see whether the dev preview deployed before moving a card to testing. Read only: merging is Renato\'s, from the board.',
    inputSchema: { type: 'object', required: ['cardId'], properties: { cardId: { type: 'string' } } },
  },
  {
    name: 'kanban_comment',
    description: 'Add a comment to a card: progress, a question for Renato, what was decided.',
    inputSchema: { type: 'object', required: ['cardId', 'text'], properties: { cardId: { type: 'string' }, text: { type: 'string' } } },
  },
];

const CALLABLE = {
  kanban_list: 'kanbanList',
  kanban_get: 'kanbanGet',
  kanban_create: 'kanbanCreate',
  kanban_update: 'kanbanUpdate',
  kanban_comment: 'kanbanComment',
  kanban_prs: 'kanbanPrs',
};

const server = new Server({ name: `kanban-${PROJECT}`, version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = CALLABLE[request.params.name];
  if (!name) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }] };
  try {
    await ensureSignedIn();
    const { data } = await httpsCallable(fns, name)(request.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `${e.code ?? 'error'}: ${e.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
