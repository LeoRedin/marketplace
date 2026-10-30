import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalMethod, methodDigest } from '../scripts/lib/method-json.mjs';
import { assembleMethodPacket, verifyMethodPacket } from '../scripts/lib/method-packet.mjs';
import { previewMethodRebind, readMethodPin, writeMethodPin } from '../scripts/lib/method-pin.mjs';

const digest = 'a'.repeat(64), other = 'b'.repeat(64);
const system = 'floor/definition/system/example', workspace = 'workspace-system/definition/workspace/consumer';
const cap = 'agent-composition-system/definition/capability/operate', playbook = 'governance-system/definition/procedure/operate';
function fixture() {
  const records = [
    { identity: cap, discriminator: 'capability', digest, source: { path: 'kit/cap.ia' }, sections: [] },
    { identity: playbook, discriminator: 'playbook', digest, source: { path: 'kit/playbook.ia' }, cells: [{ phase: 'act', primitive: 'Decision', text: 'Execute the retained procedure.' }], sections: [] },
  ];
  return {
    closure: { manifest: { format: 'inventarch.method-closure/1', closureSha256: digest,
      files: records.map(row => ({ path: row.source.path })), checks: [], capabilities: [{ identity: cap, authoringSystem: system, mode: 'executable', playbooks: [playbook], checks: [] }] }, graph: { records } },
    subject: { identity: workspace, revision: other, systems: [{ identity: system, revision: digest }] }, capability: cap,
  };
}

test('method canonical JSON rejects silent coercions and non-Unicode strings', () => {
  assert.equal(canonicalMethod({ z: 1, a: 'é' }), '{"a":"é","z":1}');
  for (const value of [undefined, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, { a: undefined }, [ , 1], '\ud800', new Date()]) assert.throws(() => canonicalMethod(value));
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => canonicalMethod(cycle));
});

test('packet binds instructions, source provenance, subject and required checks without granting authority', () => {
  const input = fixture(), packet = assembleMethodPacket(input);
  assert.equal(packet.executionState, 'authority-required');
  assert.equal(packet.instructions[0].sourcePath, 'kit/playbook.ia');
  assert.equal(packet.instructions[0].digest, digest);
  assert.equal(verifyMethodPacket(packet), packet);
  assert.throws(() => verifyMethodPacket({ ...packet, requiredChecks: [{ id: 'extra' }] }));
  assert.throws(() => assembleMethodPacket({ ...input, subject: { ...input.subject, identity: 'tenant-123' } }));
  input.closure.graph.records.pop();
  assert.throws(() => assembleMethodPacket(input), /unavailable/);
});

test('inspection-only suppresses instructions and checks; required missing runner refuses', () => {
  const input = fixture();
  input.closure.manifest.capabilities[0].mode = 'inspection-only';
  let packet = assembleMethodPacket(input);
  assert.equal(packet.executionState, 'inspection-only');
  assert.deepEqual(packet.instructions, []);
  assert.deepEqual(packet.requiredChecks, []);
  input.closure.manifest.capabilities[0].mode = 'executable';
  input.closure.manifest.capabilities[0].checks = ['compliance-system/check/gate/required'];
  assert.throws(() => assembleMethodPacket(input), /no retained runner/);
  packet = { ...packet, format: 'inventarch.method-packet/9' };
  assert.throws(() => verifyMethodPacket(packet), /Unsupported packet/);
});

test('method pin CAS preserves history and previews every activity sharing a kit', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'method-pin-test-'));
  try {
    const state = { workspace: { identity: workspace, revision: digest },
      kits: { example: { id: 'example', version: '1.0.0', closureSha256: digest } },
      keys: { 'work.act': { kit: 'example', capability: cap, profile: null }, 'work.plan': { kit: 'example', capability: cap, profile: null } } };
    const first = writeMethodPin(root, state, null);
    const before = readFileSync(join(root, 'binding.json'), 'utf8');
    assert.deepEqual(previewMethodRebind(first, 'example', other).affectedKeys, ['work.act', 'work.plan']);
    assert.throws(() => writeMethodPin(root, state, null), /changed/);
    assert.equal(readFileSync(join(root, 'binding.json'), 'utf8'), before);
    const next = writeMethodPin(root, state, 1);
    assert.equal(next.revision, 2);
    assert.equal(readFileSync(join(root, 'binding.1.json'), 'utf8'), before);
    assert.equal(methodDigest(readMethodPin(root)), methodDigest(next));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('independent process pin writers have exactly one CAS winner', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'method-pin-race-'));
  try {
    const state = { workspace: { identity: workspace, revision: digest }, kits: { example: { id: 'example', version: '1', closureSha256: digest } }, keys: { 'work.act': { kit: 'example', capability: cap, profile: null } } };
    const moduleUrl = new URL('../scripts/lib/method-pin.mjs', import.meta.url).href;
    const script = `import {writeMethodPin} from ${JSON.stringify(moduleUrl)}; try { writeMethodPin(process.argv[1], JSON.parse(process.argv[2]), null); } catch(e) { if(e.code === 'IA-CORE-PIN-CONFLICT') process.exitCode=3; else throw e; }`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(state)], { windowsHide: true, stdio: 'ignore' });
      child.once('error', reject); child.once('exit', resolve);
    });
    assert.deepEqual((await Promise.all([run(), run()])).sort(), [0, 3]);
    assert.equal(readMethodPin(root).revision, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
