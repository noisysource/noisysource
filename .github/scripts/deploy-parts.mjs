#!/usr/bin/env node
// Works out which parts of an environment a change needs to redeploy. Called
// by the plan job in .github/workflows/_deploy-kidclub-env.yml when the caller
// sets only_changed (dev); prod always passes --all.
//
// Why this exists: every PR into `staging` used to redeploy *everything* to
// kidclub-dev from its own branch, so a domotics PR silently reverted the
// FinHub work another PR had just put on dev, and vice versa. Now each PR
// deploys only the parts it touches, and the parts it doesn't touch keep
// whatever was last deployed there.
//
// Deploy units (since 2026-11-15, infra/HANDOFF-repo-restructure.md): the repo
// deploys into two pairs of projects, and each pair is a unit with its own
// parts and its own paths (UNITS below).
//   kidclub      kidclub-dev / rainbow-prod-2454b: everything that exists
//                today (KidClub, FinHub, domotics, /functions, root rules).
//   noisysource  noisysource-dev / noisysource-prod: firebase/noisysource/,
//                infra/gcp/terraform/noisysource/ and the apps that have moved.
// A path that belongs only to the other unit deploys nothing in this one.
// Without --unit the unit is kidclub, so the existing workflow is unchanged.
//
// Usage (run from the repo root, with the head commit checked out):
//   node .github/scripts/deploy-parts.mjs [--unit <unit>] --base <rev> --head <rev>
//   node .github/scripts/deploy-parts.mjs [--unit <unit>] --all "<why>"
// Env:
//   DISABLED_PARTS  comma-separated parts this environment never deploys
//                   (e.g. "terraform,storage_rules,domotics" for prod)
//   GITHUB_OUTPUT / GITHUB_STEP_SUMMARY  set by Actions; written if present.
//
// Plain Node, no dependencies: it runs before `pnpm install`, on the runner's
// own node. Rules, in order (first match wins for each changed file):
//   1. Not deployed by any pipeline: any *.md, scripts/, mcp/, the Pi bridge
//      (apps/noisysource/domotics-bridge), editor files -> nothing.
//   2. A path that belongs to another unit -> nothing in this one.
//   3. Pipeline / workspace / shared build config (.github/, root
//      package.json, tsconfig*, vite.config.base.ts, ...) and the unit's own
//      firebase.json / .firebaserc -> everything.
//   4. pnpm-lock.yaml -> the workspace packages whose resolved dependencies
//      changed (see lockfileParts); everything if that can't be told apart.
//   5. A path owned by one part (apps/<app>/, functions, rules, terraform).
//   6. packages/shared/ -> every app/functions of the unit that actually
//      imports the changed file (import graph, see Repo.reachableFrom).
//   7. Anything else -> everything. Unknown means "deploy it all", never
//      "deploy nothing".

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PARTS = [
  'terraform',
  'firestore_rules',
  'firestore_indexes',
  'storage_rules',
  'functions',
  'kidclub',
  'finances',
  'domotics',
];

const LABELS = {
  terraform: 'Terraform',
  firestore_rules: 'Firestore rules',
  firestore_indexes: 'Firestore indexes',
  storage_rules: 'Storage rules',
  functions: 'Cloud Functions',
  kidclub: 'KidClub hosting',
  finances: 'FinHub hosting',
  domotics: 'Domotics hosting',
};

// Code that ends up in a deploy, and which part it belongs to. `dir` is
// matched as a path prefix.
const OWNED = [
  { dir: 'apps/noisyphocus/kidclub/', part: 'kidclub' },
  { dir: 'apps/noisysource/finances/', part: 'finances' },
  { dir: 'apps/noisysource/domotics/', part: 'domotics' },
  { dir: 'functions/', part: 'functions' },
  { dir: 'infra/gcp/terraform/', part: 'terraform' },
];
const OWNED_FILES = {
  'firestore.rules': 'firestore_rules',
  'firestore.indexes.json': 'firestore_indexes',
  'storage.rules': 'storage_rules',
};

