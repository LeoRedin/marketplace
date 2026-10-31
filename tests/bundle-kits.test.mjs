import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BundleError, compareBundle, kitFiles, main, readBundleMap, readUnbundled, writeBundle } from '../tools/bundle-kits.mjs';

const KIT = {
  'kits/k1/releases.json': '{"kit":"inventarch/k1-kit","releases":[]}\n',
  'kits/k1/.ia/release.json': '{}\n',
  'kits/k1/README.md': '# k1\n',
};
const PLUGIN = {
  'plugins/p/.claude-plugin/plugin.json': '{"name":"p"}\n',
  'plugins/p/config/kits/README.md': '# generated\n',
};
const MAP = { format: 1, bundles: [{ kit: 'k1', into: 'plugins/p/config/kits/k1' }] };

function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function repo(t, { files = {}, map } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bundle-kits-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) put(root, path, text);
  if (map) put(root, 'kits/bundle.json', JSON.stringify(map));
  return root;
}

const collector = () => {
  const lines = [];
  const out = text => lines.push(text);
  out.text = () => lines.join('');
  return out;
};

test('check passes when the bundled copy equals the source', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN }, map: MAP });
  writeBundle(root, readBundleMap(root)[0]);
  assert.deepEqual(compareBundle(root, readBundleMap(root)[0]), { missing: [], extra: [], differ: [] });
  assert.equal(main(['--check'], root, collector()), 0);
});

test('check names a file edited only in the plugin copy', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN }, map: MAP });
  const entry = readBundleMap(root)[0];
  writeBundle(root, entry);
  put(root, 'plugins/p/config/kits/k1/README.md', '# edited\n');
  assert.deepEqual(compareBundle(root, entry).differ, ['README.md']);
  const out = collector();
  assert.equal(main(['--check'], root, out), 1);
  assert.match(out.text(), /kits\/k1 -> plugins\/p\/config\/kits\/k1: missing none, extra none, differ README\.md/);
  assert.ok(out.text().includes('kits/k1 is the source: carry any change made in plugins/p/config/kits/k1 over to kits/k1 first, then run node tools/bundle-kits.mjs --write (it overwrites plugins/p/config/kits/k1 and deletes files kits/k1 lacks)'));
});

test('check reports missing and extra files', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN, 'plugins/p/config/kits/k1/README.md': '# k1\n', 'plugins/p/config/kits/k1/stale.md': 'x\n' }, map: MAP });
  assert.deepEqual(compareBundle(root, readBundleMap(root)[0]), {
    missing: ['.ia/release.json', 'releases.json'],
    extra: ['stale.md'],
    differ: [],
  });
});

test('write removes extra files only inside its target', t => {
  const root = repo(t, {
    files: { ...KIT, ...PLUGIN, 'plugins/p/config/kits/k1/stale.md': 'x\n', 'plugins/p/config/kits/k1/sub/old.md': 'y\n', 'plugins/p/config/kits/k2/x.md': 'z\n' },
    map: MAP,
  });
  const result = writeBundle(root, readBundleMap(root)[0]);
  assert.deepEqual(result.removed, ['stale.md', 'sub/old.md']);
  assert.ok(existsSync(join(root, 'plugins/p/config/kits/README.md')));
  assert.ok(existsSync(join(root, 'plugins/p/config/kits/k2/x.md')));
  assert.ok(!existsSync(join(root, 'plugins/p/config/kits/k1/sub')));
});

test('write prints what it wrote and removed', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN, 'plugins/p/config/kits/k1/stale.md': 'x\n' }, map: MAP });
  const out = collector();
  assert.equal(main(['--write'], root, out), 0);
  assert.match(out.text(), /wrote .*README\.md/);
  assert.match(out.text(), /removed .*stale\.md/);
});

const withNoise = {
  ...KIT,
  'kits/k1/node_modules/a.js': 'a\n',
  'kits/k1/.scratch/b.txt': 'b\n',
  'kits/k1/.ia/distributions/c.json': 'c\n',
  'kits/k1/.ia/work/d.json': 'd\n',
  'kits/k1/x/build/e.txt': 'e\n',
  'kits/k1/__pycache__/f.pyc': 'f\n',
  'kits/k1/.qualification/g.json': 'g\n',
};

test('kitFiles skips installed and scratch folders', t => {
  const root = repo(t, { files: withNoise });
  assert.deepEqual(kitFiles(join(root, 'kits/k1')), ['.ia/release.json', 'README.md', 'releases.json']);
});

test('kitFiles returns posix paths', t => {
  const root = repo(t, { files: { ...withNoise, 'kits/k1/deep/er/f.md': 'f\n' } });
  const files = kitFiles(join(root, 'kits/k1'));
  assert.ok(files.includes('deep/er/f.md'));
  assert.ok(files.every(p => !p.includes('\\')));
});

