#!/usr/bin/env node
// The kit handler hooks (decisions public-kit-handlers, public-core-hooks and
// public-kit-trust):
//   node scripts/handlers.mjs session   SessionStart, every source
//   node scripts/handlers.mjs prompt    UserPromptSubmit
//   node scripts/handlers.mjs pre       PreToolUse
//   node scripts/handlers.mjs post      PostToolUse (also the kits' onwrite.json checks)
//   node scripts/handlers.mjs stop      Stop
// Each reads the hook's stdin JSON, runs the handlers installed kits declare
// for that event (lib/handlers.mjs) and prints one hook answer, or nothing.
// When no installed kit declares a handler for the event it exits at once,
// silent. Only trusted kits run code (lib/trust.mjs); at session start the
// answer names, once per kit, each installed kit whose handler or on-write
// code does not run, and why. A `pre` block is applied only in a workspace
// with .ia/governance.json. Any error exits 0 silently: these hooks never fail
// a session, and each stays inside its budget (BUDGET_MS, under the hook's own
// timeout); a governed gate still running when the budget ends refuses the
// call.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gate, handlerKits, runHandlers, selectHandlers, untrustedHandlerKits } from './lib/handlers.mjs';
import { killRunning } from './lib/hygiene.mjs';
import { trustNote } from './lib/trust.mjs';
import { findWorkspace } from './lib/workspace.mjs';
import { contextFor, MAX_CONTEXT, onWriteKits, untrustedOnWriteKits } from './on-write.mjs';

export const EVENTS = { session: 'SessionStart', prompt: 'UserPromptSubmit', pre: 'PreToolUse', post: 'PostToolUse', stop: 'Stop' };
export const BUDGET_MS = { session: 55_000, prompt: 25_000, pre: 25_000, post: 55_000, stop: 25_000 };

// The session-start notes: one line per installed kit whose code does not run.
function trustNotes(found, kits) {
  const byKit = new Map();
  for (const { kit, reason } of untrustedHandlerKits(found)) byKit.set(kit.id, { kit, reason, what: ['its handlers'] });
  for (const { kit, reason } of untrustedOnWriteKits(onWriteKits(kits))) {
    const seen = byKit.get(kit.id);
    if (seen) seen.what.push('its on-write checks'); else byKit.set(kit.id, { kit, reason, what: ['its on-write checks'] });
  }
  return [...byKit.values()].map(({ kit, reason, what }) => trustNote(kit, { reason }, what.join(' and ')));
}

// The hook answer for one event and its stdin text, or null to print nothing.
export async function answer(event, raw, { env = process.env, kits } = {}) {
  const hookEvent = EVENTS[event];
  if (!hookEvent) return null;
  const found = handlerKits({ kits }).kits;
  const writes = event === 'post' ? onWriteKits(kits) : [];
  if (!found.length && !writes.length && !(event === 'session' && onWriteKits(kits).length)) return null; // the fast no-op
  let hook;
  try { hook = JSON.parse(raw || '{}'); } catch { return null; }
  if (event === 'stop' && hook.stop_hook_active === true) return null; // never keep a session going twice
  const picked = selectHandlers(found, event, { source: hook.source, toolName: hook.tool_name });
  const cwd = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd();
  const workspace = findWorkspace(cwd);
  const parts = [];
  const started = Date.now();
  let block = null;
  if (event === 'session') parts.push(...trustNotes(found, kits));
  if (writes.length) {
    const checks = await contextFor(hook, raw, { kits: writes, budgetMs: 25_000, env });
    if (checks) parts.push(checks.length > MAX_CONTEXT ? checks.slice(0, MAX_CONTEXT) : checks);
  }
  if (picked.length) {
    const result = await runHandlers(picked, { event, raw, cwd, workspace, env, budgetMs: BUDGET_MS[event] - (Date.now() - started) });
    if (result.context) parts.push(result.context);
    block = result.block;
  }
  const additionalContext = parts.join('\n\n');
  if (block) return { hookSpecificOutput: { hookEventName: hookEvent, permissionDecision: 'deny', permissionDecisionReason: `${block.kit}: ${block.reason}`, ...(additionalContext ? { additionalContext } : {}) } };
  if (!additionalContext) return null;
  return { hookSpecificOutput: { hookEventName: hookEvent, additionalContext } };
}

async function main() {
  const event = process.argv[2];
  if (!EVENTS[event]) return;
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { return; }
  const result = await answer(event, raw);
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  const event = process.argv[2];
  const guard = setTimeout(() => {
    // Out of budget: stop every child first. A governed gate that has not answered refuses the call, never allows it.
    const kit = gate.kit;
    killRunning();
    if (event === 'pre' && kit) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${kit}: its pre-tool handler did not answer within the hook's budget, so the call is refused (fail closed)` } }) + '\n');
    process.exit(0);
  }, (BUDGET_MS[event] ?? 25_000) + 3_000);
  guard.unref();
  try { await main(); } catch { /* a kit handler hook never blocks a session by failing */ }
  process.exit(0);
}