// Packages that import from packages/shared, and where their code lives. Test
// files are left out: they aren't part of any deploy (functions/ only imports
// packages/shared from its *.test.ts files).
const CONSUMERS = {
  kidclub: 'apps/noisyphocus/kidclub/',
  finances: 'apps/noisysource/finances/',
  domotics: 'apps/noisysource/domotics/',
  functions: 'functions/',
};
const SHARED = 'packages/shared/';

// The deploy units. For each: its parts, the paths each part owns, who in it
// consumes packages/shared, which files redeploy all of it (`everything`), and
// which paths are another unit's alone (`foreign`: nothing to deploy here).
// An app can be in two units while it moves (domotics): each unit's caller
// switches its own copy on or off with DISABLED_PARTS.
export const UNITS = {
  kidclub: {
    parts: PARTS,
    owned: OWNED,
    ownedFiles: OWNED_FILES,
    consumers: CONSUMERS,
    everything: [/^firebase\.json$/, /^\.firebaserc$/],
    foreign: [/^firebase\/noisysource\//, /^infra\/gcp\/terraform\/noisysource\//],
  },
  noisysource: {
    parts: ['terraform', 'firestore_rules', 'firestore_indexes', 'functions', 'domotics'],
    owned: [
      { dir: 'infra/gcp/terraform/noisysource/', part: 'terraform' },
      { dir: 'firebase/noisysource/functions/', part: 'functions' },
      { dir: 'apps/noisysource/domotics/', part: 'domotics' },
    ],
    ownedFiles: {
      'firebase/noisysource/firestore.rules': 'firestore_rules',
      'firebase/noisysource/firestore.indexes.json': 'firestore_indexes',
    },
    consumers: {
      domotics: 'apps/noisysource/domotics/',
      functions: 'firebase/noisysource/functions/',
    },
    everything: [/^firebase\/noisysource\/(firebase\.json|\.firebaserc)$/],
    foreign: [
      /^firebase\.json$/,
      /^\.firebaserc$/,
      /^firestore\.rules$/,
      /^firestore\.indexes\.json$/,
      /^storage\.rules$/,
      /^functions\//,
      /^apps\/noisyphocus\//,
      /^apps\/noisysource\/finances\//,
      // KidClub's Terraform root is this directory itself; this unit's root is
      // the noisysource/ folder inside it.
      /^infra\/gcp\/terraform\/(?!noisysource\/)/,
    ],
  },
};

function unitOf(name) {
  const unit = UNITS[name];
  if (!unit) throw new Error(`unknown unit "${name}" (known: ${Object.keys(UNITS).join(', ')})`);
  return unit;
}

// pnpm-lock.yaml importer -> parts, per unit. '.' (the root package) is
// everything. An importer listed here without an entry for a unit deploys
// nothing in that unit; an importer not listed at all deploys everything.
const IMPORTERS = {
  'apps/noisyphocus/kidclub': { kidclub: ['kidclub'] },
  'apps/noisysource/finances': { kidclub: ['finances'] },
  'apps/noisysource/domotics': { kidclub: ['domotics'], noisysource: ['domotics'] },
  functions: { kidclub: ['functions'] },
  'firebase/noisysource/functions': { noisysource: ['functions'] },
  // shared's own dependencies (zod) get bundled into whoever imports it.
  'packages/shared': 'consumers',
  'apps/noisysource/domotics-bridge': {}, // runs on the Pi, deployed by hand
};

const NOT_DEPLOYED = [
  /\.md$/i,
  /^scripts\//,
  /^mcp\//,
  /^apps\/noisysource\/domotics-bridge\//,
  /^\.claude\//,
  /^\.vscode\//,
  /^\.gitignore$/,
  /^noisysource\.code-workspace$/,
];

const EVERYTHING = [
  /^\.github\//,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
  /^tsconfig(\.[^/]+)?\.json$/,
  /^vite\.config\.base\.ts$/,
  /^tailwind\.config\.[cm]?[jt]s$/,
  /^postcss\.config\.[cm]?[jt]s$/,
];

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /(\.test\.|\.spec\.|\/__tests__\/)/;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function gitShow(rev, file) {
  try {
    return git(['show', `${rev}:${file}`]);
  } catch {
    return null; // file absent at that revision
  }
}

// ---------------------------------------------------------------------------
// pnpm-lock.yaml
//
// A lockfile change can only affect a package's build if that package's own
// resolved dependency tree changed. pnpm writes the lockfile in a fixed shape:
// top-level sections, and inside `importers` / `packages` / `snapshots` one
// entry per two-space-indented key. So:
//   - any change outside those three sections (lockfileVersion, settings,
//     overrides, ...) -> everything;
//   - an *existing* `packages`/`snapshots` entry that changed (a transitive
//     version moved) could be under anyone's tree -> everything;
//   - otherwise only entries were added/removed, and a package whose
//     `importers` entry is unchanged has exactly the same tree as before
//     (every entry it reaches exists unchanged), so only the importers that
//     changed are affected.
// Note (2026-10): CI installs with pnpm 8, which ignores this v9 lockfile
// ("Ignoring not compatible lockfile") and resolves from package.json, so a
// lockfile change has no effect on CI builds today. This stays correct if CI
// moves to pnpm 9+ and starts honouring it.
// ---------------------------------------------------------------------------
function lockSections(text) {
  const top = new Map(); // section -> raw text (for sections compared whole)
  const entries = { importers: new Map(), packages: new Map(), snapshots: new Map() };
  let section = null;
  let entry = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const topKey = /^([^\s#][^:]*):/.exec(line);
    if (topKey) {
      section = topKey[1];
      entry = null;
      top.set(section, (top.get(section) ?? '') + line + '\n');
      continue;
    }
    if (section in entries) {
      // "  key:" or "  key: {}" (v9 writes empty entries inline). Nested
      // lines are indented 4+, so two spaces + non-space is always a new entry.
      const entryKey = /^ {2}(\S.*?):(?: (.*))?$/.exec(line);
      if (entryKey) {
        entry = entryKey[1];
        entries[section].set(entry, (entryKey[2] ?? '') + '\n');
      } else if (entry !== null) {
        entries[section].set(entry, entries[section].get(entry) + line + '\n');
      } else {
        top.set(section, top.get(section) + line + '\n');
      }
    } else {
      top.set(section, (top.get(section) ?? '') + line + '\n');
    }
  }
  return { top, entries };
}

function changedKeys(a, b) {
  const added = [];
  const removed = [];
  const modified = [];
  for (const [k, v] of b) {
    if (!a.has(k)) added.push(k);
    else if (a.get(k) !== v) modified.push(k);
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);
  return { added, removed, modified };
}

export function lockfileParts(baseText, headText, unitName = 'kidclub') {
  const unit = unitOf(unitName);
  if (baseText === null || headText === null) {
    return { everything: 'pnpm-lock.yaml was added or removed' };
  }
  const base = lockSections(baseText);
  const head = lockSections(headText);
  const topNames = new Set([...base.top.keys(), ...head.top.keys()]);
  for (const name of topNames) {
    if (name in base.entries) continue;
    if (base.top.get(name) !== head.top.get(name)) {
      return { everything: `pnpm-lock.yaml: top-level "${name}" changed` };
    }
  }
  for (const name of ['packages', 'snapshots']) {
    const { modified } = changedKeys(base.entries[name], head.entries[name]);
    if (modified.length) {
      return {
        everything: `pnpm-lock.yaml: existing ${name} entr${modified.length === 1 ? 'y' : 'ies'} changed (${modified.slice(0, 3).join(', ')}${modified.length > 3 ? ', ...' : ''}), which could sit under any package`,
      };
    }
  }
  const imp = changedKeys(base.entries.importers, head.entries.importers);
  const importers = [...imp.added, ...imp.removed, ...imp.modified];
  if (importers.length === 0) {
    return { everything: 'pnpm-lock.yaml changed without any workspace package\'s dependencies changing' };
  }
  const parts = new Set();
  for (const importer of importers) {
    if (importer === '.') return { everything: 'pnpm-lock.yaml: the root package\'s dependencies changed' };
    const known = IMPORTERS[importer];
    if (!known) return { everything: `pnpm-lock.yaml: unknown workspace package "${importer}" changed` };
    const mapped = known === 'consumers' ? Object.keys(unit.consumers) : known[unitName] ?? [];
    mapped.forEach((p) => parts.add(p));
  }
  return { parts: [...parts], importers };
}

// ---------------------------------------------------------------------------
// packages/shared import graph
//
// Every source file of a consumer (minus tests) is a root; follow the imports
// that leave the consumer (to packages/shared, mainly) and then every import
// from there on. A changed shared file affects a consumer iff it's reachable.
// Resolution mirrors vite.config.base.ts / tsconfig paths: '@shared' ->
// packages/shared, '@/...' -> the app's own src (never leaves the app).
// A local import that can't be resolved makes that consumer depend on all of
// packages/shared (fail towards deploying, not towards skipping).
// ---------------------------------------------------------------------------
const RESOLVE_EXT = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'];
const INDEX_FILES = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

const IMPORT_RES = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from '...' / export * from '...'
  /\bimport\s*['"]([^'"]+)['"]/g, // import '...'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('...')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('...')
];

function specifiers(source) {
  const out = new Set();
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) out.add(m[1]);
  }
  return out;
}

