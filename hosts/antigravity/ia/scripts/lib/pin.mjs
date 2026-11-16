// The task binding (pin): which kit versions and capabilities a task resolved,
// one entry per activity key. It
// belongs to the task, not to one run: two runs of one task share it. It is
// kept under the coordination work root, never in the registry db:
//   <IA home>/work-v1/<project>/<task>/binding.json      the current revision
//   <IA home>/work-v1/<project>/<task>/binding.<n>.json  every earlier revision, kept
// The folder is IA_CORE_RUN_ROOT when set (tests, or a host that knows its
// task folder; the file is binding.json inside it), else the task folder when
// --project and --task are given, else none: a stateless resolve that writes
// nothing. Format 3 (retained implementation bytes):
//   { format: 3, revision, workspace: {root, revision}, task,
//     kits: { <kit id>: {version, archive, sources, implementation, retained} },          one version per kit per task
//     keys: { <entry>.<activity>: {kit, capability, records, scopeKey, intent} },
//     createdAt, supersedes }
// A key the task resolves for the first time joins the pin in a new revision;
// a change writes a new revision whose `supersedes` names the previous one;
// runs and sessions attach to an explicit revision, which the packet's
// binding.revision names. A format 1 pin (one kit and capability) is read as
// format 3 with its one key; legacy execution still requires explicit rebind.
// A pin belongs to one workspace: one read for another root is refused.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { iaHome } from './home.mjs';

export const PIN_FORMAT = 3;

export class PinError extends Error {
  constructor(message, code = 'IA-CORE-PIN', extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The folder that holds the task's binding, or null for a stateless resolve.
export function pinRootFor({ env = process.env, project, task, run, home } = {}) {
  for (const [name, value] of [['project', project], ['task', task], ['run', run]]) {
    if (value !== undefined && !SLUG.test(value)) throw new PinError(`--${name} must be a slug (letters, digits, . _ -): ${value}`, 'IA-CORE-USAGE');
  }
  if (env.IA_CORE_RUN_ROOT) return resolve(env.IA_CORE_RUN_ROOT);
  if (!project && !task) return null;
  if (!project || !task) throw new PinError('a task binding needs --project and --task together (or IA_CORE_RUN_ROOT); --run only names the run that attaches', 'IA-CORE-USAGE');
  return join(home ? join(home, '.ia') : iaHome(env), 'work-v1', project, task);
}

const same = (a, b) => resolve(a).replace(/\\/g, '/').toLowerCase() === resolve(b).replace(/\\/g, '/').toLowerCase();

// A format 1 pin as format 3: its one kit, and its one key from its intent.
function upgrade(pin) {
  const { kit, capability, records, scopeKey, intent, ...rest } = pin;
  const key = `${intent?.entry}.${intent?.activity}`;
  return { ...rest, format: PIN_FORMAT, legacyFormat: 1, kits: { [kit.id]: { version: kit.version, archive: kit.archive ?? null, sources: kit.sources ?? null } }, keys: { [key]: { kit: kit.id, capability, records: records ?? [], scopeKey: scopeKey ?? null, intent: intent ?? null } } };
}

// The current pin in the folder for this workspace, or null. A pin that names
// another workspace root is refused: a task belongs to one repository.
export function readPin(pinRoot, workspaceRoot) {
  if (!pinRoot) return null;
  const path = join(pinRoot, 'binding.json');
  if (!existsSync(path)) return null;
  let pin;
  try { pin = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new PinError(`${path} is not JSON: ${error.message}`, 'IA-CORE-PIN-MALFORMED'); }
  if (pin.format === 1 && pin.workspace?.root && pin.kit?.id && pin.intent?.entry && pin.intent?.activity) pin = upgrade(pin);
  if (pin.format === 2) pin = { ...pin, format: PIN_FORMAT, legacyFormat: 2 };
  const shaped = pin.format === PIN_FORMAT && pin.workspace?.root && pin.kits && typeof pin.kits === 'object' && pin.keys && typeof pin.keys === 'object'
    && Object.values(pin.keys).every(k => k && typeof k.kit === 'string' && typeof k.capability === 'string' && pin.kits[k.kit]);
  if (!shaped) throw new PinError(`${path} is not a format ${PIN_FORMAT} task binding (nor a format 1 one)`, 'IA-CORE-PIN-MALFORMED');
  if (!same(pin.workspace.root, workspaceRoot)) throw new PinError(`${path} binds a task in ${pin.workspace.root}, not in ${workspaceRoot}: a task belongs to one repository; use that repository or another task folder`, 'IA-CORE-RUN-MISMATCH', { pinnedRoot: pin.workspace.root });
  return { ...pin, path };
}

// Writes the next revision; the previous current file is kept as binding.<n>.json.
// record: { workspace, task, kits, keys }.
export function writePin(pinRoot, record, previous) {
  mkdirSync(pinRoot, { recursive: true });
  const path = join(pinRoot, 'binding.json'), lock = join(pinRoot, '.binding.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new PinError('task pin is locked; retry after its writer completes', 'IA-CORE-PIN-CONFLICT');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  const temporary = join(pinRoot, `.binding-${process.pid}-${Date.now()}.tmp`);
  try {
    const currentBytes = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const current = currentBytes ? JSON.parse(currentBytes) : null;
    if ((current?.revision ?? null) !== (previous?.revision ?? null)) throw new PinError('task pin changed during resolution; resolve again against the current revision', 'IA-CORE-PIN-CONFLICT');
    const revision = (previous?.revision ?? 0) + 1;
    const pin = { format: PIN_FORMAT, revision, ...record, createdAt: new Date().toISOString(), supersedes: previous ? previous.revision : null };
    writeFileSync(temporary, JSON.stringify(pin, null, 2) + '\n', { flag: 'wx' });
    if (previous) {
      const history = join(pinRoot, `binding.${previous.revision}.json`);
      if (existsSync(history)) {
        if (readFileSync(history, 'utf8') !== currentBytes) throw new PinError('task pin history already contains different bytes', 'IA-CORE-PIN-CONFLICT');
      } else writeFileSync(history, currentBytes, { flag: 'wx' });
    }
    renameSync(temporary, path);
    return { ...pin, path };
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true });
  }
}

// Is the pinned kit ({version, archive}) the same version as the one now
// available? Returns null when it is, else { pinned, available }.
export function kitUpdate(pinnedKit, available) {
  if (!pinnedKit || !available) return null;
  if (pinnedKit.version === available.version && (pinnedKit.archive ?? null) === (available.archive ?? null)) return null;
  return { pinned: { version: pinnedKit.version, archive: pinnedKit.archive ?? null }, available: { version: available.version, archive: available.archive ?? null } };
}
