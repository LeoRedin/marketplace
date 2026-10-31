// Real legacy installations, not a hand-edited old lock. IA_CORE_LEGACY_ROOT is a
// catalogue checkout whose kits sit on an earlier language base, and
// IA_CORE_LEGACY_TEST_CLI the exact CLI they were packed with: the parent of the
// 3.x migration with CLI 2.0.0 (language 1.2.0), the catalogue before the 3.2.2
// move with CLI 3.1.1 (language 3.1.1), or the catalogue before the 3.3.0 move
// with CLI 3.2.2 (language 3.1.2). Install exact CLIs separately.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { adopt, findKit, listKits, readLock } from '../scripts/lib/kit.mjs';
import { resolveCli } from '../scripts/lib/cli.mjs';
import { sandbox } from './helpers/fixtures.mjs';

const current = process.env.IA_CORE_TEST_CLI;
const legacy = process.env.IA_CORE_LEGACY_TEST_CLI;
const baseline = process.env.IA_CORE_LEGACY_ROOT;
const skip = !(current && legacy && baseline) && 'set IA_CORE_TEST_CLI, IA_CORE_LEGACY_TEST_CLI and IA_CORE_LEGACY_ROOT';
const cli = entry => resolveCli('.', { cliPath: entry });
const tree = root => {
  const result = {};
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const walk = dir => { if (existsSync(dir)) for (const e of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, e.name);
    if (e.isDirectory()) walk(file); else result[relative(root, file)] = hash(file);
  } };
  walk(join(root, 'vendor'));
  for (const file of ['distributions.lock.json', 'distributions/active.json']) {
    const path = join(root, '.ia', file);
    if (existsSync(path)) result[file] = hash(path);
  }
  return result;
};
async function oldWorkspace(t, folders) {
  const root = join(sandbox(t, 'ia-core-upgrade-'), 'repo');
  mkdirSync(root);
  const init = spawnSync(process.execPath, [legacy, 'init', root, '--host', 'none', '--apply', '--yes', '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const old = await import(pathToFileURL(join(baseline, 'plugins/ia/scripts/lib/kit.mjs')));
  for (const folder of folders) {
    const kit = old.findKit(folder, join(baseline, 'plugins/ia/config/kits'));
    assert.equal(kit.latest.cli, `@inventarch/cli ${cli(legacy).version}`, 'the legacy kit release was packed with the legacy CLI');
    old.adopt(root, kit, { cli: cli(legacy) });
    assert.equal(readLock(root).packages.find(p => p.id === kit.id).version, kit.latest.version);
  }
  assert.equal(readLock(root).requests.find(p => p.id === 'inventarch/language').range, languageRange(join(baseline, 'plugins/ia/config/kits', folders[0])));
  assert.notEqual(languageRange(join(baseline, 'plugins/ia/config/kits', folders[0])), languageRange(findKit(folders[0]).dir), 'the legacy kits sit on another language base');
  return root;
}
// The inventarch/language range a kit folder's descriptor requests.
function languageRange(dir) {
  return JSON.parse(readFileSync(join(dir, '.ia', 'release.json'), 'utf8')).dependencies.find(d => d.id === 'inventarch/language').range;
}

test('real CLI: an actual earlier-base method installation upgrades and accepts dependent core kits', { skip }, async t => {
  const root = await oldWorkspace(t, ['ia-method']);
  const before = tree(root);
  adopt(root, findKit('ia-method'), { cli: cli(current), dry: true });
  assert.deepEqual(tree(root), before, 'dry-run must preserve old bytes');
  adopt(root, findKit('ia-method'), { cli: cli(current) });
  assert.equal(readLock(root).requests.find(p => p.id === 'inventarch/language').range, languageRange(findKit('ia-method').dir));
  const folders = ['ia-method', 'ia-alpha', 'ia-beta'];
  for (const folder of folders) adopt(root, findKit(folder), { cli: cli(current) });
  for (const folder of folders) {
    const kit = findKit(folder);
    assert.equal(readLock(root).packages.find(p => p.id === kit.id)?.archive, kit.latest.archive);
  }
  const installed = tree(root);
  assert.equal(adopt(root, findKit('ia-method'), { cli: cli(current) }).already, true);
  assert.deepEqual(tree(root), installed);
});

test('real CLI: installed legacy core kits move together without removing their requests', { skip }, async t => {
  const folders = ['ia-method', 'ia-alpha', 'ia-beta'];
  const root = await oldWorkspace(t, folders);
  adopt(root, findKit('ia-method'), { cli: cli(current) });
  for (const folder of folders) {
    const kit = findKit(folder);
    assert.equal(readLock(root).packages.find(p => p.id === kit.id)?.archive, kit.latest.archive);
    assert.ok(readLock(root).requests.some(p => p.id === kit.id));
  }
});

test('real CLI: a refused upgrade restores vendor bytes and preserves lock and active generation', { skip }, async t => {
  const root = await oldWorkspace(t, ['ia-method']);
  // This CLI executes real restore/pack, then simulates an installer refusal.
  const wrapper = join(root, 'refuse-install.mjs');
  writeFileSync(wrapper, `import {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2);if(a[0]==='install'){console.log(JSON.stringify({status:'refused',findings:[{code:'IA-DIST-CONFLICT'}]}));process.exit(1)}const r=spawnSync(process.execPath,[${JSON.stringify(current)},...a],{stdio:'inherit',windowsHide:true});process.exit(r.status??1);\n`);
  const before = tree(root);
  assert.throws(() => adopt(root, findKit('ia-method'), { cli: { argv: [process.execPath, wrapper], version: cli(current).version } }), /IA-DIST-CONFLICT/);
  assert.deepEqual(tree(root), before, 'no added vendor/catalog artifact after refusal');
});

// The upgrade never moves a sibling this catalogue did not publish; native resolution judges it. A legacy sibling
// whose language range excludes the new base (^1.2.0 against 3.x) is refused and the old installation preserved; one
// whose range admits it (^3.1.2 against 3.2.0) stays installed beside the moved kits, its direct request kept. A 2.0.0
// legacy root exercises the first branch, a 3.1.1 or 3.2.2 one the second; each run covers one.
test('real CLI: native resolution judges an unrecognized sibling release and keeps its direct request', { skip }, async t => {
  const root = await oldWorkspace(t, ['ia-method']);
  const old = await import(pathToFileURL(join(baseline, 'plugins/ia/scripts/lib/kit.mjs')));
  const dir = join(dirname(root), 'forked-host-kit');
  cpSync(join(baseline, 'plugins/ia/config/kits/ia-authoring'), dir, { recursive: true });
  const descriptorPath = join(dir, '.ia/release.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  descriptor.version = '0.1.9';
  writeFileSync(descriptorPath, JSON.stringify(descriptor));
  const kit = { dir, folder: 'forked-host-kit', id: descriptor.id };
  const built = old.buildKit(kit, cli(legacy));
  try { kit.latest = { version: '0.1.9', archive: built.digest, cli: `@inventarch/cli ${cli(legacy).version}` }; }
  finally { built.cleanup(); }
  old.adopt(root, kit, { cli: cli(legacy) });
  const forked = readLock(root).packages.find(p => p.id === descriptor.id).archive;
  const base = readLock(findKit('ia-method').dir).packages.find(p => p.id === 'inventarch/language').version;
  if (caretAdmits(languageRange(dir), base)) {
    adopt(root, findKit('ia-method'), { cli: cli(current) });
    assert.equal(readLock(root).packages.find(p => p.id === 'inventarch/language').version, base);
    assert.equal(readLock(root).packages.find(p => p.id === descriptor.id).archive, forked, 'the sibling stays installed');
  } else {
    const before = tree(root);
    assert.throws(() => adopt(root, findKit('ia-method'), { cli: cli(current) }), /IA-DIST-CONFLICT/);
    assert.deepEqual(tree(root), before);
  }
  assert.equal(readLock(root).requests.find(p => p.id === descriptor.id).range, '0.1.9');
});
// Whether a caret range ^X.Y.Z (X > 0) admits a version.
function caretAdmits(range, version) {
  const [low, v] = [range.replace(/^\^/, ''), version].map(s => s.split('.').map(Number));
  return v[0] === low[0] && (v[1] > low[1] || (v[1] === low[1] && v[2] >= low[2]));
}

test('real CLI: an uncertain post-commit failure retains vendor archives for the committed lock', { skip }, async t => {
  const root = await oldWorkspace(t, ['ia-method']);
  const wrapper = join(root, 'post-commit-failure.mjs');
  writeFileSync(wrapper, `import {spawnSync} from 'node:child_process';\nconst a=process.argv.slice(2);const r=spawnSync(process.execPath,[${JSON.stringify(current)},...a],{stdio:'inherit',windowsHide:true});process.exit(a[0]==='install'&&r.status===0?1:r.status??1);\n`);
  assert.throws(() => adopt(root, findKit('ia-method'), { cli: { argv: [process.execPath, wrapper], version: cli(current).version } }), e => e.code === 'IA-CORE-INSTALL-UNCERTAIN');
  const kit = findKit('ia-method');
  assert.equal(readLock(root).packages.find(p => p.id === kit.id)?.archive, kit.latest.archive);
  assert.ok(existsSync(join(root, 'vendor/ia', kit.latest.archive + '.ia.tgz')));
});