export class Repo {
  // files: every tracked path at the head commit; readFile: path -> contents.
  constructor(files, readFile) {
    this.files = new Set(files);
    this.readFile = readFile;
    this.cache = new Map();
  }

  static fromWorkingTree(root) {
    const files = git(['ls-files']).split('\n').filter(Boolean);
    return new Repo(files, (file) => {
      const abs = path.join(root, file);
      return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    });
  }

  read(file) {
    if (!this.cache.has(file)) this.cache.set(file, this.readFile(file) ?? '');
    return this.cache.get(file);
  }

  // -> repo-relative file, null for a package import, or {unresolved} for a
  // local import that doesn't point at a tracked file.
  resolve(fromFile, spec) {
    const clean = spec.split('?')[0];
    let target;
    if (clean.startsWith('./') || clean.startsWith('../')) {
      target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
    } else if (clean === '@shared') {
      target = SHARED.slice(0, -1);
    } else if (clean.startsWith('@shared/')) {
      // '@shared/dist/x' is shared's own build output of 'x'.
      target = (SHARED + clean.slice('@shared/'.length)).replace(/\/$/, '').replace(`${SHARED}dist/`, SHARED);
    } else {
      return null; // npm package or an app-internal alias ('@/...')
    }
    const candidates = [];
    for (const ext of RESOLVE_EXT) candidates.push(target + ext);
    if (/\.(m|c)?js$/.test(target)) candidates.push(target.replace(/\.(m|c)?js$/, '.ts'), target.replace(/\.(m|c)?js$/, '.tsx'));
    for (const idx of INDEX_FILES) candidates.push(target + idx);
    for (const c of candidates) if (this.files.has(c)) return c;
    return { unresolved: target };
  }

