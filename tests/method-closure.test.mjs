import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attestRuntime } from '../plugins/ia/scripts/lib/closure-runtime.mjs';
import { resolveConsumerSubject } from '../plugins/ia/scripts/lib/closure-native.mjs';
import { assembleMethodPacket, verifyMethodPacket } from '../plugins/ia/scripts/lib/method-packet.mjs';
import { runMethodCheck } from '../plugins/ia/scripts/lib/method-check.mjs';
import { writeMethodPin } from '../plugins/ia/scripts/lib/method-pin.mjs';
import { createMethodClosure, loadMethodClosure } from '../plugins/ia/scripts/lib/method-closure.mjs';
import { resolveCli } from '../plugins/ia/scripts/lib/cli.mjs';
import { findKit, readRoot, sourcesDigest } from '../plugins/ia/scripts/lib/kit.mjs';

const cli = resolveCli(process.cwd());

async function fixture(cwd = 'workspace') {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'method-closure-test-')));
  const carried = findKit('ia-kb'), dir = join(directory, 'kit');
  cpSync(carried.dir, dir, { recursive: true });
  const descriptorPath = join(dir, '.ia/release.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  descriptor.version = '99.0.0';
  writeFileSync(descriptorPath, JSON.stringify(descriptor) + '\n');
  const checks = JSON.parse(readFileSync(join(dir, 'checks.json'), 'utf8'));
  const executionContracts = {};
  for (const name of Object.keys(checks.checks)) {
    checks.checks[name] = { argv: ['${IA}', 'validate', '--json'], cwd };
    executionContracts[`compliance-system/check/gate/${name}`] = { executable: 'native-cli', argv: ['validate', '--json'], cwd, timeoutSeconds: 120, argumentSchema: null };
  }
  writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks) + '\n');
  const kit = { ...carried, dir, version: descriptor.version, latest: { ...carried.latest, version: descriptor.version, sources: sourcesDigest(dir) } };
  const runtime = await attestRuntime(cli);
  const { packDistribution } = await runtime.importNative('@inventarch/distribution/pack');
  const packed = packDistribution(readRoot(kit, { cli }), descriptor);
  kit.latest.archive = packed.archiveDigest;
  kit.latest.manifest = packed.manifestDigest;
  return { directory, kit, executionContracts, storeRoot: join(directory, 'store') };
}

