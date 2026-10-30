#!/usr/bin/env node
// The SessionStart bootstrap (startup|resume|compact, decision public-core-hooks):
// read-only, never blocks, never fetches. At startup it may first show the
// person two one-line notices (lib/account.mjs): the InventArch account offer
// (once per session, suppressible) and, in a governed repository where no
// installed kit declares governance handlers, that it is governed. After a
// compaction it re-injects the current task pin's summary (pinSummary), so
// the session can resolve the same method again. Outside an IA workspace it says
// nothing else. Inside one it hands the session at
// most 2,500 characters (LIMIT): the workspace identity and revision, the kits
// the repository installed, whether .ia/bindings.json exists and which keys it
// binds, grouped by kit and shortened to fit, and the one instruction to
// resolve before acting, which always fits. Any error exits 0 silently; every
// CLI call is bounded so the whole hook ends inside 10 s.
// Reads the hook's stdin JSON ({ cwd, source, ... }); prints
// { systemMessage?, hookSpecificOutput: { hookEventName, additionalContext } }.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCli, runIa } from './lib/cli.mjs';
import { readBindings } from './lib/binding.mjs';
import { installedKits } from './lib/kit.mjs';
import { accountOffer, governanceNotice } from './lib/account.mjs';
import { findWorkspace } from './lib/workspace.mjs';
import { iaHome } from './lib/home.mjs';
import { readPin } from './lib/pin.mjs';

export const LIMIT = 2500;
const CLI_BUDGET_MS = 7000;

function input() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// The workspace's declared name from its sources, when the CLI cannot be asked.
function declaredWorkspace(root) {
  try {
    const text = readFileSync(join(root, '.ia', 'src', 'workspace.ia'), 'utf8');
    return /^@workspace ([a-z0-9][a-z0-9-]*)/m.exec(text)?.[1] ?? null;
  } catch { return null; }
}

// The bound keys grouped by kit, each kit's activities folded under their
// entry: "inventarch/a-kit: delivery.{design, review}, work.*". A key with
// several candidates appears under each of their kits.
export function boundKeys(bindings) {
  const byKit = new Map();
  for (const [key, candidates] of Object.entries(bindings.bindings)) {
    const [entry, activity] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    for (const { kit } of candidates) {
      const entries = byKit.get(kit) ?? new Map();
      const activities = entries.get(entry) ?? [];
      if (!activities.includes(activity)) entries.set(entry, [...activities, activity]);
      byKit.set(kit, entries);
    }
  }
  return [...byKit].map(([kit, entries]) => `${kit}: ${[...entries].map(([entry, activities]) => (activities.length === 1 ? `${entry}.${activities[0]}` : `${entry}.{${activities.join(', ')}}`)).join(', ')}`).join('; ');
}

// Cuts text to at most max characters at a word boundary, ending in the marker.
function fit(text, max, marker) {
  if (text.length <= max) return text;
  const room = Math.max(0, max - marker.length);
  const cut = text.lastIndexOf(' ', room);
  return text.slice(0, cut > 0 ? cut : room) + marker;
}

