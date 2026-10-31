#!/usr/bin/env node
// The on-write checks (decisions public-core-hooks and public-kit-handlers):
// a kit's onwrite.json, kept as tool post handlers. scripts/handlers.mjs post
// runs them from the PostToolUse hook; run directly, this script is the same
// check on its own. Read-only, never blocks, and silent unless an installed kit
// (lib/kit.mjs listKits: the plugin's config/kits, then <IA home>/kits)
// declares a check for the file just written. A kit declares them in its
// onwrite.json (lib/kit.mjs kitOnWrite): an entry matches when the file's name ends in one of its
// extensions and, with a marker, that file sits in the written file's folder or
// one of the maxDepth folders above it. A match runs the entry's argv (${NODE},
// ${KIT}, ${PLUGIN}; no shell) with the hook payload on stdin, and the
// additionalContext it answers with is handed back to the session, at most
// 8,000 characters in all. Any error, a timeout or output that is not a hook
// answer is dropped; the hook always exits 0, inside 28 seconds. Only a kit
// lib/trust.mjs trusts runs its commands (decision public-kit-trust); another
// kit's are skipped, and scripts/handlers.mjs says so at session start. Each
// command runs with lib/hygiene.mjs: an allowlisted environment, its process
// tree killed on its deadline, its output capped.
// Reads the hook's stdin JSON ({ cwd, tool_input: { file_path }, ... }); prints
// { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } } or nothing.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, killRunning, runChild } from './lib/hygiene.mjs';
import { kitOnWrite, listKits } from './lib/kit.mjs';
import { kitTrust } from './lib/trust.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
export const MAX_CONTEXT = 8000;
const BUDGET_MS = 25_000;

// The folders from the file's own up to maxDepth above it that hold the marker.
function hasMarker(file, marker, maxDepth) {
  let dir = dirname(file);
  for (let i = 0; i <= maxDepth; i++) {
    if (existsSync(join(dir, marker))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

// The installed kits that ship an onwrite.json: the given list (or listKits())
// filtered, or, given a folder, every subfolder of it that holds one.
export function onWriteKits(kits) {
  if (typeof kits === 'string') return existsSync(kits) ? readdirSync(kits).sort().map(folder => ({ folder, dir: join(kits, folder) })).filter(k => existsSync(join(k.dir, 'onwrite.json'))) : [];
  let all = kits;
  if (!all) { try { all = listKits(); } catch { all = []; } }
  return all.filter(k => existsSync(join(k.dir, 'onwrite.json')));
}

// Every declared entry that matches the written file, in kit order:
// [{ kit: { folder, dir }, entry }]. A kit whose onwrite.json is malformed is skipped.
export function matches(file, kits = onWriteKits()) {
  const lower = file.toLowerCase();
  const found = [];
  for (const kit of typeof kits === 'string' ? onWriteKits(kits) : kits) {
    let entries;
    try { entries = kitOnWrite(kit); } catch { continue; }
    for (const entry of entries) {
      if (!entry.extensions.some(e => lower.endsWith(e))) continue;
      if (entry.marker && !hasMarker(file, entry.marker, entry.maxDepth)) continue;
      found.push({ kit, entry });
    }
  }
  return found;
}

// The installed kits with an onwrite.json whose commands do not run here, with
// why: [{ kit, reason }].
export function untrustedOnWriteKits(kits = onWriteKits()) {
  return kits.map(kit => ({ kit, trust: kitTrust(kit) })).filter(k => !k.trust.trusted).map(({ kit, trust }) => ({ kit, reason: trust.reason }));
}

// Runs each match of a trusted kit with the payload on stdin; resolves the
// joined additionalContext, or ''.
export async function contextFor(payload, raw, { kits = onWriteKits(), budgetMs = BUDGET_MS, env = process.env } = {}) {
  const path = payload?.tool_input?.file_path;
  if (typeof path !== 'string' || !path) return '';
  const cwd = typeof payload.cwd === 'string' && payload.cwd && existsSync(payload.cwd) && statSync(payload.cwd).isDirectory() ? payload.cwd : process.cwd();
  const file = resolve(cwd, path);
  const started = Date.now();
  const parts = [], trusted = new Map();
  for (const { kit, entry } of matches(file, kits)) {
    if (!trusted.has(kit.dir)) trusted.set(kit.dir, kitTrust(kit).trusted);
    if (!trusted.get(kit.dir)) continue;
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) break;
    const places = { NODE: process.execPath, KIT: kit.dir, PLUGIN };
    const argv = entry.argv.map(a => {
      const substituted = a.replace(/\$\{(NODE|KIT|PLUGIN)\}/g, (_, name) => places[name]);
      return substituted === a ? a : normalize(substituted);
    });
    const ran = await runChild({ argv, cwd, input: raw, timeoutMs: Math.min(entry.timeout * 1000, left), env: childEnv(env) });
    if (ran.error || ran.timedOut) continue;
    let answer;
    try { answer = JSON.parse(ran.stdout.trim().split('\n').at(-1) || 'null'); } catch { continue; }
    const text = answer?.hookSpecificOutput?.additionalContext;
    if (typeof text === 'string' && text.trim()) parts.push(text.trim());
  }
  const joined = parts.join('\n\n');
  return joined.length > MAX_CONTEXT ? joined.slice(0, MAX_CONTEXT - 13) + ' [truncated]' : joined;
}

async function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { return; }
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { return; }
  const additionalContext = await contextFor(payload, raw);
  if (additionalContext) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }) + '\n');
}

// Node resolves the module's real path even when a linked plugin root is in argv.
// Resolve both sides so links run the hook and importing it remains side-effect free.
const invokedDirectly = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  const guard = setTimeout(() => { killRunning(); process.exit(0); }, 28_000);
  guard.unref();
  try { await main(); } catch { /* an on-write hook never blocks a session */ }
  process.exit(0);
}