test('complete native closure reproduces, reloads and refuses byte mutation', async () => {
  const f = await fixture();
  try {
    const first = await createMethodClosure({ ...f, cli });
    assert.equal(first.manifest.format, 'inventarch.method-closure/1');
    assert.equal(first.manifest.kit.version, '99.0.0');
    assert.ok(first.graph.records.every(row => row.source.path.startsWith('kit/')));
    assert.ok(first.manifest.checks.every(row => row.executable === 'native-cli' && row.script === null));
    assert.ok(first.manifest.files.some(row => row.path === 'graph.json'));
    assert.ok(first.manifest.files.some(row => row.path === 'native/language.ia.tgz' && row.sha256 === first.manifest.native.languageArchiveSha256));
    const runtime = await attestRuntime(cli);
    const workspaceRoot = join(f.directory, 'consumer');
    cpSync(readRoot(f.kit, { cli }), workspaceRoot, { recursive: true });
    const subject = await resolveConsumerSubject({ root: workspaceRoot, importNative: runtime.importNative });
    const capability = first.manifest.capabilities.find(row => row.identity.endsWith('/kb-place-content'));
    const packet = assembleMethodPacket({ closure: first, subject, capability: capability.identity });
    assert.equal(verifyMethodPacket(packet).executionState, 'authority-required');
    assert.ok(packet.instructions.length > 0);
    assert.ok(packet.references.every(row => first.graph.records.some(record => record.identity === row.identity && record.digest === row.digest)));
    let composedProfiles = 0;
    for (const composed of first.manifest.capabilities.filter(row => row.profiles.length)) {
      for (const profile of composed.profiles) {
        const rolePacket = assembleMethodPacket({ closure: first, subject, capability: composed.identity, profile });
        assert.equal(rolePacket.profile, profile);
        assert.ok(rolePacket.references.some(row => first.graph.records.some(record => record.identity === row.identity && record.discriminator === 'mandate')));
        for (const check of rolePacket.requiredChecks) assert.ok(first.manifest.checks.some(row => row.record === check.identity));
        composedProfiles++;
      }
    }
    // kb-retrieve (librarian), kb-review (reviewer), kb-maintain-document and kb-bind-document (curator), kb-gates (gate runner)
    assert.equal(composedProfiles, 5);
    const learn = first.manifest.capabilities.find(row => row.identity.endsWith('/kb-check'));
    const pinRoot = join(f.directory, 'pin'), activityKey = 'knowledge.check';
    const pin = writeMethodPin(pinRoot, {
      workspace: { identity: subject.identity, revision: subject.revision },
      kits: { [first.manifest.kit.id]: { ...first.manifest.kit, closureSha256: first.manifest.closureSha256 } },
      keys: { [activityKey]: { kit: first.manifest.kit.id, capability: learn.identity, profile: null } },
    }, null);
    const input = { pinRevision: pin.revision, closureSha256: first.manifest.closureSha256, checkId: 'kb-check-validate', arguments: {}, subjectRevision: subject.revision };
    const invocation = { input, activityKey, pinRoot, workspaceRoot, cli, storeRoot: f.storeRoot, artifactRoot: join(f.directory, 'artifacts') };
    await assert.rejects(runMethodCheck({ ...invocation, input: { ...input, pinRevision: pin.revision + 1 } }), /current pinned revision/);
    await assert.rejects(runMethodCheck({ ...invocation, input: { ...input, subjectRevision: '0'.repeat(64) } }), /Consumer subject changed/);
    await assert.rejects(runMethodCheck({ ...invocation, input: { ...input, checkId: 'kb-check-locators' } }), /not required/);
    const executed = await runMethodCheck(invocation);
    assert.equal(executed.receipt.format, 'inventarch.method-check/1');
    assert.equal(executed.receipt.exitCode, 0);
    assert.equal(executed.receipt.qualification, 'execution-evidence-only');
    assert.equal(executed.receipt.subjectChanged, false);
    assert.equal(executed.receipt.pinChanged, false);
    assert.equal(executed.receipt.subject.before, subject.revision);
    assert.equal(executed.receipt.subject.after, subject.revision);
    assert.ok(executed.receipt.artifacts.find(row => row.name === 'stdout.bin').bytes > 0);
    const second = await createMethodClosure({ ...f, cli });
    assert.equal(second.manifest.closureSha256, first.manifest.closureSha256);
    assert.deepEqual(loadMethodClosure(first.manifest.closureSha256, f).graph, first.graph);
    writeFileSync(join(first.root, 'kit/checks.json'), '{}\n');
    assert.throws(() => loadMethodClosure(first.manifest.closureSha256, f), /payload differs/);
    await assert.rejects(createMethodClosure({ ...f, cli }), /payload differs/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('unqualified and ambient executors never publish a complete closure', async () => {
  const f = await fixture();
  try {
    await assert.rejects(createMethodClosure({ ...f, cli, executionContracts: {} }), /lacks explicit executor qualification/);
    assert.deepEqual(readdirSync(f.storeRoot), []);
    const contracts = structuredClone(f.executionContracts);
    contracts[Object.keys(contracts)[0]].executable = 'node';
    await assert.rejects(createMethodClosure({ ...f, cli, executionContracts: contracts }), /inventory analysis is not supported/);
    assert.deepEqual(readdirSync(f.storeRoot), []);
    await assert.rejects(createMethodClosure({ kit: findKit('ia-kb'), cli, storeRoot: f.storeRoot, executionContracts: f.executionContracts }), /does not match the qualified fixed native/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('invocation validation runs before publication and cannot mutate committed bytes', async () => {
  const f = await fixture();
  try {
    await assert.rejects(createMethodClosure({ ...f, cli, validateBeforePublish: async ({ manifest, graph }) => {
      assert.equal(manifest.capabilities.length, graph.capabilities.length);
      throw new Error('selected profile is missing');
    } }), /selected profile is missing/);
    assert.deepEqual(readdirSync(f.storeRoot), []);
    await assert.rejects(createMethodClosure({ ...f, cli, validateBeforePublish: async ({ root }) => {
      writeFileSync(join(root, 'kit/checks.json'), '{}\n');
    } }), /payload differs/);
    assert.deepEqual(readdirSync(f.storeRoot), []);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('historical source drift and missing closures refuse without fallback', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.kit.dir, 'checks.json'), '{}\n');
    await assert.rejects(createMethodClosure({ ...f, cli }), /historical release/);
    assert.throws(() => loadMethodClosure('0'.repeat(64), f), error => error.code === 'IA-CORE-CLOSURE-MISSING');
    assert.deepEqual(readdirSync(f.storeRoot), []);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});


test('kit cwd remains unsupported by the native workspace validation profile', async () => {
  const f = await fixture('kit');
  try {
    await assert.rejects(createMethodClosure({ ...f, cli }), error => error.code === 'IA-CORE-CLOSURE-UNSUPPORTED' && /qualified fixed native/.test(error.message));
    assert.deepEqual(readdirSync(f.storeRoot), []);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
