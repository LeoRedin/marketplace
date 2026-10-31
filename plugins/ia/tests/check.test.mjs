// check.mjs runs only a @check the bound, pinned or named kit declares, with
// its fixed argv; anything else is IA-CORE-CHECK-UNKNOWN. A failing check
// exits 3 with its output; the runner never runs an undeclared name even
// when checks.json lists it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { envFor, fakeCli, makeKit, makeRepo, recordSources, run, sandbox } from './helpers/fixtures.mjs';
import { readRetainedCheckStream } from '../scripts/lib/check-output.mjs';

function world(t) {
  const dir = sandbox(t, 'ia-core-check-');
  const kitsDir = join(dir, 'kits');
  const alpha = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit', capability: 'alpha-review', checks: ['alpha-gate', 'alpha-fail'], undeclaredCheck: 'sneaky' });
  const beta = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit', capability: 'beta-task', checks: ['beta-gate'], profile: null });
  const cli = fakeCli(dir);
  const env = (runRoot) => envFor({ cli, kitsDir, temp: join(dir, 'temp'), runRoot });
  return { dir, kitsDir, alpha, beta, env };
}

const check = (args, env) => run('check.mjs', args, env);

function manifestWorld(t) {
  const state = world(t);
  const repo = makeRepo(join(state.dir, 'repo'));
  const marker = join(repo, 'executed');
  const script = join(state.alpha.dir, 'manifest.mjs');
  writeFileSync(script, "import { writeFileSync } from 'node:fs'; writeFileSync('executed', 'yes'); console.log(JSON.stringify(process.argv.slice(2)));\n");
  const spec = { argv: ['${NODE}', script, '${ARG:manifest}'], arguments: { manifest: 'workspace-file' } };
  const declare = value => { writeFileSync(join(state.alpha.dir, 'checks.json'), JSON.stringify({ format: 1, checks: { 'alpha-gate': value } })); recordSources(state.alpha.dir); };
  declare(spec);
  const invoke = args => check(['alpha-gate', '--root', repo, '--kit', state.alpha.id, ...args], state.env());
  return { ...state, repo, marker, spec, declare, invoke };
}

test('a declared workspace manifest occupies one argv slot, even with spaces and shell metacharacters', t => {
  const { repo, marker, invoke } = manifestWorld(t);
  const name = 'task manifest; echo injected.json';
  writeFileSync(join(repo, name), '{}');
  const result = invoke(['--manifest', name]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.json.stdout), [join(repo, name)]);
  assert.ok(existsSync(marker));
});

test('missing, escaping, non-file and duplicate manifests refuse before the check starts', t => {
  const { repo, dir, marker, invoke } = manifestWorld(t);
  writeFileSync(join(dir, 'outside.json'), '{}');
  mkdirSync(join(repo, 'directory'));
  for (const args of [[], ['--manifest', '../outside.json'], ['--manifest', join(dir, 'outside.json')], ['--manifest', 'C:/outside.json'], ['--manifest', 'directory'], ['--manifest', 'absent.json'], ['--manifest', 'directory/../absent.json'], ['--manifest', 'a\\b.json'], ['--manifest', 'one', '--manifest=two']]) {
    const result = invoke(args);
    assert.equal(result.status, 2, JSON.stringify(args) + result.stdout + result.stderr);
    assert.equal(result.json.error.code, 'IA-CORE-USAGE');
    assert.equal(existsSync(marker), false);
  }
});

test('a symlink or junction in a manifest path refuses before the check starts', t => {
  const { repo, dir, marker, invoke } = manifestWorld(t);
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'manifest.json'), '{}');
  symlinkSync(outside, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = invoke(['--manifest', 'linked/manifest.json']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(existsSync(marker), false);
});

test('caller arguments cannot add an argv slot or choose the executable', t => {
  const { repo, marker, spec, declare, invoke } = manifestWorld(t);
  writeFileSync(join(repo, 'manifest.json'), '{}');
  for (const changed of [
    { ...spec, arguments: [] },
    { ...spec, arguments: { manifest: 'shell' } },
    { ...spec, arguments: { command: 'workspace-file' } },
    { ...spec, argv: ['${ARG:manifest}'] },
    { ...spec, argv: ['${NODE}', '--file=${ARG:manifest}'] },
    { ...spec, argv: ['${NODE}', '${ARG:other}'] },
    { ...spec, argv: ['${NODE}', '-v'] },
  ]) {
    declare(changed);
    const result = invoke(['--manifest', 'manifest.json']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.json.error.code, 'IA-CORE-CHECK-MALFORMED');
    assert.equal(existsSync(marker), false);
  }
  declare({ argv: ['${NODE}', '-v'] });
  assert.equal(invoke(['--manifest', 'manifest.json']).status, 2, 'a fixed check cannot silently ignore a supplied manifest');
});

