// What a pull request may do to a shared dev project (2026-11-23).
//
// Every open PR into staging deploys to the same dev projects. Before this,
// each one applied its own branch's Terraform and deployed its own branch's
// Cloud Functions, so two PRs that each added something deleted each other's:
// on 2026-11-22/23 the kanban PR's run deleted the website PR's dev hosting
// site and the website PR's run deleted the kanban PR's, and Firebase never
// gives a deleted site's name back. Functions failed the same way, each run
// refusing to delete the other PR's functions.
//
// So, on a pull request:
//   - Terraform applies only what it creates or changes. Anything its plan
//     would delete (or replace) is left alone and named in a warning; only a
//     push to staging (or main) removes things.
//   - Cloud Functions deploys only the functions this branch's code exports,
//     so another PR's functions on dev are never touched.
//
//   node pr-safe.mjs terraform <plan.json>    → JSON { targets, kept }
//   node pr-safe.mjs functions <lib/index.js> [codebase]  → the --only value

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * From `terraform show -json` of a plan: the addresses to apply (created or
 * updated, never deleted or replaced) and the ones a PR must keep.
 */
export const terraformTargets = (plan) => {
  const targets = [];
  const kept = [];
  for (const rc of plan.resource_changes ?? []) {
    const actions = rc.change?.actions ?? [];
    if (actions.includes('delete')) kept.push(rc.address);
    else if (actions.includes('create') || actions.includes('update')) targets.push(rc.address);
  }
  return { targets, kept };
};

/** `--only` for these functions: "functions:a,functions:b", or with a codebase "functions:noisysource:a,…". */
export const functionsOnly = (names, codebase) => {
  const valid = names.filter((n) => /^[A-Za-z][A-Za-z0-9_]*$/.test(n)).sort();
  if (valid.length === 0) throw new Error('no functions exported');
  return valid.map((n) => `functions:${codebase ? `${codebase}:` : ''}${n}`).join(',');
};

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const [, , command, file, codebase] = process.argv;
  if (command === 'terraform' && file) {
    process.stdout.write(JSON.stringify(terraformTargets(JSON.parse(readFileSync(file, 'utf8')))));
  } else if (command === 'functions' && file) {
    const mod = await import(pathToFileURL(file).href);
    // A CommonJS build comes in as `default`, with its exports on it.
    const names = Object.keys(mod.default && typeof mod.default === 'object' ? mod.default : mod).filter((k) => k !== 'default' && k !== '__esModule');
    process.stdout.write(functionsOnly(names, codebase));
  } else {
    process.stderr.write('usage: pr-safe.mjs terraform <plan.json> | functions <lib/index.js> [codebase]\n');
    process.exit(2);
  }
}