  // Files outside `dir` that `dir`'s non-test sources can reach.
  reachableFrom(dir) {
    const reached = new Set();
    let wildcard = null;
    const queue = [];
    const visit = (from) => {
      for (const spec of specifiers(this.read(from))) {
        const r = this.resolve(from, spec);
        if (r === null) continue;
        if (typeof r === 'object') {
          if (r.unresolved.startsWith(SHARED) || r.unresolved === SHARED.slice(0, -1)) {
            wildcard ??= `${from} imports '${spec}', which doesn't resolve to a file`;
          }
          continue;
        }
        if (r.startsWith(dir) || reached.has(r)) continue;
        reached.add(r);
        if (SOURCE_EXT.test(r)) queue.push(r);
      }
    };
    for (const f of this.files) {
      if (f.startsWith(dir) && SOURCE_EXT.test(f) && !TEST_FILE.test(f)) visit(f);
    }
    while (queue.length) visit(queue.shift());
    return { reached, wildcard };
  }
}

// ---------------------------------------------------------------------------

export function planFromFiles(changed, { repo, lockfile, unit: unitName = 'kidclub' } = {}) {
  const unit = unitOf(unitName);
  const parts = new Map(unit.parts.map((p) => [p, []])); // part -> reasons
  const ignored = [];
  const foreign = [];
  let everything = null;
  const add = (part, why) => parts.get(part).push(why);
  const sharedChanged = [];

  for (const file of changed) {
    if (NOT_DEPLOYED.some((re) => re.test(file))) {
      ignored.push(file);
      continue;
    }
    if (unit.foreign.some((re) => re.test(file))) {
      foreign.push(file);
      continue;
    }
    if (EVERYTHING.some((re) => re.test(file)) || unit.everything.some((re) => re.test(file))) {
      everything ??= `${file} changed (pipeline, workspace or shared build config)`;
      continue;
    }
    if (file === 'pnpm-lock.yaml') {
      const res = lockfile ? lockfile() : { everything: 'pnpm-lock.yaml changed' };
      if (res.everything) everything ??= res.everything;
      else res.parts.forEach((p) => add(p, `pnpm-lock.yaml (dependencies of ${res.importers.join(', ')})`));
      continue;
    }
    if (unit.ownedFiles[file]) {
      add(unit.ownedFiles[file], file);
      continue;
    }
    const owner = unit.owned.find((o) => file.startsWith(o.dir));
    if (owner) {
      add(owner.part, file);
      continue;
    }
    if (file.startsWith(SHARED)) {
      sharedChanged.push(file);
      continue;
    }
    everything ??= `${file} changed and no rule says what it deploys (safe default)`;
  }

  if (sharedChanged.length && !everything) {
    const code = sharedChanged.filter((f) => SOURCE_EXT.test(f) && repo?.files.has(f));
    const other = sharedChanged.filter((f) => !code.includes(f));
    for (const [consumer, dir] of Object.entries(unit.consumers)) {
      if (other.length) {
        // package.json, tsconfig.json, or a deleted/renamed file: can't trace
        // who used it any more, so assume everyone.
        add(consumer, `${other[0]}${other.length > 1 ? ` (+${other.length - 1} more)` : ''} (not traceable by imports)`);
        continue;
      }
      const { reached, wildcard } = repo.reachableFrom(dir);
      if (wildcard) {
        add(consumer, `packages/shared (${wildcard})`);
        continue;
      }
      const hits = code.filter((f) => reached.has(f));
      if (hits.length) add(consumer, `${hits[0]}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''} (imported)`);
    }
  }

  return { parts, ignored, foreign, everything, sharedChanged: sharedChanged.length > 0 };
}

