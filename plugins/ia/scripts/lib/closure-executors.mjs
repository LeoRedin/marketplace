// Reviewed execution profiles are shipped with the producer, never accepted
// from qualification input. Exact byte pins replace guesses about arbitrary
// JavaScript import graphs. Updating a program requires a fresh profile review.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalMethod, methodDigest, methodError, safeMethodPath } from './method-json.mjs';

const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
const profilesPath = new URL('../../config/qualified-executors.json', import.meta.url);
const fail = message => { throw methodError(message, 'IA-CORE-CLOSURE-UNSUPPORTED'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_FILE = 16 * 1024 * 1024;
const capturedInputs = new WeakMap();

function regularFile(root, path, limit = MAX_FILE) {
  if (!safeMethodPath(path)) fail('Unsafe executor path');
  let at = resolve(root);
  // Check ancestors too: a regular leaf does not prove a regular containment.
  for (let parent = at; ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Executor root is aliased');
    if (dirname(parent) === parent) break;
  }
  for (const component of path.split('/')) {
    at = join(at, component);
    if (lstatSync(at).isSymbolicLink()) fail('Executor path is aliased');
  }
  const stat = lstatSync(at);
  if (!stat.isFile() || stat.size > limit) fail('Executor input is not bounded regular text');
  const fd = openSync(at, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > limit) fail('Executor input changed while opening');
    const chunks = []; let total = 0;
    const deadline = Date.now() + 5000;
    for (;;) {
      if (Date.now() > deadline) fail('Executor input read timed out');
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > limit) fail('Executor input exceeded its limit');
      chunks.push(chunk.subarray(0, count));
    }
    const after = fstatSync(fd), named = lstatSync(at);
    if (!named.isFile() || named.isSymbolicLink() || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || named.dev !== opened.dev || named.ino !== opened.ino || realpathSync(at) !== at) fail('Executor input changed while reading');
    return { path: at, bytes: Buffer.concat(chunks, total) };
  } finally { closeSync(fd); }
}

export function executorProfile(id) {
  const document = JSON.parse(readFileSync(profilesPath, 'utf8'));
  if (document.format !== 'inventarch.executor-profiles/1' || !Object.hasOwn(document.profiles, id ?? '')) fail('Executor inventory analysis is not supported: unknown reviewed profile');
  const profile = document.profiles[id];
  return { ...profile, id, sha256: methodDigest(profile) };
}

export function validateExecutor(check) {
  if (!Number.isInteger(check.timeoutSeconds) || check.timeoutSeconds < 1 || check.timeoutSeconds > 600) fail('Check timeout exceeds bounds');
  if (check.executable === 'native-cli') {
    const accepted = [['validate', '--json'], ['validate', '--severity', 'error', '--json'], ['validate']];
    if (check.script !== null || check.cwd !== 'workspace' || check.argumentSchema !== null || !accepted.some(argv => canonicalMethod(argv) === canonicalMethod(check.argv))) fail('Executor is outside the qualified native validation profile');
    return;
  }
  if (check.executable !== 'node') fail('Unsupported executor');
  const profile = executorProfile(check.profile);
  if (check.id !== profile.check || check.profileSha256 !== profile.sha256 || check.script !== `plugin/${profile.script}` || check.cwd !== profile.cwd || canonicalMethod(check.argv) !== canonicalMethod(profile.argv.slice(2)) || canonicalMethod(check.argumentSchema) !== canonicalMethod(profile.arguments ?? null)) fail('Executor differs from its reviewed profile');
  if (canonicalMethod(check.dependencies) !== canonicalMethod(profile.modules.map(row => ({ path: `plugin/${row.path}`, sha256: row.sha256 })))) fail('Executor dependency inventory differs');
}

export function validateExecutorNative(check, record) {
  validateExecutor(check);
  if (record?.identity !== check.record || record?.discriminator !== 'check' || record?.name !== check.id) fail('Runner/native-check identity differs');
  if (check.executable !== 'node') return;
  const profile = executorProfile(check.profile);
  if (profile.nativeScope !== undefined) {
    const value = record.sections?.find(row => row.name === 'check')?.fields?.find(row => row.key === 'scope')?.value;
    if (value?.kind !== 'string' || value.text !== profile.nativeScope) fail('Native check scope differs from reviewed invocation');
  }
}

// A handle attests only a private byte capture, never source provenance or a
// successful judgment. It cannot be reconstructed from request JSON. The
// reviewed profile must explicitly admit this argument's envelope format.
export function captureExecutorInput({ profile: id, argument, bytes }) {
  const profile = executorProfile(id), format = profile.capturedArguments?.[argument];
  const limit = profile.inputLimitBytes ?? MAX_FILE;
  if (typeof format !== 'string' || profile.arguments?.[argument] !== 'workspace-file') fail('Profile does not admit captured input');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FILE || !Buffer.isBuffer(bytes) || bytes.length > limit) fail('Captured input exceeds reviewed bound');
  const copy = Buffer.from(bytes);
  let value;
  try { value = JSON.parse(copy.toString('utf8')); } catch { fail('Captured input must be a JSON envelope'); }
  if (!Buffer.from(copy.toString('utf8')).equals(copy) || value?.format !== format) fail('Captured input envelope differs from profile');
  const handle = Object.freeze({ format: 'inventarch.executor-input/1', profile: id, profileSha256: profile.sha256, argument, envelopeFormat: format, bytes: copy.length, sha256: hash(copy) });
  capturedInputs.set(handle, copy);
  return handle;
}