export function context(root, env = process.env) {
  const lines = [];
  // The routing instruction comes first: in an adopted workspace, activation starts here, not in the skill listing.
  lines.push('This repository is an InventArch workspace. Before any other skill, plan or action, route requests through the lanes of the ia plugin: reviewing, changing, diagnosing, designing or delivering what this workspace delivers (authoring IA records, host plugins or catalogues, probing what IA admits) -> `ia:delivery`; starting, resuming, coordinating, planning or closing a task, recording a decision or asking what is next -> `ia:work`; finding, explaining or reconciling documents, records, decisions or what this workspace holds, or whether its records can be trusted -> `ia:knowledge`. Each resolves the method this repository binds and delivers it as a packet; each lane entry runs orient, plan, act and learn, and --phase selects one; other skills apply only when that packet asks for them. Unrelated requests need no IA skill.');
  let identity = null, revision = null, cliNote = 'IA CLI not asked';
  try {
    // Only an explicit or installed CLI: the npx fallback could fetch, which a hook must not wait on.
    const cli = resolveCli(root, { env, allowNpx: false });
    const ran = runIa(root, ['position', '--budget', '0', '--depth', '0'], { cli, timeoutMs: CLI_BUDGET_MS });
    if (ran.json?.ok) {
      identity = ran.json.body?.seat?.identity ?? null;
      revision = ran.json.body?.revision ?? null;
      cliNote = `@inventarch/cli ${cli.version ?? 'unknown'} (${cli.source === 'npx' ? 'npx' : cli.source.startsWith('IA_') || cli.source === '--cli' ? 'explicit path' : 'repository install'})`;
    } else cliNote = `ia position refused: ${ran.json?.code ?? 'no output'}`;
  } catch (error) { cliNote = `IA CLI unavailable: ${error.code ?? error.message}${error.code === 'IA-CORE-CLI-MISSING' ? ' (no explicit path and no @inventarch/cli installed in the repository; a hook never fetches one)' : ''}`; }
  const declared = declaredWorkspace(root);
  lines.push(`InventArch workspace at ${root}: ${identity ?? (declared ? `@workspace ${declared} (identity unread)` : 'identity unread')}${revision ? `, revision ${revision.slice(0, 12)}` : ''}; ${cliNote}.`);
  const kits = installedKits(root);
  lines.push(kits.length ? `Kits installed: ${kits.map(k => `${k.id}@${k.version}`).join(', ')}.` : 'Kits installed: none (.ia/distributions.lock.json pins no kit; node "<plugin>/scripts/kit.mjs" list shows what this plugin carries).');
  let bindings = null;
  try { bindings = readBindings(root); } catch (error) { lines.push(`.ia/bindings.json is malformed: ${error.message}`); }
  let bound = null;
  if (bindings) {
    const keys = Object.keys(bindings.bindings).length ? boundKeys(bindings) : 'no keys';
    const defaults = Object.keys(bindings.defaults);
    bound = { head: 'Bindings (.ia/bindings.json): ', keys, rest: `${defaults.length ? `; defaults for ${defaults.join(', ')}` : ''}${bindings.precedence.length ? `; precedence ${bindings.precedence.join(' > ')}` : ''}.` };
  } else if (!existsSync(join(root, '.ia', 'bindings.json'))) lines.push('Bindings: no .ia/bindings.json, so no method is bound; a resolve refuses with IA-CORE-NO-METHOD until kit.mjs bind <kit> --apply writes the keys a kit recommends (kit.mjs list shows the kits).');
  const plugin = (env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL('..', import.meta.url))).replace(/\\/g, '/').replace(/\/+$/, '');
  const resolveLine = `Resolve before acting: node "${plugin}/scripts/resolve.mjs" --entry <work|delivery|knowledge> --activity <activity> [--subject <s>] --json, then follow only the packet it prints (ia:init has the protocol).`;
  // The resolve instruction always survives: what comes before it is cut to the
  // room left, the bound keys first, then the earlier lines.
  const room = LIMIT - resolveLine.length - 1;
  let head = lines.join('\n');
  if (bound) {
    const left = room - head.length - 1 - bound.head.length - bound.rest.length;
    head += `\n${bound.head}${fit(bound.keys, Math.max(0, left), ' ... (truncated; bind.mjs show lists every key)')}${bound.rest}`;
  }
  return `${fit(head, room, '~')}\n${resolveLine}`;
}

export const PIN_LIMIT = 800;
const MAX_PIN_FOLDERS = 2000;

