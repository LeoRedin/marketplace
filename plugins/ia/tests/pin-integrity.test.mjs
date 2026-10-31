import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { writePin } from '../scripts/lib/pin.mjs';
import { sandbox } from './helpers/fixtures.mjs';

const moduleUrl = new URL('../scripts/lib/pin.mjs', import.meta.url).href;
const record = root => ({ workspace: { root }, task: 'task', kits: {}, keys: {} });

test('concurrent writers with one expected revision have one CAS winner and immutable history', async t => {
  const root = sandbox(t, 'ia-pin-cas-'), initial = writePin(root, record(root));
  const before = readFileSync(join(root, 'binding.json'));
  const script = join(root, 'writer.mjs');
  writeFileSync(script, `import { writePin } from ${JSON.stringify(moduleUrl)};
try { writePin(process.argv[2], JSON.parse(process.argv[3]), JSON.parse(process.argv[4])); } catch (error) { process.stdout.write(error.code); process.exit(1); }
`);
  const attempt = marker => new Promise(done => {
    const child = spawn(process.execPath, [script, root, JSON.stringify({ ...record(root), marker }), JSON.stringify(initial)], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.on('close', code => done({ code, stdout }));
  });
  const results = await Promise.all([attempt('one'), attempt('two')]);
  assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
  assert.equal(results.find(result => result.code === 1).stdout, 'IA-CORE-PIN-CONFLICT');
  assert.deepEqual(readFileSync(join(root, 'binding.1.json')), before);
  assert.equal(JSON.parse(readFileSync(join(root, 'binding.json'))).revision, 2);
  assert.equal(existsSync(join(root, '.binding.lock')), false);
});

test('a stale writer cannot discard keys; sequential updates preserve complete history', t => {
  const root = sandbox(t, 'ia-pin-sequential-'), one = writePin(root, record(root));
  const two = writePin(root, { ...record(root), keys: { first: { kit: 'a', capability: 'one' } } }, one);
  const secondBytes = readFileSync(join(root, 'binding.json'));
  assert.throws(() => writePin(root, { ...record(root), keys: {} }, one), error => error.code === 'IA-CORE-PIN-CONFLICT');
  assert.deepEqual(readFileSync(join(root, 'binding.json')), secondBytes);
  const three = writePin(root, { ...record(root), keys: { ...two.keys, second: { kit: 'b', capability: 'two' } } }, two);
  assert.equal(three.revision, 3);
  assert.deepEqual(Object.keys(three.keys), ['first', 'second']);
  assert.deepEqual(readFileSync(join(root, 'binding.2.json')), secondBytes);
});

test('pinRootFor uses IA_HOME', async t => {
  const { pinRootFor } = await import('../scripts/lib/pin.mjs'), root = sandbox(t, 'ia-pin-home-');
  assert.equal(pinRootFor({ env: { IA_HOME: root }, project: 'p', task: 't' }), join(root, 'work-v1', 'p', 't'));
});

test('an explicit home keeps .ia appended', async t => {
  const { pinRootFor } = await import('../scripts/lib/pin.mjs'), root = sandbox(t, 'ia-pin-home-'), h = join(root, 'h');
  assert.equal(pinRootFor({ env: { IA_HOME: root }, project: 'p', task: 't', home: h }), join(h, '.ia', 'work-v1', 'p', 't'));
});

test('IA_CORE_RUN_ROOT and IA_CORE_CLOSURES_DIR beat IA_HOME', async t => {
  const { pinRootFor } = await import('../scripts/lib/pin.mjs'), { closureStore } = await import('../scripts/lib/home.mjs'), root = sandbox(t, 'ia-pin-home-');
  const env = { IA_HOME: root, IA_CORE_RUN_ROOT: join(root, 'run'), IA_CORE_CLOSURES_DIR: join(root, 'closures') };
  assert.equal(pinRootFor({ env, project: 'p', task: 't' }), join(root, 'run'));
  assert.equal(closureStore(env), join(root, 'closures'));
});
