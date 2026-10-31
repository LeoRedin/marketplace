// Kits carry their declared assets: sourcesDigest hashes them (and checks.json)
// beside .ia/, a missing, absolute or escaping asset path is a KitError, and
// buildKit copies every declared asset into the pack root before `ia pack`
// runs there. Every copy lives in a sandbox the test removes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKit, DEFAULT_KITS_DIR, findKit, KitError, sourcesDigest } from '../scripts/lib/kit.mjs';
import { sandbox } from './helpers/fixtures.mjs';

const KITS = resolve(dirname(fileURLToPath(import.meta.url)), '../config/kits');
const copyKit = t => {
  const kit = join(sandbox(t, 'ia-core-kit-assets-'), 'kits', 'ia-kb');
  cpSync(join(KITS, 'ia-kb'), kit, { recursive: true });
  return kit;
};

test('an edited declared asset changes the sources digest', t => {
  const kit = copyKit(t);
  const before = sourcesDigest(kit);
  writeFileSync(join(kit, 'assets/kb-placement.md'), '# changed\n');
  assert.notEqual(sourcesDigest(kit), before);
});

test('an edited checks.json changes the sources digest', t => {
  const kit = copyKit(t);
  const before = sourcesDigest(kit);
  writeFileSync(join(kit, 'checks.json'), readFileSync(join(kit, 'checks.json'), 'utf8') + '\n');
  assert.notEqual(sourcesDigest(kit), before);
});

test('CRLF in a declared asset does not change the digest', t => {
  const kit = copyKit(t);
  const before = sourcesDigest(kit);
  const path = join(kit, 'assets/kb-placement.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  assert.equal(sourcesDigest(kit), before);
});

test('a declared asset that is missing is a KitError naming the path', t => {
  const kit = copyKit(t);
  const descriptor = join(kit, '.ia/release.json');
  const parsed = JSON.parse(readFileSync(descriptor, 'utf8'));
  parsed.assets.push({ path: 'assets/absent.mjs', role: 'script' });
  writeFileSync(descriptor, JSON.stringify(parsed));
  assert.throws(() => sourcesDigest(kit), e => e instanceof KitError && e.message.includes('assets/absent.mjs') && /is missing from/.test(e.message));
});

test('an asset path that is absolute or escapes the kit is refused by the escape check, even when the file exists', t => {
  // The escaping targets exist (a file beside the kit, and its absolute path),
  // so only the escape check can refuse them, not the missing-file check.
  const outside = join(copyKit(t), '..', 'outside.md');
  writeFileSync(outside, '# outside the kit\n');
  for (const bad of ['../outside.md', outside, outside.replace(/\\/g, '/'), '/etc/passwd', 'C:/Windows/win.ini']) {
    const copy = copyKit(t);
    writeFileSync(join(copy, '..', 'outside.md'), '# outside the kit\n');
    const descriptor = join(copy, '.ia/release.json');
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8'));
    parsed.assets.push({ path: bad, role: 'documentation' });
    writeFileSync(descriptor, JSON.stringify(parsed));
    assert.throws(() => sourcesDigest(copy), e => e instanceof KitError && /is absolute or leaves the kit/.test(e.message), bad);
  }
});

// A stand-in CLI: `restore` succeeds; `pack` does not pack but reports which
// of the descriptor's assets exist under the pack root, so buildKit's refusal
// message carries what it found there.
test('buildKit copies every declared asset into the pack root before ia pack runs there', t => {
  const dir = sandbox(t, 'ia-core-kit-assets-pack-');
  const main = join(dir, 'cli', 'main.mjs');
  mkdirSync(dirname(main), { recursive: true });
  writeFileSync(main, [
    "import { existsSync, readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const args = process.argv.slice(2);',
    "const root = args[args.indexOf('--root') + 1];",
    "if (args[0] === 'restore') { process.stdout.write(JSON.stringify({ status: 'restored' })); process.exit(0); }",
    "if (args[0] === 'pack') {",
    "  const assets = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8')).assets.map(a => a.path);",
    "  process.stdout.write(JSON.stringify({ status: 'probe', present: assets.filter(p => existsSync(join(root, p))), absent: assets.filter(p => !existsSync(join(root, p))) }));",
    '  process.exit(0);',
    '}',
    'process.exit(2);',
    '',
  ].join(String.fromCharCode(10)));
  const kit = findKit('ia-kb', DEFAULT_KITS_DIR);
  const declared = JSON.parse(readFileSync(join(kit.dir, '.ia', 'release.json'), 'utf8')).assets.map(a => a.path);
  assert.ok(declared.length >= 5);
  let report;
  assert.throws(() => buildKit(kit, { argv: [process.execPath, main], version: '3.1.1' }), e => {
    assert.ok(e instanceof KitError, String(e));
    report = JSON.parse(e.message.slice(e.message.indexOf('{')));
    return true;
  });
  assert.equal(report.status, 'probe');
  assert.deepEqual(report.absent, [], 'every declared asset is in the pack root');
  assert.deepEqual([...report.present].sort(), [...declared].sort());
});