export function qualifyNodeExecutor({ name, record, nativeRecord, runner, contract, kitRoot, payloadRoot }) {
  const profile = executorProfile(contract.profile);
  if (profile.check !== name || canonicalMethod(runner.argv) !== canonicalMethod(profile.argv) || runner.cwd !== profile.cwd || canonicalMethod(runner.arguments ?? null) !== canonicalMethod(profile.arguments ?? null)) fail('Runner does not match its reviewed invocation');
  const kitPrefix = `config/kits/${profile.kit}/`;
  for (const module of profile.modules) {
    const fromKit = module.path.startsWith(kitPrefix);
    const source = regularFile(fromKit ? kitRoot : pluginRoot, fromKit ? module.path.slice(kitPrefix.length) : module.path);
    const bytes = Buffer.from(source.bytes.toString('utf8').replace(/\r\n?/g, '\n'));
    if (hash(bytes) !== module.sha256) fail(`Reviewed executor bytes differ: ${module.path}`);
    const target = join(payloadRoot, 'plugin', module.path);
    mkdirSync(dirname(target), { recursive: true });
    // Kit modules already exist in the mirrored execution tree. Helpers don't.
    try { writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST' || hash(readFileSync(target)) !== module.sha256) throw error; }
  }
  const check = { id: name, record, executable: 'node', profile: profile.id, profileSha256: profile.sha256,
    script: `plugin/${profile.script}`, argv: profile.argv.slice(2), cwd: profile.cwd,
    timeoutSeconds: contract.timeoutSeconds, argumentSchema: profile.arguments ?? null,
    dependencies: profile.modules.map(row => ({ path: `plugin/${row.path}`, sha256: row.sha256 })) };
  validateExecutorNative(check, nativeRecord);
  return check;
}

export function executorFileRoles(checks) {
  const roles = new Map();
  for (const check of checks.filter(row => row.executable === 'node')) {
    for (const dependency of check.dependencies) if (!roles.has(dependency.path)) roles.set(dependency.path, 'helper');
    roles.set(check.script, 'runner');
  }
  return roles;
}

// Workspace files are inputs, not code. Pass a private captured copy to the
// runner, retaining the original path/hash in the receipt and rechecking after.
export function prepareExecutor({ check, closure, workspaceRoot, inputRoot = workspaceRoot, cli, arguments: supplied, directory }) {
  validateExecutor(check);
  if (!supplied || Array.isArray(supplied) || typeof supplied !== 'object') fail('Check arguments must be an object');
  const schema = check.argumentSchema ?? {};
  if (canonicalMethod(Object.keys(supplied).sort()) !== canonicalMethod(Object.keys(schema).sort())) fail('Arguments do not match the reviewed schema');
  const selectedProfile = check.executable === 'node' ? executorProfile(check.profile) : null;
  const inputLimit = selectedProfile?.inputLimitBytes ?? MAX_FILE;
  if (!Number.isInteger(inputLimit) || inputLimit < 1 || inputLimit > MAX_FILE) fail('Invalid reviewed input limit');
  const subjects = [], replacements = {};
  for (const [name, kind] of Object.entries(schema)) {
    if (kind !== 'workspace-file') fail('Unsupported argument type');
    const handle = supplied[name];
    const captured = handle && typeof handle === 'object' ? capturedInputs.get(handle) : null;
    if (handle && typeof handle === 'object' && (!captured || handle.profile !== check.profile || handle.profileSha256 !== selectedProfile?.sha256 || handle.argument !== name || handle.envelopeFormat !== selectedProfile?.capturedArguments?.[name])) fail('Captured input handle is not authentic for this profile');
    const input = captured ? { bytes: captured } : regularFile(inputRoot, handle, inputLimit);
    const copy = join(directory, `input-${name}.bin`);
    writeFileSync(copy, input.bytes, { flag: 'wx', mode: 0o600 });
    replacements[`\${ARG:${name}}`] = copy;
    subjects.push({ argument: name, path: captured ? null : handle, bytes: input.bytes.length, sha256: hash(input.bytes), ...(captured ? { source: 'supervisor-capture', envelopeFormat: handle.envelopeFormat } : {}) });
  }
  if (check.executable === 'native-cli') return { argv: [...cli.argv, ...check.argv, '--root', workspaceRoot], cwd: workspaceRoot, subjects, scriptHelperDigests: [] };
  const profile = executorProfile(check.profile);
  const kitRoot = join(closure.root, 'plugin', 'config', 'kits', profile.kit);
  const expand = token => {
    if (Object.hasOwn(replacements, token)) return [replacements[token]];
    if (token === '${IA}') return cli.argv;
    if (token === '${WORKSPACE}') return [workspaceRoot];
    if (token.startsWith('${KIT}/') && safeMethodPath(token.slice(7))) return [join(kitRoot, token.slice(7))];
    if (token.includes('${')) fail('Unsupported executor token');
    return [token];
  };
  for (const row of check.dependencies) if (hash(regularFile(closure.root, row.path).bytes) !== row.sha256) fail('Retained executor dependency differs');
  return { argv: [process.execPath, join(closure.root, check.script), ...check.argv.flatMap(expand)],
    cwd: check.cwd === 'kit' ? kitRoot : check.cwd === 'plugin' ? join(closure.root, 'plugin') : realpathSync(workspaceRoot),
    subjects, scriptHelperDigests: check.dependencies };
}

export function executorSubjectsChanged(workspaceRoot, subjects, directory) {
  return subjects.some(row => {
    try {
      if (row.source === 'supervisor-capture') {
        if (!directory || row.path !== null || !/^[a-z][a-z0-9_-]*$/.test(row.argument)) return true;
        return hash(regularFile(directory, `input-${row.argument}.bin`).bytes) !== row.sha256;
      }
      const input = regularFile(workspaceRoot, row.path);
      return hash(input.bytes) !== row.sha256 || directory !== undefined && hash(regularFile(directory, `input-${row.argument}.bin`).bytes) !== row.sha256;
    }
    catch { return true; }
  });
}
