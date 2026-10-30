#!/usr/bin/env node
// The PostToolUse hook (Write|Edit|MultiEdit, decision public-core-hooks):
// read-only, never blocks, and silent unless a carried kit declares a check for
// the file just written. A kit declares them in its onwrite.json (lib/kit.mjs
// kitOnWrite): an entry matches when the file's name ends in one of its
// extensions and, with a marker, that file sits in the written file's folder or
// one of the maxDepth folders above it. A match runs the entry's argv (${NODE},
// ${KIT}, ${PLUGIN}; no shell) with the hook payload on stdin, and the
// additionalContext it answers with is handed back to the session, at most
// 8,000 characters in all. Any error, a timeout or output that is not a hook
// answer is dropped; the hook always exits 0, inside 28 seconds.
// Reads the hook's stdin JSON ({ cwd, tool_input: { file_path }, ... }); prints
// { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } } or nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitOnWrite, kitsDir } from './lib/kit.mjs';

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

// Every declared entry that matches the written file, in kit-folder order:
// [{ kit: { folder, dir }, entry }]. A kit whose onwrite.json is malformed is skipped.
export function matches(file, dir = kitsDir()) {
  if (!existsSync(dir)) return [];
  const lower = file.toLowerCase();
  const found = [];
  for (const folder of readdirSync(dir).sort()) {
    const kit = { folder, dir: join(dir, folder) };
    if (!existsSync(join(kit.dir, 'onwrite.json'))) continue;
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

// Runs each match with the payload on stdin; returns the joined additionalContext, or ''.
export function contextFor(payload, raw, { dir = kitsDir(), budgetMs = BUDGET_MS } = {}) {
  const path = payload?.tool_input?.file_path;
  if (typeof path !== 'string' || !path) return '';
  const cwd = typeof payload.cwd === 'string' && payload.cwd && existsSync(payload.cwd) && statSync(payload.cwd).isDirectory() ? payload.cwd : process.cwd();
  const file = resolve(cwd, path);
  const started = Date.now();
  const parts = [];
  for (const { kit, entry } of matches(file, dir)) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) break;
    const places = { NODE: process.execPath, KIT: kit.dir, PLUGIN };
    const argv = entry.argv.map(a => {
      const substituted = a.replace(/\$\{(NODE|KIT|PLUGIN)\}/g, (_, name) => places[name]);
      return substituted === a ? a : normalize(substituted);
    });
    const ran = spawnSync(argv[0], argv.slice(1), { cwd, input: raw, encoding: 'utf8', timeout: Math.min(entry.timeout * 1000, left), maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (ran.error || typeof ran.stdout !== 'string') continue;
    let answer;
    try { answer = JSON.parse(ran.stdout.trim().split('\n').at(-1) || 'null'); } catch { continue; }
    const text = answer?.hookSpecificOutput?.additionalContext;
    if (typeof text === 'string' && text.trim()) parts.push(text.trim());
  }
  const joined = parts.join('\n\n');
  return joined.length > MAX_CONTEXT ? joined.slice(0, MAX_CONTEXT - 13) + ' [truncated]' : joined;
}

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { return; }
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { return; }
  const additionalContext = contextFor(payload, raw);
  if (additionalContext) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }) + '\n');
}

// Node resolves the module's real path even when a linked plugin root is in argv.
// Resolve both sides so links run the hook and importing it remains side-effect free.
const invokedDirectly = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  const guard = setTimeout(() => process.exit(0), 28_000);
  guard.unref();
  try { main(); } catch { /* an on-write hook never blocks a session */ }
  process.exit(0);
}