function render(plan, { disabled, mode, unitName }) {
  const PARTS = unitOf(unitName).parts; // this unit's parts, not the kidclub list above
  const deploy = {};
  for (const p of PARTS) {
    deploy[p] = !disabled.has(p) && (plan.everything !== null || plan.parts.get(p).length > 0);
  }
  const lines = [];
  lines.push(`### Deploy plan: ${unitName} (${mode})`);
  lines.push('');
  if (plan.changedCount !== undefined) lines.push(`${plan.changedCount} changed file(s).`, '');
  if (plan.everything) lines.push(`**Deploying everything:** ${plan.everything}`, '');
  lines.push('| Part | Deploy | Why |', '|---|---|---|');
  for (const p of PARTS) {
    let why;
    if (disabled.has(p)) why = 'off for this environment';
    else if (plan.everything) why = 'everything';
    else if (plan.parts.get(p).length) {
      const r = plan.parts.get(p);
      why = r.slice(0, 3).map((x) => `\`${x}\``).join(', ') + (r.length > 3 ? ` (+${r.length - 3} more)` : '');
    } else why = 'unchanged';
    lines.push(`| ${LABELS[p]} | ${deploy[p] ? 'yes' : 'no'} | ${why} |`);
  }
  if (plan.ignored?.length) {
    lines.push('', `Not deployed by this pipeline (docs, scripts, Pi bridge, ...): ${plan.ignored.length} file(s).`);
  }
  if (plan.foreign?.length) {
    lines.push('', `Belong to another deploy unit, nothing to deploy here: ${plan.foreign.length} file(s).`);
  }
  return { deploy, summary: lines.join('\n') };
}

