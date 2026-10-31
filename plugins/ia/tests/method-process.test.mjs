import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeMethodProcess, killProcessGroup } from '../scripts/lib/method-process.mjs';

test('bounded runner keeps exact output and refuses output overflow', async () => {
  for (const overflow of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'method-output-'));
    try {
      const result = await executeMethodProcess({ argv: [process.execPath, '-e', `process.stdout.write('x'.repeat(${overflow ? 65536 : 16}))`], cwd: directory, directory, timeoutSeconds: 5, outputLimit: 1024, env: process.env });
      assert.equal(result.outputLimitExceeded, overflow);
      assert.ok(result.artifacts.every(row => row.bytes <= 1024));
      assert.equal(result.descendantsTerminated, false);
      if (!overflow) { assert.equal(result.exitCode, 0); assert.equal(readFileSync(join(directory, 'stdout.bin'), 'utf8'), 'x'.repeat(16)); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('timeout terminates a runner and its native-style child process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'method-tree-'));
  try {
    const entry = join(directory, 'runner.mjs');
    writeFileSync(entry, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
      writeFileSync('child.pid',String(child.pid)); setInterval(()=>{},1000);`);
    const start = Date.now();
    const result = await executeMethodProcess({ argv: [process.execPath, entry], cwd: directory, directory, timeoutSeconds: 2, env: process.env });
    assert.equal(result.timedOut, true);
    assert.equal(result.terminationFailed, false);
    assert.ok(Date.now() - start < 10000);
    assert.ok(existsSync(join(directory, 'child.pid')));
    const pid = Number(readFileSync(join(directory, 'child.pid'), 'utf8'));
    // Windows reports ESRCH for a terminated child. POSIX may retain a zombie
    // briefly; process-group kill is additionally exercised by closed pipes.
    if (process.platform === 'win32') assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    // Windows can hold the killed tree's working directory for a moment after it exits.
  } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});

test('root-exit cleanup reports the live descendant whose later output it drops', { skip: process.platform === 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'method-late-'));
  try {
    const entry = join(directory, 'runner.mjs');
    writeFileSync(entry, `import {spawn} from 'node:child_process';
      spawn(process.execPath,['-e','setTimeout(()=>process.stdout.write("late"),500);setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']}).unref();
      process.stdout.write('early');`);
    const result = await executeMethodProcess({ argv: [process.execPath, entry], cwd: directory, directory, timeoutSeconds: 5, env: process.env });
    assert.deepEqual([result.exitCode, result.timedOut, result.terminationFailed, result.descendantsTerminated], [0, false, false, true]);
    assert.equal(readFileSync(join(directory, 'stdout.bin'), 'utf8'), 'early');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('group kill retries macOS zombie EPERM and fails only on a lasting or other refusal', async () => {
  const refuse = code => { throw Object.assign(new Error(code), { code }); };
  let calls = 0;
  // Zombies reaped: EPERM then ESRCH is a gone group, not a termination failure.
  assert.equal(await killProcessGroup(7, { kill: (pid, signal) => { assert.deepEqual([pid, signal], [-7, 'SIGKILL']); refuse(++calls < 3 ? 'EPERM' : 'ESRCH'); } }), false);
  assert.equal(calls, 3);
  calls = 0;
  assert.equal(await killProcessGroup(7, { kill: () => { if (++calls < 2) refuse('EPERM'); } }), true);
  const start = Date.now();
  await assert.rejects(killProcessGroup(7, { kill: () => refuse('EPERM'), capMs: 100 }), { code: 'EPERM' });
  assert.ok(Date.now() - start >= 100);
  await assert.rejects(killProcessGroup(7, { kill: () => refuse('EINVAL') }), { code: 'EINVAL' });
});

test('Windows ambient SystemRoot cannot substitute an unqualified supervisor', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'method-supervisor-')), previous = process.env.SystemRoot;
  try {
    mkdirSync(join(directory, 'System32'));
    writeFileSync(join(directory, 'System32/taskkill.exe'), 'unqualified executable');
    process.env.SystemRoot = directory;
    await assert.rejects(executeMethodProcess({ argv: [process.execPath, '-e', "require('fs').writeFileSync('started','bad')"], cwd: directory, directory, timeoutSeconds: 1, env: process.env }), /Unqualified Windows process supervisor/);
    assert.equal(existsSync(join(directory, 'started')), false);
  } finally {
    if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const failure of ['nonzero', 'spawn-error', 'observer-throws']) test(`Windows termination diagnostic preserves conservative ${failure} outcome`, { skip: process.platform !== 'win32' }, async () => {
  const { default: childProcess } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const directory = mkdtempSync(join(tmpdir(), 'method-diagnostic-'));
  const original = childProcess.spawnSync, seen = [];
  try {
    childProcess.spawnSync = (...args) => {
      const actual = original(...args);
      // Real cleanup runs first; only the reported diagnostic result is injected.
      if (!String(args[0]).endsWith('taskkill.exe')) return actual;
      if (failure === 'nonzero') return { ...actual, status: 128, stdout: Buffer.alloc(70000, 120), stderr: Buffer.from('private fixture detail') };
      if (failure === 'spawn-error') return { ...actual, status: null, error: Object.assign(new Error('must not serialize'), { code: 'ETIMEDOUT', secret: 'never serialize' }) };
      return actual;
    };
    syncBuiltinESMExports();
    const result = await executeMethodProcess({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: directory, directory, timeoutSeconds: 0.2, env: process.env, onTerminationDiagnostic: row => { seen.push(row); if (failure === 'observer-throws') throw new Error('observer failure'); } });
    assert.equal(result.terminationFailed, failure !== 'observer-throws');
    assert.equal(seen.length, 1); assert.equal(seen[0].phase, 'taskkill'); assert.ok(Object.isFrozen(seen[0]));
    assert.equal(seen[0].errorCode, failure === 'spawn-error' ? 'ETIMEDOUT' : null);
    assert.ok(Number.isInteger(seen[0].durationMs) && seen[0].durationMs >= 0);
    assert.equal(JSON.stringify(seen).includes('private fixture detail'), false);
    assert.equal(JSON.stringify(seen).includes('never serialize'), false);
    assert.ok(JSON.stringify(seen).length < 1024);
    if (failure === 'nonzero') { assert.equal(seen[0].status, 128); assert.equal(seen[0].stdout.bytes, 70000); assert.equal(seen[0].stdout.hashedBytes, 65536); }
    assert.deepEqual(Object.keys(result).sort(), ['artifacts','descendantsTerminated','exitCode','outputLimitExceeded','signal','supervisor','terminationFailed','timedOut']);
    assert.equal(result.descendantsTerminated, false);
    assert.throws(() => process.kill(seen[0].pid, 0), error => error.code === 'ESRCH');
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); }
});

test('Windows identity recheck diagnostic is distinct from taskkill outcome', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'method-identity-diagnostic-')), previous = process.env.SystemRoot, seen = [];
  let timer;
  try {
    const fake = join(directory, 'fake'); mkdirSync(join(fake, 'System32'), { recursive: true });
    writeFileSync(join(fake, 'System32/taskkill.exe'), 'not a supervisor');
    const pending = executeMethodProcess({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: directory, directory, timeoutSeconds: 0.3, env: { ...process.env }, onTerminationDiagnostic: row => seen.push(row) });
    timer = setTimeout(() => { process.env.SystemRoot = fake; }, 50);
    const result = await pending;
    assert.equal(result.terminationFailed, true); assert.equal(seen.length, 1);
    assert.equal(seen[0].phase, 'identity-recheck'); assert.equal(seen[0].status, null); assert.equal(seen[0].stdout, null);
    assert.throws(() => process.kill(seen[0].pid, 0), error => error.code === 'ESRCH');
  } finally { clearTimeout(timer); if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous; rmSync(directory, { recursive: true, force: true }); }
});
