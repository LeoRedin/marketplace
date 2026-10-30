// Every kit the plugin carries: the latest recorded release names the kit's
// current sources, every agent-profile's step budget fits the core agent its
// role runs as, and (opt-in, with IA_CORE_TEST_CLI=<@inventarch/cli dist/main.js>)
// packing the sources reproduces the recorded archive. This covers kits whose
// declared assets include nested paths (ia-authoring scripts/ and assets/) and
// a kit that declares none (ia-method). Only the kits the plugin carries are
// read, never a kit installed in the IA home.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_KITS_DIR, listKits as listAll, packRelease, sourcesDigest } from '../scripts/lib/kit.mjs';

const listKits = () => listAll(DEFAULT_KITS_DIR);

const CLI = process.env.IA_CORE_TEST_CLI;
const AGENTS = fileURLToPath(new URL('../agents/', import.meta.url));

const walk = dir => readdirSync(dir).flatMap(name => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));

test('every kit profile\'s step budget (limit-steps) fits the maxTurns of the core agent its role runs as', () => {
  const maxTurns = Object.fromEntries(['reader', 'worker', 'checker'].map(name => [name, Number(/^maxTurns: (\d+)$/m.exec(readFileSync(join(AGENTS, `${name}.md`), 'utf8'))?.[1])]));
  assert.deepEqual(maxTurns, { reader: 40, worker: 60, checker: 20 });
  let profiles = 0;
  for (const kit of listKits()) {
    for (const file of walk(join(kit.dir, '.ia', 'src')).filter(f => f.endsWith('.ia'))) {
      for (const block of readFileSync(file, 'utf8').split(/^(?=@)/m).filter(b => b.startsWith('@agent-profile '))) {
        const name = /^@agent-profile (\S+)/.exec(block)[1];
        const role = /^\s+role (\S+)$/m.exec(block)?.[1];
        const steps = /^\s+limit-steps (\d+)$/m.exec(block)?.[1];
        if (!role || !steps) continue;
        profiles++;
        assert.ok(role in maxTurns, `${kit.id} ${name}: role ${role} is not a core agent`);
        assert.ok(Number(steps) <= maxTurns[role], `${kit.id} ${name}: limit-steps ${steps} exceeds the ${role}'s maxTurns ${maxTurns[role]}`);
      }
    }
  }
  assert.ok(profiles >= 4, `${profiles} profiles with a role and a step budget`);
});

test('the plugin carries exactly the public lane defaults, each with a whole entry capability bound to its lane', () => {
  const kits = listKits();
  assert.deepEqual(kits.map(k => k.folder), ['ia-authoring', 'ia-kb', 'ia-method']);
  const entries = { 'ia-authoring': ['delivery.*', 'authoring-deliver'], 'ia-kb': ['knowledge.*', 'kb-knowledge'], 'ia-method': ['work.*', 'method-operate'] };
  for (const kit of kits) {
    assert.equal(kit.id, `inventarch/${kit.folder}-kit`, 'kit ids follow inventarch/ia-<name>-kit');
    const [key, capability] = entries[kit.folder];
    assert.equal(JSON.parse(readFileSync(join(kit.dir, 'bindings.json'), 'utf8')).recommend[key].capability, capability, `${kit.id} binds ${key}`);
    assert.ok(JSON.parse(readFileSync(join(kit.dir, 'delivery.json'), 'utf8')).whole.includes(capability), `${kit.id}: ${capability} is whole`);
    assert.equal(JSON.parse(readFileSync(join(kit.dir, '.ia', 'release.json'), 'utf8')).license, 'Apache-2.0');
    assert.equal(JSON.parse(readFileSync(join(kit.dir, 'releases.json'), 'utf8')).format, 2, `${kit.id}: releases format 2`);
  }
});

test('for every kit, the latest release records the digest of the kit\'s current sources', () => {
  for (const kit of listKits()) {
    assert.ok(kit.latest, `${kit.id}: no recorded release`);
    assert.equal(kit.latest.version, kit.version, `${kit.id}: the latest release is not the descriptor's version`);
    assert.equal(kit.latest.sources, sourcesDigest(kit.dir), `${kit.id}: sources differ from the recorded release`);
  }
});

test('the KB delivery release preserves the decision-lifecycle 0.6.0 identity', () => {
  const kb = listKits().find(kit => kit.folder === 'ia-kb');
  assert.equal(kb.releases.find(release => release.version === '0.6.0')?.archive,
    '36eae9ebcb1600b64458a655914e26afb1e3612418dc4dcaeafbf52626e15a77',
    'consumers of the decision-lifecycle release must retain the same immutable archive');
  assert.notEqual(kb.latest.version, '0.6.0', 'delivery and recommended bindings require a new release');
});

test('for every kit, packing the sources reproduces the recorded archive', { skip: !CLI && 'set IA_CORE_TEST_CLI to an @inventarch/cli dist/main.js' }, () => {
  const version = JSON.parse(readFileSync(join(dirname(CLI), '..', 'package.json'), 'utf8')).version;
  const cli = { argv: [process.execPath, CLI], version, source: 'test' };
  for (const kit of listKits()) {
    const built = packRelease(kit, kit.latest, cli);
    try {
      assert.equal(built.digest, kit.latest.archive, `${kit.id}: archive`);
      assert.equal(built.manifest, kit.latest.manifest, `${kit.id}: manifest`);
    } finally { built.cleanup(); }
  }
});
