// Kit handlers (contract C2, decision public-kit-handlers): a kit may ship
// handlers.json at its root,
//   { format: 1,
//     session: [ { run: "scripts/<file>.mjs", events?: ["startup","resume","compact","clear"], timeout?: 20 } ],
//     prompt:  [ { run, timeout?: 10 } ],
//     tool:    [ { run, phase: "pre"|"post", match?: "Write|Edit|Bash", timeout?: 20 } ],
//     stop:    [ { run, timeout?: 20 } ] }
// and the core's hooks run them (scripts/handlers.mjs). Only installed kits
// run: the kits the core can resolve (its own config/kits, then
// <IA home>/kits/<kit>/<version>/, lib/kit.mjs listKits) whose folder holds
// the script. A fetched release carries no executables, so its handlers never
// run. Each handler runs as `node <script>` with the host's hook JSON on stdin
// and IA_KIT_ROOT, IA_WORKSPACE_ROOT and IA_HOME in its environment; its stdout
// is one JSON value { additionalContext?, decision?: "block"|"allow", reason? }.
// The core merges every handler's additionalContext, at most KIT_CONTEXT_CAP
// characters per kit. A tool `pre` handler's block is honoured only in a
// workspace that opted in through .ia/governance.json; elsewhere it is
// reported, never applied. A kit's onwrite.json stays supported as tool post
// handlers (scripts/on-write.mjs).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { iaHome } from './home.mjs';
import { KitError, listKits } from './kit.mjs';

export const HANDLERS_FORMAT = 1;
export const SESSION_EVENTS = ['startup', 'resume', 'compact', 'clear'];
export const KIT_CONTEXT_CAP = 2000;
export const MAX_TIMEOUT = 25;
const DEFAULT_TIMEOUT = { session: 20, prompt: 10, tool: 20, stop: 20 };
const KINDS = Object.keys(DEFAULT_TIMEOUT);

const plainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);

// The handlers a kit declares, checked: { session, prompt, tool, stop }, each a
// list of { run, timeout, ... }. Without handlers.json every list is empty.
export function kitHandlers(kit) {
  const path = join(kit.dir, 'handlers.json');
  const none = { session: [], prompt: [], tool: [], stop: [] };
  if (!existsSync(path)) return none;
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new KitError(`${path} is not JSON: ${error.message}`); }
  if (!plainObject(parsed) || parsed.format !== HANDLERS_FORMAT) throw new KitError(`${path} is malformed (format ${HANDLERS_FORMAT} with session, prompt, tool and stop lists)`);
  const unknown = Object.keys(parsed).filter(k => k !== 'format' && !KINDS.includes(k));
  if (unknown.length) throw new KitError(`${path}: unknown key ${unknown.join(', ')} (handlers are session, prompt, tool and stop)`);
  const root = resolve(kit.dir);
  const result = { ...none };
  for (const kind of KINDS) {
    if (parsed[kind] === undefined) continue;
    if (!Array.isArray(parsed[kind])) throw new KitError(`${path}: ${kind} is a list`);
    result[kind] = parsed[kind].map((entry, i) => {
      const where = `${path}: ${kind}[${i}]`;
      if (!plainObject(entry)) throw new KitError(`${where} is an object`);
      const run = entry.run;
      const rel = typeof run === 'string' ? relative(root, resolve(root, run)).replace(/\\/g, '/') : '';
      if (typeof run !== 'string' || !/\.mjs$/.test(run) || isAbsolute(run) || /^[A-Za-z]:/.test(run) || rel === '' || rel.startsWith('../') || rel === '..') throw new KitError(`${where}: run is a .mjs script inside the kit, such as scripts/<file>.mjs`);
      if (entry.timeout !== undefined && !(Number.isInteger(entry.timeout) && entry.timeout > 0 && entry.timeout <= MAX_TIMEOUT)) throw new KitError(`${where}: timeout is a whole number of seconds from 1 to ${MAX_TIMEOUT}`);
      const handler = { run: rel, timeout: entry.timeout ?? DEFAULT_TIMEOUT[kind] };
      const allowed = { session: ['run', 'timeout', 'events'], prompt: ['run', 'timeout'], tool: ['run', 'timeout', 'phase', 'match'], stop: ['run', 'timeout'] }[kind];
      const extra = Object.keys(entry).filter(k => !allowed.includes(k));
      if (extra.length) throw new KitError(`${where}: unknown key ${extra.join(', ')}`);
      if (kind === 'session') {
        if (entry.events !== undefined && !(Array.isArray(entry.events) && entry.events.length && entry.events.every(e => SESSION_EVENTS.includes(e)))) throw new KitError(`${where}: events is a non-empty list of ${SESSION_EVENTS.join(', ')}`);
        handler.events = entry.events ?? [...SESSION_EVENTS];
      }
      if (kind === 'tool') {
        if (entry.phase !== 'pre' && entry.phase !== 'post') throw new KitError(`${where}: phase is pre or post`);
        if (entry.match !== undefined) {
          if (typeof entry.match !== 'string' || !entry.match) throw new KitError(`${where}: match is a tool-name pattern such as Write|Edit|Bash`);
          try { new RegExp(`^(?:${entry.match})$`); } catch { throw new KitError(`${where}: match is not a valid pattern`); }
        }
        handler.phase = entry.phase;
        handler.match = entry.match ?? null;
      }
      return handler;
    });
  }
  return result;
}

