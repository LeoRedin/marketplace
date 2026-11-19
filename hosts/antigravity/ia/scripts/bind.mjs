#!/usr/bin/env node
// The repository's bindings (<repo>/.ia/bindings.json): which kit and
// capability answer each entry point's activity.
//   node scripts/bind.mjs show [<repo>]                                   print the bindings, or { bindings: null }
//   node scripts/bind.mjs set <key> <kit> <capability> [<repo>] [--add]   bind <entry>.<activity> (or <entry>.*); --add keeps the
//                                                                          existing bindings of the key as candidates
//   node scripts/bind.mjs default <entry> <kit> <capability> [<repo>]     the binding an entry falls back to
//   node scripts/bind.mjs precedence <kit...> [--root <repo>]             rank the kits; the first listed wins a conflict
//   node scripts/bind.mjs recommend <kit> [<repo>] [--apply]              the keys the kit recommends (its bindings.json), each
//                                                                          new, already bound so, or kept because the repository
//                                                                          binds it otherwise; --apply writes the new ones only
// <repo> defaults to the IA workspace at or above the working folder. Every
// command prints one JSON value. Exit 0, 1 on a refusal, 2 on bad usage.
import { ENTRIES, readBindings, writeBindings } from './lib/binding.mjs';
import { findKit, kitBindings } from './lib/kit.mjs';
import { findWorkspace, parseArgs, printJson, refuse, UsageError } from './lib/workspace.mjs';

const USAGE = 'usage: bind.mjs show [<repo>] | set <key> <kit> <capability> [<repo>] [--add] [--profile <name>] | default <entry> <kit> <capability> [<repo>] [--profile <name>] | precedence <kit...> [--root <repo>] | recommend <kit> [<repo>] [--apply]\n';
const KEY = new RegExp(`^(?:${ENTRIES.join('|')})\\.(?:[a-z][a-z0-9-]*|\\*)$`);
const same = (a, b) => a.kit === b.kit && a.capability === b.capability && (a.profile ?? null) === (b.profile ?? null);

function workspace(given) {
  const root = findWorkspace(given ?? process.cwd());
  if (!root) throw new UsageError(`${given ?? process.cwd()} is not inside an IA workspace (no .ia/src at or above it)`);
  return root;
}

try {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'show') {
    const { rest } = parseArgs(argv, {}, { positionals: 1 });
    const root = workspace(rest[0]);
    const data = readBindings(root);
    printJson({ root, path: data?.path ?? null, bindings: data ? data.bindings : null, precedence: data?.precedence ?? [], defaults: data?.defaults ?? {} });
  } else if (command === 'set' || command === 'default') {
    const { options, rest } = parseArgs(argv, { add: 'flag', profile: 'value' }, { positionals: 4 });
    if (rest.length < 3) throw new UsageError(USAGE.trim());
    const [key, kit, capability, repo] = rest;
    const root = workspace(repo);
    const data = readBindings(root) ?? { bindings: {}, precedence: [], defaults: {} };
    const binding = { kit, capability, ...(options.profile ? { profile: options.profile } : {}) };
    if (command === 'default') {
      if (!ENTRIES.includes(key)) throw new UsageError(`default needs an entry point (${ENTRIES.join(', ')}), not ${key}`);
      data.defaults[key] = binding;
    } else {
      if (!KEY.test(key)) throw new UsageError(`a key is <entry>.<activity> or <entry>.*, with the entry one of ${ENTRIES.join(', ')}: ${key}`);
      const current = data.bindings[key] ?? [];
      data.bindings[key] = options.add ? [...current.filter(c => !(c.kit === kit && c.capability === capability)), binding] : [binding];
    }
    const path = writeBindings(root, data);
    printJson({ root, path, key, binding, candidates: command === 'default' ? 1 : data.bindings[key].length });
  } else if (command === 'precedence') {
    const { options, rest } = parseArgs(argv, { root: 'value' }, { positionals: 64 });
    if (rest.length === 0) throw new UsageError('precedence needs at least one kit id');
    const root = workspace(options.root);
    const data = readBindings(root) ?? { bindings: {}, precedence: [], defaults: {} };
    data.precedence = [...new Set(rest)];
    const path = writeBindings(root, data);
    printJson({ root, path, precedence: data.precedence });
  } else if (command === 'recommend') {
    // The repository chooses: a key it already binds, to this kit or another, is
    // never overwritten, and precedence is left alone.
    const { options, rest } = parseArgs(argv, { apply: 'flag' }, { positionals: 2 });
    if (rest.length < 1) throw new UsageError(USAGE.trim());
    const kit = findKit(rest[0]);
    const { recommend, unbound, undeclared } = kitBindings(kit);
    const root = options.apply ? workspace(rest[1]) : findWorkspace(rest[1] ?? process.cwd());
    const data = root ? readBindings(root) ?? { bindings: {}, precedence: [], defaults: {} } : null;
    const added = [], already = [], kept = [];
    for (const [key, binding] of Object.entries(recommend)) {
      const current = data?.bindings[key] ?? [];
      if (!current.length) added.push(key);
      else if (current.length === 1 && same(current[0], binding)) already.push(key);
      else kept.push({ key, bound: current });
    }
    let path = null;
    if (options.apply && added.length) {
      for (const key of added) data.bindings[key] = [recommend[key]];
      path = writeBindings(root, data);
    }
    printJson({ root, kit: kit.id, recommend, unbound, undeclared, [options.apply ? 'added' : 'wouldAdd']: added, already, kept, path, applied: Boolean(options.apply) });
  } else {
    throw new UsageError(USAGE.trim());
  }
} catch (error) {
  process.exit(refuse(error));
}
