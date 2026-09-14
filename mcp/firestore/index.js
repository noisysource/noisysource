import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

const PROJECT_ID = process.env.FIRESTORE_PROJECT_ID;
const CRED_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!PROJECT_ID) {
  process.stderr.write('FIRESTORE_PROJECT_ID env var required\n');
  process.exit(1);
}

let db;
try {
  const appConfig = { projectId: PROJECT_ID };
  // Use explicit SA key if the file exists and has content, else fall back to ADC
  if (CRED_PATH) {
    try {
      const content = readFileSync(CRED_PATH, 'utf8').trim();
      if (content) appConfig.credential = cert(JSON.parse(content));
    } catch {
      // File missing or empty — ADC will be used
    }
  }
  db = getFirestore(initializeApp(appConfig, PROJECT_ID));
} catch (e) {
  process.stderr.write(`Firebase init error: ${e.message}\n`);
  process.exit(1);
}

function serialize(val) {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;
  // Firestore Timestamp
  if (typeof val.toDate === 'function') return val.toDate().toISOString();
  // DocumentReference
  if (val.firestore && val.path) return `ref:${val.path}`;
  // GeoPoint
  if (typeof val.latitude === 'number') return { lat: val.latitude, lng: val.longitude };
  if (Array.isArray(val)) return val.map(serialize);
  return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, serialize(v)]));
}

function docData(snap) {
  return { id: snap.id, path: snap.ref.path, data: serialize(snap.data()) };
}

const server = new Server(
  { name: `firestore-${PROJECT_ID}`, version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_collections',
      description:
        'List Firestore collection IDs. Pass an empty string (or omit) for root-level collections. Pass a document path like "_apps/arcoiris" to list its subcollections.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_path: {
            type: 'string',
            description: 'Parent document path (empty = root). E.g. "_apps/arcoiris" or "finances_entities/entity1"',
          },
        },
      },
    },
    {
      name: 'get_document',
      description: 'Fetch a single Firestore document by its full path.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Full document path, e.g. "_apps/arcoiris/families/abc123"' },
        },
      },
    },
    {
      name: 'query_collection',
      description:
        'Query documents in a Firestore collection with optional filters, ordering, and limit. Returns document ids and all fields.',
      inputSchema: {
        type: 'object',
        required: ['collection_path'],
        properties: {
          collection_path: {
            type: 'string',
            description: 'Full collection path, e.g. "_apps/arcoiris/families" or "_apps/arcoiris/transportationSubscriptions"',
          },
          limit: { type: 'number', description: 'Max results (default 20, max 100)' },
          filters: {
            type: 'array',
            description: 'Where clauses to filter results',
            items: {
              type: 'object',
              required: ['field', 'op', 'value'],
              properties: {
                field: { type: 'string' },
                op: {
                  type: 'string',
                  enum: ['==', '!=', '<', '<=', '>', '>=', 'array-contains', 'in', 'not-in'],
                },
                value: { description: 'Filter value (string, number, boolean, or array for in/not-in)' },
              },
            },
          },
          order_by: { type: 'string', description: 'Field name to order results by' },
          order_dir: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default: asc)' },
        },
      },
    },
    {
      name: 'count_collection',
      description: 'Count documents in a collection (with optional filters) without fetching all data.',
      inputSchema: {
        type: 'object',
        required: ['collection_path'],
        properties: {
          collection_path: { type: 'string' },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              required: ['field', 'op', 'value'],
              properties: {
                field: { type: 'string' },
                op: { type: 'string', enum: ['==', '!=', '<', '<=', '>', '>=', 'array-contains', 'in', 'not-in'] },
                value: {},
              },
            },
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'list_collections') {
      const parentPath = args?.parent_path?.trim() ?? '';
      const collections = parentPath
        ? await db.doc(parentPath).listCollections()
        : await db.listCollections();
      const ids = collections.map((c) => c.id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ project: PROJECT_ID, parent: parentPath || '(root)', collections: ids }, null, 2),
          },
        ],
      };
    }

    if (name === 'get_document') {
      const snap = await db.doc(args.path).get();
      if (!snap.exists) {
        return { content: [{ type: 'text', text: `Not found: ${args.path}` }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(docData(snap), null, 2) }],
      };
    }

    if (name === 'query_collection') {
      let q = db.collection(args.collection_path);
      for (const f of args.filters ?? []) q = q.where(f.field, f.op, f.value);
      if (args.order_by) q = q.orderBy(args.order_by, args.order_dir ?? 'asc');
      q = q.limit(Math.min(args.limit ?? 20, 100));
      const snap = await q.get();
      const docs = snap.docs.map(docData);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ project: PROJECT_ID, collection: args.collection_path, count: docs.length, docs }, null, 2),
          },
        ],
      };
    }

    if (name === 'count_collection') {
      let q = db.collection(args.collection_path);
      for (const f of args.filters ?? []) q = q.where(f.field, f.op, f.value);
      const snap = await q.count().get();
      const count = snap.data().count;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ project: PROJECT_ID, collection: args.collection_path, count }, null, 2),
          },
        ],
      };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