// The current task pin of this workspace: IA_CORE_RUN_ROOT's when set, else
// the most recently written <IA home>/work-v1/<project>/<task>/binding.json
// that names this workspace root. Returns { project, task, pin } or null.
// Bounded: at most MAX_PIN_FOLDERS task folders are looked at.
export function currentPin(root, env = process.env) {
  const read = dir => { try { return readPin(dir, root); } catch { return null; } };
  if (env.IA_CORE_RUN_ROOT) {
    const pin = read(resolve(env.IA_CORE_RUN_ROOT));
    return pin ? { project: null, task: pin.task ?? null, pin } : null;
  }
  let work;
  try { work = join(iaHome(env), 'work-v1'); } catch { return null; }
  if (!existsSync(work)) return null;
  let best = null, seen = 0;
  for (const project of readdirSync(work).sort()) {
    let tasks;
    try { tasks = readdirSync(join(work, project)); } catch { continue; }
    for (const task of tasks.sort()) {
      if (++seen > MAX_PIN_FOLDERS) break;
      const file = join(work, project, task, 'binding.json');
      let mtime;
      try { mtime = statSync(file).mtimeMs; } catch { continue; }
      if (best && mtime <= best.mtime) continue;
      const pin = read(join(work, project, task));
      if (pin) best = { project, task, pin, mtime };
    }
  }
  return best && { project: best.project, task: best.task, pin: best.pin };
}

// The current pin's summary for a compacted session, at most PIN_LIMIT
// characters, or null when the workspace has no pin.
export function pinSummary(root, env = process.env, plugin = null) {
  const found = currentPin(root, env);
  if (!found) return null;
  const { project, task, pin } = found;
  const keys = Object.entries(pin.keys).map(([key, row]) => `${key} -> ${row.kit}@${pin.kits[row.kit]?.version ?? '?'} ${row.capability}`).join('; ');
  const where = project ? `--project ${project} --task ${task}` : 'IA_CORE_RUN_ROOT';
  const again = `If the method's packet was lost in compaction, resolve the same key again for this task: ia_method {key${project ? `, task: "${task}"` : ''}} through the ia door, or node "${plugin ?? '<plugin>'}/scripts/resolve.mjs" --entry <lane> --activity <activity> ${where} --json; the pin keeps the same method.`;
  const head = `Current task pin (${project ? `${project}/${task}` : where}, revision ${pin.revision}): `;
  return fit(head + keys, Math.max(0, PIN_LIMIT - again.length - 1), ' ...') + '\n' + again;
}

// The hook's answer for one SessionStart input, or null to print nothing.
export function payload(hook, env = process.env) {
  const cwd = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd();
  const root = findWorkspace(cwd);
  const offer = accountOffer({ env, source: hook.source, cwd, repo: root });
  const governed = governanceNotice({ env, source: hook.source, root });
  if (!root && !offer && !governed) return null;
  const parts = [];
  if (root) parts.push(context(root, env));
  if (root && hook.source === 'compact') {
    const plugin = (env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL('..', import.meta.url))).replace(/\\/g, '/').replace(/\/+$/, '');
    const pinned = pinSummary(root, env, plugin);
    if (pinned) parts.push(pinned);
  }
  if (governed) parts.push('This repository is governed (.ia/governance.json) and no installed kit declares governance handlers: tell the person before changing anything, and never treat the repository as ungoverned; the ia-governance kit (ia kit add) supplies them.');
  if (offer) parts.push('The person was shown the InventArch account offer once at startup: do not repeat it and do not wait for it.');
  const notice = [governed, offer].filter(Boolean).join('\n');
  return { ...(notice ? { systemMessage: notice } : {}), hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n') } };
}

function main() {
  const answer = payload(input());
  if (answer) process.stdout.write(JSON.stringify(answer) + '\n');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).replace(/\\/g, '/').toLowerCase() === fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase();
if (invokedDirectly) {
  const guard = setTimeout(() => process.exit(0), 10_000);
  guard.unref();
  try { main(); } catch { /* a bootstrap never blocks a session */ }
  process.exit(0);
}
