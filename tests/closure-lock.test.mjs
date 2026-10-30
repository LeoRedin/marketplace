import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireClosureLock } from '../plugins/ia/scripts/lib/closure-lock.mjs';
import { readMethodPin, writeMethodPin } from '../plugins/ia/scripts/lib/method-pin.mjs';

const lockModule = new URL('../plugins/ia/scripts/lib/closure-lock.mjs', import.meta.url).href;
const pinModule = new URL('../plugins/ia/scripts/lib/method-pin.mjs', import.meta.url).href;
const state = { workspace: { identity: 'workspace-system/definition/workspace/test', revision: 'a'.repeat(64) }, kits: { 'example/method': { id: 'example/method', version: '1.0.0', closureSha256: 'b'.repeat(64) } }, keys: { 'work.act': { kit: 'example/method', capability: 'agent-composition-system/definition/capability/act', profile: null } } };
const childSource = `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const [mode,root]=process.argv.slice(2);
const pause=()=>{fs.writeSync(1,'READY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
if(mode.startsWith('pin-')) {
  const rename=fs.renameSync;
  fs.renameSync=(from,to)=>{if(to===join(root,'binding.json')&&mode==='pin-before')pause();rename(from,to);if(to===join(root,'binding.json')&&mode==='pin-after')pause();};
  syncBuiltinESMExports();
  const {writeMethodPin}=await import(process.env.PIN_MODULE);
  writeMethodPin(root,JSON.parse(process.env.PIN_STATE),1);
} else {
  const {acquireClosureLock}=await import(process.env.LOCK_MODULE);
  const staging=join(root,'.staging-child');
  const lock=acquireClosureLock(join(root,'publish.lock'),{stagingPaths:[staging]});
  fs.mkdirSync(staging);fs.writeFileSync(join(staging,'manifest.json'),'complete');
  if(mode==='publish-after')fs.renameSync(staging,join(root,'published'));
  pause();lock.release();
}
`;
async function start(root, mode) {
  const script = join(root, 'child.mjs');
  writeFileSync(script, childSource);
  const child = spawn(process.execPath, [script, mode, root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LOCK_MODULE: lockModule, PIN_MODULE: pinModule, PIN_STATE: JSON.stringify(state) } });
  await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child did not reach crash checkpoint')); }, 15000);
    child.stderr.on('data', bytes => { errors += bytes; });
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('READY\n')) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited before checkpoint: ${code} ${errors}`)); });
  });
  return child;
}
async function kill(child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }

test('live owner survives the full bounded wait; actual death allows stage cleanup', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'closure-lock-live-'));
  let child;
  try {
    child = await start(root, 'publish-before');
    const started = Date.now();
    assert.throws(() => acquireClosureLock(join(root, 'publish.lock')), /timed out/);
    assert.ok(Date.now() - started >= 4900);
    assert.ok(Date.now() - started < 8000);
    assert.ok(existsSync(join(root, '.staging-child')));
    await kill(child); child = null;
    const lock = acquireClosureLock(join(root, 'publish.lock'));
    assert.equal(lock.recovered.length, 1);
    assert.equal(existsSync(join(root, '.staging-child')), false);
    assert.equal(existsSync(join(root, 'published')), false);
    lock.release();
  } finally { if (child) await kill(child); rmSync(root, { recursive: true, force: true }); }
});

test('kill after publication preserves the complete published directory', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'closure-lock-published-'));
  let child;
  try {
    child = await start(root, 'publish-after');
    await kill(child); child = null;
    const lock = acquireClosureLock(join(root, 'publish.lock'));
    assert.equal(lock.recovered.length, 1);
    assert.equal(readFileSync(join(root, 'published/manifest.json'), 'utf8'), 'complete');
    lock.release();
  } finally { if (child) await kill(child); rmSync(root, { recursive: true, force: true }); }
});

for (const phase of ['before', 'after']) test(`actual process kill ${phase} pin rename keeps complete current/history and recovers`, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'closure-lock-pin-'));
  let child;
  try {
    writeMethodPin(root, state, null);
    child = await start(root, `pin-${phase}`);
    await kill(child); child = null;
    const revision = phase === 'before' ? 1 : 2;
    assert.equal(readMethodPin(root).revision, revision);
    assert.equal(JSON.parse(readFileSync(join(root, 'binding.1.json'), 'utf8')).revision, 1);
    assert.equal(writeMethodPin(root, state, revision).revision, revision + 1);
    assert.equal(readMethodPin(root).revision, revision + 1);
    assert.equal(readdirSync(root).some(name => name.startsWith('.staging-')), false);
    assert.throws(() => writeMethodPin(root, state, revision), /changed/);
  } finally { if (child) await kill(child); rmSync(root, { recursive: true, force: true }); }
});

test('partial owner and foreign-host owner never authorize age-based recovery', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'closure-lock-unknown-')), path = join(root, 'publish.lock');
  try {
    mkdirSync(path);
    writeFileSync(join(path, 'owner.json'), '{}');
    assert.throws(() => acquireClosureLock(path, { timeoutMs: 50 }), /timed out/);
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: 2147483647, host: 'unreachable-host.invalid', nonce: '11111111-1111-1111-1111-111111111111', staging: [] }));
    assert.throws(() => acquireClosureLock(path, { timeoutMs: 50 }), /timed out/);
    assert.ok(existsSync(path));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