test('a declared check of the bound kit runs with its fixed argv from the workspace root and reports its output', t => {
  const { dir, alpha, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'delivery.review': { kit: alpha.id, capability: alpha.capability } } } });
  const ok = check(['alpha-gate', '--root', repo], env());
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.json.check, 'alpha-gate');
  assert.equal(ok.json.kit, alpha.id);
  assert.equal(ok.json.record, 'compliance-system/check/gate/alpha-gate');
  assert.deepEqual(ok.json.argv, [process.execPath, join(alpha.dir, 'check-ok.mjs')]);
  assert.equal(ok.json.cwd, repo);
  assert.equal(ok.json.exitCode, 0);
  assert.match(ok.json.stdout, /^check alpha-gate ran in /);
  const failed = check(['alpha-fail', '--root', repo], env());
  assert.equal(failed.status, 3);
  assert.equal(failed.json.exitCode, 4);
  assert.match(failed.json.stderr, /check failed/);
  assert.equal(failed.json.output.complete, true, 'complete output is not a successful check');
});

test('an undeclared check is refused with IA-CORE-CHECK-UNKNOWN and the declared candidates, even when checks.json lists it', t => {
  const { dir, alpha, beta, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'delivery.review': { kit: alpha.id, capability: alpha.capability } } } });
  for (const name of ['nope', 'sneaky', 'beta-gate']) {
    const refused = check([name, '--root', repo], env());
    assert.equal(refused.status, 1, name);
    assert.equal(refused.json.error.code, 'IA-CORE-CHECK-UNKNOWN');
    assert.deepEqual(refused.json.error.candidates, [`${alpha.id}#alpha-gate`, `${alpha.id}#alpha-fail`]);
  }
  // Naming the other kit admits its check; naming an unknown kit refuses.
  assert.equal(check(['beta-gate', '--root', repo, '--kit', beta.id], env()).status, 0);
  assert.equal(check(['alpha-gate', '--root', repo, '--kit', beta.id], env()).json.error.code, 'IA-CORE-CHECK-UNKNOWN');
  assert.equal(check(['alpha-gate', '--root', repo, '--kit', 'inventarch/none-kit'], env()).json.error.code, 'IA-CORE-KIT-UNKNOWN');
  assert.equal(check(['Bad Name', '--root', repo], env()).status, 2);
  assert.equal(check([], env()).status, 2);
  assert.equal(check(['alpha-gate', '--root', join(dir, 'temp')], env()).json.error.code, 'IA-CORE-NO-WORKSPACE');
});

test('the pinned kit decides which checks run; an unbound repository with no pin and no installed kit declares none', t => {
  const { dir, alpha, beta, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'work.task': { kit: beta.id, capability: beta.capability } } } });
  const taskRoot = join(dir, 'work', 'proj', 'task-1');
  assert.equal(run('resolve.mjs', ['--entry', 'work', '--activity', 'task', '--root', repo], env(taskRoot)).status, 0);
  // Bound to beta, pinned to beta: alpha's check is unknown here, beta's runs.
  assert.equal(check(['alpha-gate', '--root', repo], env(taskRoot)).json.error.code, 'IA-CORE-CHECK-UNKNOWN');
  assert.equal(check(['beta-gate', '--root', repo], env(taskRoot)).status, 0);
  const bare = makeRepo(join(dir, 'bare'));
  const none = check(['alpha-gate', '--root', bare], env());
  assert.equal(none.json.error.code, 'IA-CORE-CHECK-UNKNOWN');
  assert.deepEqual(none.json.error.candidates, []);
  const installed = makeRepo(join(dir, 'installed'), { lock: { engine: '0.1.0', formatVersion: 1, packages: [{ id: alpha.id, version: '0.1.0', archive: alpha.archive }] } });
  assert.equal(check(['alpha-gate', '--root', installed], env()).status, 0, 'an installed kit declares its checks');
});

test('a check runs under its declared timeout, in seconds: a slower command is killed', t => {
  const { dir, alpha, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'delivery.review': { kit: alpha.id, capability: alpha.capability } } } });
  writeFileSync(join(alpha.dir, 'checks.json'), JSON.stringify({ format: 1, checks: { 'alpha-gate': { argv: ['${NODE}', '-e', 'setTimeout(() => {}, 30000)'], timeout: 1 } } }));
  recordSources(alpha.dir);
  const started = Date.now();
  const slow = check(['alpha-gate', '--root', repo], env());
  assert.ok(Date.now() - started < 20000, 'the runner waited for the whole command');
  assert.equal(slow.status, 3);
  assert.equal(slow.json.timedOut, true);
  assert.equal(slow.json.output.complete, false, 'interrupted output cannot establish complete verification');
});

