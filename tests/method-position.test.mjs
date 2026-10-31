import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attestRuntime } from '../plugins/ia/scripts/lib/closure-runtime.mjs';
import { resolveConsumerSubject } from '../plugins/ia/scripts/lib/closure-native.mjs';
import { assembleMethodPacket, verifyMethodPacket } from '../plugins/ia/scripts/lib/method-packet.mjs';
import { createMethodClosure } from '../plugins/ia/scripts/lib/method-closure.mjs';
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
  writeFileSync(join(dir, 'delivery.json'), JSON.stringify({format:1,whole:["kb-migrate"]}) + '\n');
  const kit = { ...carried, dir, version: descriptor.version, latest: { ...carried.latest, version: descriptor.version, sources: sourcesDigest(dir) } };
  const runtime = await attestRuntime(cli);
  const { packDistribution } = await runtime.importNative('@inventarch/distribution/pack');
  const packed = packDistribution(readRoot(kit, { cli }), descriptor);
  kit.latest.archive = packed.archiveDigest;
  kit.latest.manifest = packed.manifestDigest;
  return { directory, kit, executionContracts, storeRoot: join(directory, 'store') };
}


import { selectMethodPosition } from '../plugins/ia/scripts/lib/method-position.mjs';

test('retained native position selects phase cells and preserves justified whole fallback', async () => {
  const f = await fixture();
  try {
    const closure = await createMethodClosure({ ...f, cli });
    const runtime = await attestRuntime(cli);
    const subject = await resolveConsumerSubject({ root: readRoot(f.kit, {cli}), importNative: runtime.importNative });
    const capability = closure.manifest.capabilities.find(row => row.identity.endsWith('/kb-check')).identity;
    const select = overrides => selectMethodPosition({ closure, capability, activityKey:'delivery.change', cli, importNative:runtime.importNative, ...overrides });
    const act = await select({shape:'execution',phase:'act'});
    assert.equal(act.mode, 'position');
    assert.ok(act.addresses.length > 0);
    assert.ok(act.addresses.every(address => address.includes('#act/')));
    const orient = await select({shape:'context',phase:'orient'});
    assert.equal(orient.mode,'position');
    assert.ok(orient.addresses.every(address => address.includes('#orient/')));
    // The core names no whole-procedure activity key; a kit declares its whole capabilities in delivery.json,
    // which outranks the requested shape and phase and carries every cell of all four phases.
    const planCapability = closure.manifest.capabilities.find(row=>row.identity.endsWith('/kb-migrate')).identity;
    const whole = await select({capability:planCapability,shape:'execution',phase:'act'});
    assert.equal(whole.mode,'whole-procedure');
    assert.ok(whole.addresses.length > act.addresses.length);
    assert.deepEqual([...new Set(whole.addresses.map(address => address.split('#')[1].split('/')[0]))].sort(),['act','learn','orient','plan']);
    const verifyCapability = closure.manifest.capabilities.find(row=>row.identity.endsWith('/kb-retrieve')).identity;
    const fallback = await select({capability:verifyCapability});
    assert.equal(fallback.mode,'empty-position-fallback');
    assert.ok(fallback.addresses.length>0);
    const declaredWhole = await select({capability:planCapability});
    assert.equal(declaredWhole.mode,'whole-procedure');
    const packet = assembleMethodPacket({closure,subject,capability,selector:act});
    assert.equal(verifyMethodPacket(packet).selector.phase,'act');
    assert.deepEqual(packet.instructions.map(row=>row.address).sort(),act.addresses);
    const alternate = assembleMethodPacket({closure,subject,capability,selector:orient});
    assert.notEqual(alternate.packetSha256,packet.packetSha256);
    assert.deepEqual(packet.requiredChecks,alternate.requiredChecks);
    const unscoped = assembleMethodPacket({closure,subject,capability});
    assert.equal(unscoped.selector,null);
    assert.deepEqual(unscoped.requiredChecks,packet.requiredChecks);
    assert.throws(()=>assembleMethodPacket({closure,subject,capability,selector:{...act,addresses:['foreign#act/subject']}}),/foreign or missing/);
    assert.throws(()=>assembleMethodPacket({closure,subject,capability,selector:{...act,methodRevision:'0'.repeat(64)}}),/another method revision/);
    const tampered = structuredClone(packet);
    tampered.selector.phase='learn';
    assert.throws(()=>verifyMethodPacket(tampered),/integrity/);
    // Current source drift cannot affect the retained offline position.
    writeFileSync(join(f.kit.dir,'delivery.json'),JSON.stringify({format:1,whole:['kb-check']}));
    assert.deepEqual(await select({shape:'execution',phase:'act'}),act);
  } finally { rmSync(f.directory,{recursive:true,force:true}); }
});
