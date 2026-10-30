// tools/pack-kit.mjs's write path: a recorded release is never rewritten, and
// --replace-unpublished rewrites only the entry of the version the sources
// carry. Each case packs a copy of one kit, with a copy of the tool and the
// core lib, through a stand-in CLI: restore caches the language base the copy's
// lock pins, and pack writes a fixed archive and reports its digest, as ia does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KIT = 'ia-authoring';
const sha = text => createHash('sha256').update(text).digest('hex');
const BASE = 'fake language base';
const ARCHIVE = sha('fake kit archive');

const FAKE_CLI = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [cmd] = process.argv.slice(2);
const root = process.argv[process.argv.indexOf('--root') + 1];
if (cmd === 'restore') {
  const base = JSON.parse(readFileSync(join(root, '.ia', 'distributions.lock.json'), 'utf8')).packages.find(p => p.id === 'inventarch/language');
  mkdirSync(join(root, '.ia', 'distributions', 'cache'), { recursive: true });
  writeFileSync(join(root, '.ia', 'distributions', 'cache', base.archive + '.ia.tgz'), ${JSON.stringify(BASE)});
  process.exit(0);
}
if (cmd === 'pack') {
  const bytes = Buffer.from('fake kit archive');
  const archive = createHash('sha256').update(bytes).digest('hex');
  const version = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8')).version;
  mkdirSync(join(root, '.ia', 'work', 'dist'), { recursive: true });
  writeFileSync(join(root, '.ia', 'work', 'dist', archive + '.ia.tgz'), bytes);
  process.stdout.write(JSON.stringify({ status: 'packed', archive, manifestDigest: 'm', manifest: { version } }));
  process.exit(0);
}
process.exit(2);
`;

// A copy of tools/pack-kit.mjs, the core lib and one kit whose lock pins the stand-in's base.
function packKitCopy(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'pack-kit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['tools/pack-kit.mjs', 'plugins/ia/scripts/lib', `kits/${KIT}`]) cpSync(join(ROOT, sub), join(dir, sub), { recursive: true });
  const lockFile = join(dir, 'kits', KIT, '.ia', 'distributions.lock.json');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  for (const p of lock.packages) if (p.id === 'inventarch/language') Object.assign(p, { archive: sha(BASE), location: `sha256:${sha(BASE)}` });
  writeFileSync(lockFile, JSON.stringify(lock) + '\n');
  const main = join(dir, 'cli', 'dist', 'main.mjs');
  mkdirSync(join(dir, 'cli', 'dist'), { recursive: true });
  writeFileSync(main, FAKE_CLI);
  const pack = (version, ...flags) => {
    writeFileSync(join(dir, 'cli', 'package.json'), JSON.stringify({ name: '@inventarch/cli', version }));
    return spawnSync(process.execPath, [join(dir, 'tools', 'pack-kit.mjs'), KIT, ...flags], { encoding: 'utf8', env: { ...process.env, IA_CLI_PATH: main } });
  };
  const releasesFile = join(dir, 'kits', KIT, 'releases.json');
  const version = JSON.parse(readFileSync(join(dir, 'kits', KIT, '.ia', 'release.json'), 'utf8')).version;
  return { pack, releasesFile, version, read: () => readFileSync(releasesFile, 'utf8') };
}

test('pack-kit refuses another archive for a recorded version and leaves releases.json as it was', t => {
  const { pack, read } = packKitCopy(t);
  const original = read();
  const ran = pack('3.3.0');
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /bump the version/);
  assert.equal(read(), original);
});

test('pack-kit --replace-unpublished rewrites only the entry of the version the sources carry', t => {
  const { pack, read, version } = packKitCopy(t);
  const before = JSON.parse(read());
  const ran = pack('3.3.0', '--replace-unpublished');
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const after = JSON.parse(read());
  assert.deepEqual(after.releases.filter(r => r.version !== version), before.releases.filter(r => r.version !== version), 'the other releases stay as recorded');
  const entry = after.releases.find(r => r.version === version);
  assert.equal(entry.archive, ARCHIVE);
  assert.equal(entry.manifest, 'm');
  assert.equal(entry.cli, '@inventarch/cli 3.3.0');
  assert.match(entry.language, /^inventarch\/language \^/);
  assert.equal(after.releases.length, before.releases.length);
});

test('pack-kit refuses the same sources packed with another CLI, and an identical pack records the same bytes', t => {
  const { pack, read } = packKitCopy(t);
  assert.equal(pack('3.3.0', '--replace-unpublished').status, 0);
  const recorded = read();
  let ran = pack('3.2.2');
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /packed with @inventarch\/cli 3\.3\.0.*bump the version/s);
  assert.equal(read(), recorded, 'another CLI leaves the release as recorded');
  ran = pack('3.3.0');
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.equal(read(), recorded, 'an identical pack records the same release');
});