// The kits whose handlers may run: every installed kit (lib/kit.mjs listKits)
// that ships handlers.json. A kit whose handlers.json is malformed is skipped
// and named in `skipped`, so a hook never fails because of one kit.
export function handlerKits({ kits } = {}) {
  let all = kits;
  if (!all) { try { all = listKits(); } catch { all = []; } }
  const found = [], skipped = [];
  for (const kit of all) {
    if (!existsSync(join(kit.dir, 'handlers.json'))) continue;
    try { found.push({ kit, handlers: kitHandlers(kit) }); } catch (error) { skipped.push({ kit: kit.id, error: error.message }); }
  }
  return { kits: found, skipped };
}

// A handler's script is present when it is a file inside its kit's folder once
// links are followed: a run path is checked inside the kit when it is read,
// and a link must not carry it out.
const scriptPresent = (kit, handler) => {
  try {
    const root = realpathSync(kit.dir);
    const path = realpathSync(join(kit.dir, handler.run));
    const rel = relative(root, path);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    return statSync(path).isFile();
  } catch { return false; }
};

// Does any installed kit declare a governance handler, a tool `pre` handler
// whose script is present? The governance probe asks this
// (lib/account.mjs governanceNotice).
export function declaresGovernance(found = handlerKits().kits) {
  return found.some(({ kit, handlers }) => handlers.tool.some(h => h.phase === 'pre' && scriptPresent(kit, h)));
}

// The handlers one hook event selects, in kit order: [{ kit, handler }].
// event: session (with source), prompt, pre, post or stop; toolName for pre and post.
export function selectHandlers(found, event, { source, toolName } = {}) {
  const picked = [];
  for (const { kit, handlers } of found) {
    let list;
    if (event === 'session') list = handlers.session.filter(h => h.events.includes(source));
    else if (event === 'prompt') list = handlers.prompt;
    else if (event === 'stop') list = handlers.stop;
    else if (event === 'pre' || event === 'post') list = handlers.tool.filter(h => h.phase === event && (h.match === null || new RegExp(`^(?:${h.match})$`).test(toolName ?? '')));
    else list = [];
    for (const handler of list) if (scriptPresent(kit, handler)) picked.push({ kit, handler });
  }
  return picked;
}

// Cuts one kit's merged context to the cap.
export function capContext(text, cap = KIT_CONTEXT_CAP) {
  if (text.length <= cap) return text;
  const marker = ' [truncated]';
  return text.slice(0, cap - marker.length) + marker;
}

// One handler's answer: the last line of its stdout as JSON. Accepts the flat
// contract shape and, for a script written as a hook, hookSpecificOutput.
function answerOf(stdout) {
  let value;
  try { value = JSON.parse(String(stdout ?? '').trim().split('\n').at(-1) || 'null'); } catch { return null; }
  if (!plainObject(value)) return null;
  const context = typeof value.additionalContext === 'string' ? value.additionalContext : (typeof value.hookSpecificOutput?.additionalContext === 'string' ? value.hookSpecificOutput.additionalContext : '');
  const decision = value.decision === 'block' || value.hookSpecificOutput?.permissionDecision === 'deny' ? 'block' : 'allow';
  const reason = typeof value.reason === 'string' ? value.reason : (typeof value.hookSpecificOutput?.permissionDecisionReason === 'string' ? value.hookSpecificOutput.permissionDecisionReason : '');
  return { context: context.trim(), decision, reason: reason.trim() };
}

// Runs the selected handlers for one event. Returns { context, block, ran }:
// context is every kit's merged additionalContext (each prefixed with its kit
// id and capped per kit); block is { kit, reason } when a pre handler blocked in
// a governed workspace, else null. Handlers after a block do not run. The
// whole run stays inside budgetMs.
export function runHandlers(picked, { event, raw = '{}', cwd = process.cwd(), workspace = null, env = process.env, budgetMs = 25_000 } = {}) {
  const started = Date.now();
  const governed = Boolean(workspace && existsSync(join(workspace, '.ia', 'governance.json')));
  let home = '';
  try { home = iaHome(env); } catch { /* a relative IA_HOME reaches no handler */ }
  const byKit = new Map(), ran = [];
  let block = null;
  for (const { kit, handler } of picked) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) { ran.push({ kit: kit.id, run: handler.run, status: 'skipped', reason: 'hook budget spent' }); continue; }
    const child = spawnSync(process.execPath, [join(kit.dir, handler.run)], {
      cwd, input: raw, encoding: 'utf8', timeout: Math.min(handler.timeout * 1000, left), maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: { ...env, IA_KIT_ROOT: kit.dir, IA_WORKSPACE_ROOT: workspace ?? '', IA_HOME: home },
    });
    const answer = child.error || child.status !== 0 ? null : answerOf(child.stdout);
    ran.push({ kit: kit.id, run: handler.run, status: child.error ? 'error' : child.status === 0 ? 'ran' : `exit ${child.status}`, answered: Boolean(answer) });
    if (!answer) continue;
    const parts = byKit.get(kit.id) ?? [];
    if (answer.context) parts.push(answer.context);
    if (event === 'pre' && answer.decision === 'block') {
      if (governed) {
        byKit.set(kit.id, parts);
        block = { kit: kit.id, reason: answer.reason || `${kit.id} blocked this tool call` };
        break;
      }
      parts.push(`(${kit.id} asked to block this tool call${answer.reason ? `: ${answer.reason}` : ''}; not applied, because this workspace has not opted in through .ia/governance.json.)`);
    }
    byKit.set(kit.id, parts);
  }
  const context = [...byKit].filter(([, parts]) => parts.length).map(([id, parts]) => capContext(`${id}: ${parts.join('\n')}`)).join('\n\n');
  return { context, block, ran };
}