test('kitFiles returns nothing for a missing folder', t => {
  assert.deepEqual(kitFiles(join(repo(t), 'nope')), []);
});

test('kitFiles refuses a symlink', t => {
  const root = repo(t, { files: KIT });
  try {
    symlinkSync(join(root, 'kits/k1/README.md'), join(root, 'kits/k1/link.md'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('no symlink permission');
    throw error;
  }
  assert.throws(() => kitFiles(join(root, 'kits/k1')), e => e instanceof BundleError && e.code === 'IA-BUNDLE-ALIAS');
});

test('the map refuses a target outside a plugin config folder', t => {
  for (const into of ['plugins/p/scripts/k1', 'plugins/p/config/kits/../../x', 'kits/k1', 'plugins/missing/config/kits/k1']) {
    const root = repo(t, { files: { ...KIT, ...PLUGIN }, map: { format: 1, bundles: [{ kit: 'k1', into }] } });
    assert.throws(() => readBundleMap(root), e => e instanceof BundleError && e.code === 'IA-BUNDLE-TARGET', into);
  }
});

test('the map accepts the single-kit config/kit target', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN }, map: { format: 1, bundles: [{ kit: 'k1', into: 'plugins/p/config/kit' }] } });
  assert.deepEqual(readBundleMap(root), [{ kit: 'k1', source: 'kits/k1', into: 'plugins/p/config/kit' }]);
});

test('the map refuses a kit folder without releases.json', t => {
  const root = repo(t, { files: { ...PLUGIN, 'kits/k3/README.md': '# k3\n' }, map: { format: 1, bundles: [{ kit: 'k3', into: 'plugins/p/config/kits/k3' }] } });
  assert.throws(() => readBundleMap(root), e => e.code === 'IA-BUNDLE-NOT-KIT');
});

test('the map refuses a duplicate target and a malformed map', t => {
  const files = { ...KIT, ...PLUGIN, 'kits/k2/releases.json': '{}\n' };
  const bad = [
    { format: 1, bundles: [{ kit: 'k1', into: 'plugins/p/config/kits/k1' }, { kit: 'k2', into: 'plugins/p/config/kits/k1' }] },
    { format: 2, bundles: [] },
    { format: 1, bundles: [{ kit: 'K1', into: 'plugins/p/config/kits/k1' }] },
  ];
  for (const map of bad) {
    const root = repo(t, { files, map });
    assert.throws(() => readBundleMap(root), e => e instanceof BundleError && e.code === 'IA-BUNDLE-MAP', JSON.stringify(map));
  }
});

test('main prints a refused map and returns 2', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN }, map: { format: 2, bundles: [] } });
  const out = collector();
  assert.equal(main(['--check'], root, out), 2);
  assert.match(out.text(), /^IA-BUNDLE-MAP /);
});

test('main needs exactly one mode', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN }, map: MAP });
  assert.equal(main([], root, collector()), 2);
  assert.equal(main(['--check', '--write'], root, collector()), 2);
  assert.equal(main(['--bogus'], root, collector()), 2);
});

const junction = (t, target, link) => {
  try {
    symlinkSync(target, link, 'junction');
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('no junction permission');
    throw error;
  }
};

test('check fails on a root kit no bundle entry names', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN, 'kits/zz-kit/releases.json': '{}\n', 'kits/private-agent/x.md': 'x\n' }, map: MAP });
  writeBundle(root, readBundleMap(root)[0]);
  const out = collector();
  assert.equal(main(['--check'], root, out), 1);
  assert.ok(out.text().includes('kits/zz-kit is a kit no bundle entry names; add it to kits/bundle.json\n'));
  assert.ok(!out.text().includes('private-agent'));
});

test('check fails on a plugin kit no entry generates, and unbundled lists it', t => {
  const files = { ...KIT, ...PLUGIN, 'plugins/p/config/kit/releases.json': '{}\n', 'plugins/p/config/kits/old/releases.json': '{}\n' };
  const root = repo(t, { files, map: MAP });
  writeBundle(root, readBundleMap(root)[0]);
  const out = collector();
  assert.equal(main(['--check'], root, out), 1);
  assert.ok(out.text().includes('plugins/p/config/kit holds a kit no bundle entry generates; map it in kits/bundle.json, list it under unbundled, or remove it\n'));
  assert.ok(out.text().includes('plugins/p/config/kits/old holds a kit no bundle entry generates'));
  const listed = repo(t, { files, map: { ...MAP, unbundled: ['plugins/p/config/kit', 'plugins/p/config/kits/old'] } });
  writeBundle(listed, readBundleMap(listed)[0]);
  assert.deepEqual(readUnbundled(listed), ['plugins/p/config/kit', 'plugins/p/config/kits/old']);
  assert.equal(main(['--check'], listed, collector()), 0);
});