test('ordinary checker retains early skips and exact full output while preserving inline tails', t => {
  const { dir, alpha, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'));
  const stdout = 'SKIPPED_REQUIRED_SUITE: unavailable\n' + 'é'.repeat(6000) + '\nEND_OK\n';
  const stderr = 'EARLY_STDERR\n' + 'y'.repeat(3000);
  writeFileSync(join(alpha.dir, 'check-ok.mjs'), `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`);
  const result = check(['alpha-gate', '--root', repo, '--kit', alpha.id], env());
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.qualification, 'execution-evidence-only');
  assert.equal(result.json.output.complete, true);
  assert.equal(result.json.stdout, stdout.slice(-4000));
  assert.equal(result.json.stderr, stderr.slice(-2000));
  assert.doesNotMatch(result.json.stdout, /SKIPPED_REQUIRED_SUITE/);
  for (const [name, text] of Object.entries({ stdout, stderr })) {
    const evidence = result.json.output[name];
    const bytes = readFileSync(evidence.path);
    assert.equal(bytes.toString('utf8'), text);
    assert.equal(evidence.bytes, Buffer.byteLength(text));
    assert.equal(evidence.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(evidence.tailTruncated, true);
    assert.equal(evidence.path, join(result.json.output.directory, `${name}.bin`));
  }
  const again = check(['alpha-gate', '--root', repo, '--kit', alpha.id], env());
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.notEqual(again.json.output.directory, result.json.output.directory, 'a run never overwrites prior logs');
});

test('ordinary checker output overflow cannot claim a pass even for a child intending exit zero', t => {
  const { dir, alpha, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'));
  writeFileSync(join(alpha.dir, 'check-ok.mjs'), 'process.stdout.write("x".repeat(64 * 1024 * 1024 + 1));');
  const result = check(['alpha-gate', '--root', repo, '--kit', alpha.id], env());
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.json.outputLimitExceeded, true);
  assert.equal(result.json.output.complete, false);
  assert.ok(result.json.output.stdout.bytes <= result.json.output.limitBytesPerStream);
  const bytes = readFileSync(result.json.output.stdout.path);
  assert.equal(bytes.length, result.json.output.stdout.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.json.output.stdout.sha256);
});

test('ordinary checker canonicalizes the default OS temp alias before selecting its output parent', t => {
  const { dir, alpha, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'));
  const target = join(dir, 'actual-temp'), alias = join(dir, 'alias-temp');
  mkdirSync(target);
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const marker = join(repo, 'executed');
  writeFileSync(join(alpha.dir, 'check-ok.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("executed", "yes");');
  const result = check(['alpha-gate', '--root', repo, '--kit', alpha.id], { ...env(), TMP: alias, TEMP: alias, TMPDIR: alias });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.output.complete, true);
  assert.equal(dirname(result.json.output.directory), target);
  assert.equal(existsSync(marker), true);
});

test('ordinary checker evidence reader refuses a created artifact directory replaced with an alias', t => {
  const { dir, alpha, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'));
  const result = check(['alpha-gate', '--root', repo, '--kit', alpha.id], env());
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const directory = result.json.output.directory;
  const artifact = { ...result.json.output.stdout, name: 'stdout.bin' };
  assert.equal(readRetainedCheckStream(directory, artifact).tail, result.json.stdout);
  // Handles have closed, so this works on Windows too. The same reader is used
  // before check.mjs reports execution evidence; it never follows this alias.
  renameSync(directory, directory + '-moved');
  symlinkSync(directory + '-moved', directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readRetainedCheckStream(directory, artifact), error => error.code === 'IA-CORE-CHECK-OUTPUT');
});

test('a check named like a member every object inherits is never run: constructor is IA-CORE-CHECK-UNKNOWN, and the names outside the check-name grammar are usage errors', t => {
  const { dir, alpha, env } = world(t);
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'delivery.review': { kit: alpha.id, capability: alpha.capability } } } });
  for (const args of [['constructor', '--root', repo], ['constructor', '--root', repo, '--kit', alpha.id]]) {
    const refused = check(args, env());
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.equal(refused.json.error.code, 'IA-CORE-CHECK-UNKNOWN');
    assert.deepEqual(refused.json.error.candidates, [`${alpha.id}#alpha-gate`, `${alpha.id}#alpha-fail`]);
  }
  // Lowercase letters, digits and hyphens only: these never reach the lookup.
  for (const name of ['__proto__', 'toString', 'hasOwnProperty']) {
    const bad = check([name, '--root', repo], env());
    assert.equal(bad.status, 2, name);
    assert.equal(bad.json.error.code, 'IA-CORE-USAGE', name);
  }
});
