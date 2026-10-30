// adopt() on a language-base move, against a stand-in CLI so it runs in every
// gate (install-upgrade.test.mjs repeats the journeys with real CLIs, opt-in).
// The stand-in packs a kit to bytes named by its id and version, restores the
// language base to fixed bytes, and installs, refuses or fails as
// STAND_IN_INSTALL says, logging every argv to STAND_IN_LOG.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { adopt, findKit, readLock } from '../scripts/lib/kit.mjs';
import { sandbox } from './helpers/fixtures.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const OLD_BASE = 'stand-in language 1.2.0';
const BASE = 'stand-in language 3.1.1';
const packed = (id, version) => `stand-in archive ${id}@${version}`;
const archive = (id, version) => sha(packed(id, version));

const STAND_IN = `import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2), at = k => args[args.indexOf(k) + 1], root = at('--root');
const sha = b => createHash('sha256').update(b).digest('hex');
const write = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const print = v => process.stdout.write(JSON.stringify(v) + '\\n');
if (process.env.STAND_IN_LOG) appendFileSync(process.env.STAND_IN_LOG, JSON.stringify(args) + '\\n');
const lockPath = join(root, '.ia', 'distributions.lock.json'), activePath = join(root, '.ia', 'distributions', 'active.json');
if (args[0] === 'restore') {
  for (const p of JSON.parse(readFileSync(lockPath, 'utf8')).packages) write(join(root, '.ia', 'distributions', 'cache', p.archive + '.ia.tgz'), ${JSON.stringify(BASE)});
  print({ status: 'restored' });
} else if (args[0] === 'pack') {
  const d = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8')), bytes = 'stand-in archive ' + d.id + '@' + d.version;
  write(join(root, '.ia', 'work', 'dist', sha(bytes) + '.ia.tgz'), bytes);
  print({ status: 'packed', archive: sha(bytes), manifestDigest: sha('manifest ' + bytes), manifest: { version: d.version } });
} else if (args[0] === 'install') {
  const mode = process.env.STAND_IN_INSTALL || 'ok';
  if (mode === 'refuse') { print({ status: 'refused', findings: [{ code: 'IA-DIST-CONFLICT', message: 'inventarch/language: ranges conflict' }] }); process.exit(1); }
  if (mode === 'hang') { setTimeout(() => process.exit(0), 20000); }
  else if (mode === 'active-only') { write(activePath, JSON.stringify({ generation: 99 })); process.exit(1); }
  else if (mode === 'lock-dir') { rmSync(lockPath); mkdirSync(lockPath); process.exit(1); }
  else {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    for (const request of args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'))) {
      const cut = request.lastIndexOf('@'), id = request.slice(0, cut), range = request.slice(cut + 1);
      const pkg = id === 'inventarch/language' ? { id, version: '3.1.1', archive: sha(${JSON.stringify(BASE)}), dependencies: [] } : { id, version: range, archive: sha('stand-in archive ' + id + '@' + range), dependencies: ['inventarch/language'] };
      lock.packages = [...lock.packages.filter(p => p.id !== id), pkg];
      lock.requests = [...lock.requests.filter(r => r.id !== id), { id, range }];
    }
    write(lockPath, JSON.stringify(lock));
    write(activePath, JSON.stringify({ generation: (existsSync(activePath) ? JSON.parse(readFileSync(activePath, 'utf8')).generation : 0) + 1 }));
    if (mode === 'post-commit') process.exit(1);
    print({ status: 'installed' });
  }
} else { process.stderr.write('stand-in: unsupported ' + args[0] + '\\n'); process.exit(2); }
`;