test('write reports unmapped kits and returns 1 without touching them', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN, 'kits/zz-kit/releases.json': '{}\n', 'plugins/p/config/kit/releases.json': '{}\n' }, map: MAP });
  const out = collector();
  assert.equal(main(['--write'], root, out), 1);
  assert.match(out.text(), /kits\/zz-kit is a kit no bundle entry names/);
  assert.match(out.text(), /plugins\/p\/config\/kit holds a kit/);
  assert.ok(existsSync(join(root, 'plugins/p/config/kit/releases.json')));
  assert.ok(!existsSync(join(root, 'plugins/p/config/kits/zz-kit')));
});

test('the map refuses empty bundles and an unbundled entry that is also an into', t => {
  const empty = repo(t, { files: { ...KIT, ...PLUGIN }, map: { format: 1, bundles: [] } });
  const out = collector();
  assert.equal(main(['--check'], empty, out), 2);
  assert.match(out.text(), /^IA-BUNDLE-MAP /);
  const both = repo(t, { files: { ...KIT, ...PLUGIN }, map: { ...MAP, unbundled: ['plugins/p/config/kits/k1'] } });
  assert.throws(() => readBundleMap(both), e => e instanceof BundleError && e.code === 'IA-BUNDLE-MAP');
  assert.equal(main(['--check'], both, collector()), 2);
});

test('the map refuses a duplicate, malformed or missing unbundled entry', t => {
  const files = { ...KIT, ...PLUGIN, 'plugins/p/config/kit/releases.json': '{}\n' };
  for (const unbundled of [['plugins/p/config/kit', 'plugins/p/config/kit'], [7], ['elsewhere/kit'], ['plugins/p/config/kits/gone'], 'plugins/p/config/kit']) {
    const root = repo(t, { files, map: { ...MAP, unbundled } });
    assert.throws(() => readBundleMap(root), e => e instanceof BundleError && e.code === 'IA-BUNDLE-MAP', JSON.stringify(unbundled));
  }
});

test('write replaces a file with a folder of the same name in one pass', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN, 'kits/k1/sub/x.md': 'x\n', 'plugins/p/config/kits/k1/sub': 'file\n' }, map: MAP });
  const entry = readBundleMap(root)[0];
  writeBundle(root, entry);
  assert.deepEqual(compareBundle(root, entry), { missing: [], extra: [], differ: [] });
  const back = repo(t, { files: { ...KIT, ...PLUGIN, 'kits/k1/sub': 'file\n', 'plugins/p/config/kits/k1/sub/x.md': 'x\n' }, map: MAP });
  writeBundle(back, readBundleMap(back)[0]);
  assert.deepEqual(compareBundle(back, readBundleMap(back)[0]), { missing: [], extra: [], differ: [] });
});

test('a junction inside a kit source is refused', t => {
  const root = repo(t, { files: { ...KIT, ...PLUGIN, 'elsewhere/a.md': 'a\n' }, map: MAP });
  if (!junction(t, join(root, 'elsewhere'), join(root, 'kits/k1/linked'))) return;
  assert.throws(() => compareBundle(root, readBundleMap(root)[0]), e => e instanceof BundleError && e.code === 'IA-BUNDLE-ALIAS');
});

test('a junction above the target is refused before anything is written', t => {
  const root = repo(t, { files: { ...KIT, 'plugins/p/.claude-plugin/plugin.json': '{"name":"p"}\n', 'elsewhere/keep.md': 'k\n' }, map: MAP });
  mkdirSync(join(root, 'plugins/p/config'), { recursive: true });
  if (!junction(t, join(root, 'elsewhere'), join(root, 'plugins/p/config/kits'))) return;
  const out = collector();
  assert.equal(main(['--write'], root, out), 2);
  assert.match(out.text(), /^IA-BUNDLE-ALIAS plugins\/p\/config\/kits is a symlink or junction/);
  assert.ok(!existsSync(join(root, 'elsewhere/k1')));
  assert.ok(existsSync(join(root, 'elsewhere/keep.md')));
});

test('the real script runs when started through a junctioned working folder', t => {
  const real = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tools', 'bundle-kits.mjs');
  const root = repo(t);
  const alias = join(root, 'alias');
  if (!junction(t, dirname(real), alias)) return;
  const run = spawnSync(process.execPath, [join(alias, 'bundle-kits.mjs'), '--bogus'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /^usage: /);
});

test('the real map bundles every plugin kit and lists none as unbundled', () => {
  const root = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  assert.deepEqual(readUnbundled(root), []);
  assert.ok(readBundleMap(root).some(entry => entry.into === 'plugins/ia/config/kits/ia-kb'));
});