function main(argv) {
  const unitName = argv.includes('--unit') ? argv[argv.indexOf('--unit') + 1] : 'kidclub';
  const PARTS = unitOf(unitName).parts; // this unit's parts, not the kidclub list above
  const disabled = new Set((process.env.DISABLED_PARTS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const d of disabled) if (!PARTS.includes(d)) throw new Error(`DISABLED_PARTS: unknown part "${d}" for unit ${unitName}`);

  let plan;
  let mode;
  const allIdx = argv.indexOf('--all');
  if (allIdx !== -1) {
    mode = 'full deploy';
    plan = { parts: new Map(PARTS.map((p) => [p, []])), ignored: [], everything: argv[allIdx + 1] || 'full deploy requested', sharedChanged: true };
  } else {
    const base = argv[argv.indexOf('--base') + 1];
    const head = argv[argv.indexOf('--head') + 1];
    if (!argv.includes('--base') || !argv.includes('--head') || !base || !head) {
      throw new Error('usage: deploy-parts.mjs [--unit <unit>] --base <rev> --head <rev> | --all "<why>"');
    }
    mode = `changes ${git(['rev-parse', '--short', base]).trim()}..${git(['rev-parse', '--short', head]).trim()}`;
    // --no-renames: a rename shows as delete + add, so both paths are seen.
    const changed = git(['diff', '--name-only', '--no-renames', base, head]).split('\n').filter(Boolean);
    const repo = Repo.fromWorkingTree(process.cwd());
    plan = planFromFiles(changed, {
      repo,
      unit: unitName,
      lockfile: () => lockfileParts(gitShow(base, 'pnpm-lock.yaml'), gitShow(head, 'pnpm-lock.yaml'), unitName),
    });
    plan.changedCount = changed.length;
  }

  const { deploy, summary } = render(plan, { disabled, mode, unitName });
  const outputs = { ...deploy };
  // packages/shared is compiled whole by the functions predeploy
  // (`pnpm --filter @shared build`), so any change to it gets that build
  // checked in the plan job even when no consumer redeploys.
  outputs.shared_check = plan.sharedChanged || plan.everything !== null;
  outputs.any = PARTS.some((p) => deploy[p]);
  // Whether the plan job needs pnpm + node_modules (anything to build/compile).
  const NO_BUILD = ['terraform', 'firestore_rules', 'firestore_indexes', 'storage_rules'];
  outputs.install = PARTS.some((p) => !NO_BUILD.includes(p) && deploy[p]) || outputs.shared_check;

  console.log(summary);
  console.log('\noutputs: ' + JSON.stringify(outputs));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    // Fail the job rather than guess: a plan that can't be computed must not
    // turn into "deploy nothing".
    console.error(`::error::deploy-parts: ${err.message}`);
    process.exit(1);
  }
}