// A kit folder whose releases are 0.1.0 (CLI 2.0.0, the old base) then 0.2.0
// (CLI 3.1.1); the stand-in packs its sources to the 0.2.0 archive.
function kit(kitsDir, folder) {
  const id = `inventarch/${folder}-kit`, dir = join(kitsDir, folder);
  mkdirSync(join(dir, '.ia', 'src'), { recursive: true });
  writeFileSync(join(dir, '.ia', 'src', 'workspace.ia'), `#! ia 1.0\n\n@workspace ${folder}-kit\n`);
  writeFileSync(join(dir, '.ia', 'release.json'), JSON.stringify({ formatVersion: 1, id, version: '0.2.0', engine: '^0.1.1', language: ['1.0'], dependencies: [{ id: 'inventarch/language', range: '^3.1.1', systems: [] }], assets: [] }));
  writeFileSync(join(dir, '.ia', 'distributions.lock.json'), JSON.stringify({ engine: '0.1.1', formatVersion: 1, packages: [{ id: 'inventarch/language', version: '3.1.1', archive: sha(BASE), dependencies: [] }], requests: [{ id: 'inventarch/language', range: '^3.1.1' }] }));
  writeFileSync(join(dir, 'releases.json'), JSON.stringify({ kit: id, releases: [
    { version: '0.1.0', archive: archive(id, '0.1.0'), cli: '@inventarch/cli 2.0.0', language: 'inventarch/language ^1.2.0' },
    { version: '0.2.0', archive: archive(id, '0.2.0'), cli: '@inventarch/cli 3.1.1', language: 'inventarch/language ^3.1.1' },
  ] }));
  return id;
}

// A consumer workspace. kits: { id: version or { archive } } already installed;
// base: the language bytes its lock pins. vendor/ia holds what an earlier
// adopt wrote, unless fresh.
function consumer(dir, { kits = {}, base = OLD_BASE, extra = [], fresh = false } = {}) {
  const root = join(dir, 'repo');
  mkdirSync(join(root, '.ia', 'src'), { recursive: true });
  writeFileSync(join(root, '.ia', 'src', 'workspace.ia'), '#! ia 1.0\n\n@workspace repo\n');
  const range = base === BASE ? '^3.1.1' : '^1.2.0';
  const packages = [{ id: 'inventarch/language', version: base === BASE ? '3.1.1' : '1.2.0', archive: sha(base), dependencies: [] }, ...extra];
  const requests = [{ id: 'inventarch/language', range }, ...extra.map(p => ({ id: p.id, range: p.version }))];
  for (const [id, v] of Object.entries(kits)) {
    const a = typeof v === 'string' ? archive(id, v) : v.archive;
    packages.push({ id, version: typeof v === 'string' ? v : '0.1.0', archive: a, dependencies: ['inventarch/language'] });
    requests.push({ id, range: typeof v === 'string' ? v : '0.1.0' });
  }
  writeFileSync(join(root, '.ia', 'distributions.lock.json'), JSON.stringify({ engine: '0.1.1', formatVersion: 1, packages, requests }));
  mkdirSync(join(root, '.ia', 'distributions'), { recursive: true });
  writeFileSync(join(root, '.ia', 'distributions', 'active.json'), JSON.stringify({ generation: 1 }));
  if (!fresh) {
    mkdirSync(join(root, 'vendor', 'ia'), { recursive: true });
    const entries = packages.map(p => ({ path: `vendor/ia/${p.archive}.ia.tgz`, withdrawn: false }));
    for (const p of packages) writeFileSync(join(root, 'vendor', 'ia', `${p.archive}.ia.tgz`), `old bytes of ${p.id}`);
    writeFileSync(join(root, 'vendor', 'ia', 'catalog.json'), JSON.stringify(entries, null, 2) + '\n');
  }
  return root;
}

function setup(t, prefix) {
  const dir = sandbox(t, prefix), kitsDir = join(dir, 'kits'), standIn = join(dir, 'stand-in.mjs'), log = join(dir, 'calls.jsonl');
  writeFileSync(standIn, STAND_IN);
  const previous = { mode: process.env.STAND_IN_INSTALL, log: process.env.STAND_IN_LOG };
  process.env.STAND_IN_LOG = log;
  t.after(() => {
    for (const [key, value] of [['STAND_IN_INSTALL', previous.mode], ['STAND_IN_LOG', previous.log]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const method = kit(kitsDir, 'fake-method'), engineering = kit(kitsDir, 'fake-engineering');
  const cli = { argv: [process.execPath, standIn], version: '3.1.1' };
  const installs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []).filter(a => a[0] === 'install');
  return { dir, kitsDir, cli, method, engineering, installs, find: folder => findKit(folder, kitsDir) };
}

const tree = root => {
  const result = {};
  const walk = d => { if (existsSync(d)) for (const e of readdirSync(d, { withFileTypes: true })) {
    const file = join(d, e.name);
    if (e.isDirectory()) walk(file); else result[relative(root, file).replace(/\\/g, '/')] = sha(readFileSync(file));
  } };
  walk(join(root, 'vendor'));
  walk(join(root, '.ia'));
  return result;
};

test('a language move: the dry run names every kit and request the install will change, and writes nothing', t => {
  const s = setup(t, 'ia-core-adopt-dry-');
  const root = consumer(s.dir, { kits: { [s.method]: '0.1.0', [s.engineering]: '0.1.0' } });
  const before = tree(root);
  const dry = adopt(root, s.find('fake-method'), { cli: s.cli, dry: true });
  const upgraded = [{ kit: s.engineering, version: '0.2.0', archive: archive(s.engineering, '0.2.0') }];
  const requests = [`${s.method}@0.2.0`, `${s.engineering}@0.2.0`, 'inventarch/language@^3.1.1'];
  assert.equal(dry.dry, true);
  assert.deepEqual(dry.upgraded, upgraded);
  assert.deepEqual(dry.requests, requests);
  assert.deepEqual(tree(root), before, 'a dry run writes nothing');
  assert.deepEqual(s.installs(), [], 'a dry run never runs ia install');

  const real = adopt(root, s.find('fake-method'), { cli: s.cli });
  assert.deepEqual(real.upgraded, upgraded);
  assert.deepEqual(real.requests, requests);
  assert.equal(s.installs().length, 1, 'one native install moves every kit and the base together');
  assert.deepEqual(s.installs()[0].slice(1, 4), requests);
  const lock = readLock(root);
  assert.equal(lock.requests.find(r => r.id === 'inventarch/language').range, '^3.1.1');
  for (const id of [s.method, s.engineering]) assert.equal(lock.packages.find(p => p.id === id).archive, archive(id, '0.2.0'));
  for (const id of [s.method, s.engineering]) assert.ok(existsSync(join(root, 'vendor', 'ia', `${archive(id, '0.2.0')}.ia.tgz`)));

  const again = adopt(root, s.find('fake-method'), { cli: s.cli });
  assert.equal(again.already, true);
  assert.deepEqual(again.upgraded, []);
});

test('a language move leaves a sibling whose installed archive this catalogue never released', t => {
  const s = setup(t, 'ia-core-adopt-fork-');
  const root = consumer(s.dir, { kits: { [s.method]: '0.1.0', [s.engineering]: { archive: sha('a fork') } } });
  const result = adopt(root, s.find('fake-method'), { cli: s.cli, dry: true });
  assert.deepEqual(result.upgraded, []);
  assert.deepEqual(result.requests, [`${s.method}@0.2.0`, 'inventarch/language@^3.1.1']);
});

test('no language move: adopt requests the kit alone and reports no other upgrade', t => {
  const s = setup(t, 'ia-core-adopt-same-');
  const root = consumer(s.dir, { base: BASE, kits: { [s.engineering]: '0.1.0' } });
  const result = adopt(root, s.find('fake-method'), { cli: s.cli });
  assert.deepEqual(result.upgraded, []);
  assert.deepEqual(result.requests, [`${s.method}@0.2.0`]);
  assert.equal(readLock(root).packages.find(p => p.id === s.engineering).archive, archive(s.engineering, '0.1.0'));
});

test('a refused first adoption leaves no vendor folder behind', t => {
  const s = setup(t, 'ia-core-adopt-fresh-');
  const root = consumer(s.dir, { base: BASE, fresh: true });
  const before = tree(root);
  process.env.STAND_IN_INSTALL = 'refuse';
  assert.throws(() => adopt(root, s.find('fake-method'), { cli: s.cli }), /IA-DIST-CONFLICT/);
  assert.equal(existsSync(join(root, 'vendor')), false);
  assert.deepEqual(tree(root), before);
});

test('a refused language move restores the vendor bytes and names the packages that still need the old base', t => {
  const s = setup(t, 'ia-core-adopt-refuse-');
  const other = { id: 'inventarch/other-kit', version: '0.3.0', archive: sha('another catalogue'), dependencies: ['inventarch/language'] };
  const root = consumer(s.dir, { kits: { [s.method]: '0.1.0' }, extra: [other] });
  const before = tree(root);
  process.env.STAND_IN_INSTALL = 'refuse';
  assert.throws(() => adopt(root, s.find('fake-method'), { cli: s.cli }), e => /IA-DIST-CONFLICT/.test(e.message) && /inventarch\/other-kit still/.test(e.message));
  assert.deepEqual(tree(root), before);
});

for (const [mode, why] of [['post-commit', 'the lock changed before a failing exit'], ['active-only', 'only the active generation changed'], ['lock-dir', 'the lock can no longer be read']]) {
  test(`an install failure after a native effect is uncertain and keeps the vendored archives: ${why}`, t => {
    const s = setup(t, 'ia-core-adopt-uncertain-');
    const root = consumer(s.dir, { kits: { [s.method]: '0.1.0' } });
    process.env.STAND_IN_INSTALL = mode;
    assert.throws(() => adopt(root, s.find('fake-method'), { cli: s.cli }), e => e.code === 'IA-CORE-INSTALL-UNCERTAIN');
    assert.ok(existsSync(join(root, 'vendor', 'ia', `${archive(s.method, '0.2.0')}.ia.tgz`)));
    assert.ok(existsSync(join(root, 'vendor', 'ia', `${sha(BASE)}.ia.tgz`)));
    assert.ok(JSON.parse(readFileSync(join(root, 'vendor', 'ia', 'catalog.json'), 'utf8')).some(e => e.path === `vendor/ia/${archive(s.method, '0.2.0')}.ia.tgz`));
  });
}

test('an install that did not exit on its own is uncertain: its process may still commit', t => {
  const s = setup(t, 'ia-core-adopt-killed-');
  const root = consumer(s.dir, { kits: { [s.method]: '0.1.0' } });
  process.env.STAND_IN_INSTALL = 'hang';
  assert.throws(() => adopt(root, s.find('fake-method'), { cli: s.cli, installTimeoutMs: 1500 }), e => e.code === 'IA-CORE-INSTALL-UNCERTAIN');
  assert.ok(existsSync(join(root, 'vendor', 'ia', `${archive(s.method, '0.2.0')}.ia.tgz`)));
});

test('a link at a vendor path is refused before anything is written, and left in place', t => {
  const s = setup(t, 'ia-core-adopt-link-');
  const root = consumer(s.dir, { base: BASE, fresh: true });
  mkdirSync(join(root, 'vendor', 'ia'), { recursive: true });
  const link = join(root, 'vendor', 'ia', 'catalog.json');
  symlinkSync(join(s.dir, 'nowhere'), link, 'junction');
  assert.throws(() => adopt(root, s.find('fake-method'), { cli: s.cli }), e => e.code === 'IA-CORE-KIT' && /not a regular file/.test(e.message));
  assert.ok(lstatSync(link).isSymbolicLink(), 'the link adopt did not create is still there');
  assert.deepEqual(readdirSync(join(root, 'vendor', 'ia')), ['catalog.json']);
  assert.deepEqual(s.installs(), []);
});

test('a sibling whose sources no longer pack to its release is named in the refusal', t => {
  const s = setup(t, 'ia-core-adopt-drift-');
  const root = consumer(s.dir, { kits: { [s.method]: '0.1.0', [s.engineering]: '0.1.0' } });
  const descriptor = join(s.kitsDir, 'fake-engineering', '.ia', 'release.json');
  writeFileSync(descriptor, readFileSync(descriptor, 'utf8').replace('"0.2.0"', '"0.2.0-edited"'));
  const before = tree(root);
  assert.throws(() => adopt(root, s.find('fake-method'), { cli: s.cli }), e => e.message.includes(s.engineering));
  assert.deepEqual(tree(root), before);
});
