// tools/check-language.mjs against a fake @inventarch/cli: every kit and the repository's own records are restored and
// validated in scratch copies by the pinned CLI, a refusal exits 1 naming its root, and a missing or different CLI exits 2.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'check-language.mjs');
const LANGUAGE_LOCK = {
  engine: '0.1.1', formatVersion: 1,
  packages: [{ archive: 'a'.repeat(64), dependencies: [], id: 'inventarch/language', version: '9.0.0' }],
  requests: [{ id: 'inventarch/language', range: '^9.0.0' }],
};
// The fake answers restore and validate like the real CLI's --json output; a source containing REFUSE-ME is refused.
const FAKE_MAIN = `
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const root = argv[argv.indexOf('--root') + 1];
if (process.env.FAKE_IA_LOG) appendFileSync(process.env.FAKE_IA_LOG, JSON.stringify({ argv, home: process.env.IA_HOME ?? null }) + '\\n');
const out = value => { process.stdout.write(JSON.stringify(value)); };
if (argv[0] === 'restore') {
  if (!existsSync(join(root, '.ia', 'distributions.lock.json'))) { out({ ok: false, code: 'IA-DIST-INPUT-INVALID', message: 'Missing input .ia/distributions.lock.json' }); process.exit(3); }
  out({ applied: { status: 'installed' } });
} else if (argv[0] === 'validate') {
  const walk = dir => readdirSync(dir).flatMap(n => statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]);
  const refused = walk(join(root, '.ia')).filter(f => readFileSync(f, 'utf8').includes('REFUSE-ME'));
  if (refused.length) { out({ status: 'refused', counts: { errors: refused.length, warnings: 0 }, findings: refused.map(f => ({ severity: 'error', code: 'IA-FAKE-REFUSED', path: f, line: 1, message: 'refused by the fake' })) }); process.exit(1); }
  out({ status: 'admitted', counts: { errors: 0, warnings: 2 }, findings: [] });
} else { out({ ok: false, code: 'IA-CLI-USAGE' }); process.exit(2); }
`;

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2) + '\n');
}

function fixture(t, { cliVersion = '9.9.9', refuseKit = false } = {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'check-language-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  write(join(repo, 'sources.lock.json'), { released: { cli: '9.9.9', languageVersion: '9.0.0' } });
  write(join(repo, '.ia', 'src', 'self.ia'), '#! ia 1.0\n\n@workspace demo\n');
  const kit = join(repo, 'plugins', 'demo', 'config', 'kit');
  write(join(kit, '.ia', 'distributions.lock.json'), LANGUAGE_LOCK);
  write(join(kit, '.ia', 'src', 'kit.ia'), '#! ia 1.0\n' + (refuseKit ? 'REFUSE-ME\n' : ''));
  write(join(kit, 'assets', 'guide.md'), '# Guide\n');
  // A restored distribution folder is ignored state, never part of the copy.
  write(join(kit, '.ia', 'distributions', 'stale', 'REFUSE-ME.ia'), 'REFUSE-ME\n');
  const cli = join(dir, 'fake-cli');
  write(join(cli, 'package.json'), { name: '@inventarch/cli', version: cliVersion, type: 'module' });
  write(join(cli, 'dist', 'main.js'), FAKE_MAIN);
  return { repo, entry: join(cli, 'dist', 'main.js'), log: join(dir, 'calls.jsonl') };
}

function run(args, env = {}) {
  const ran = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, IA_CLI_PATH: '', ...env } });
  let json;
  try { json = JSON.parse(ran.stdout); } catch { json = undefined; }
  return { code: ran.status, stdout: ran.stdout, stderr: ran.stderr, json };
}

test('admits every kit and the repository\'s own records with the pinned CLI', t => {
  const { repo, entry, log } = fixture(t);
  const ran = run(['--root', repo, '--cli', entry], { FAKE_IA_LOG: log });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.json.status, 'admitted');
  assert.equal(ran.json.cli, '9.9.9');
  assert.deepEqual(ran.json.roots.map(r => [r.root, r.status, r.errors]), [['.ia/src', 'admitted', 0], ['plugins/demo/config/kit', 'admitted', 0]]);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(c => c.argv[0]).sort(), ['restore', 'restore', 'validate', 'validate']);
  for (const call of calls) {
    assert.ok(!call.argv[call.argv.indexOf('--root') + 1].startsWith(repo), 'the CLI runs on a scratch copy, never the checkout');
    assert.ok(call.home && !call.home.startsWith(repo), 'IA_HOME is a scratch folder');
  }
});

test('the CLI comes from IA_CLI_PATH when --cli is absent', t => {
  const { repo, entry } = fixture(t);
  const ran = run(['--root', repo], { IA_CLI_PATH: entry });
  assert.equal(ran.code, 0, ran.stderr);
});

test('a refused kit exits 1 and names its root and finding', t => {
  const { repo, entry } = fixture(t, { refuseKit: true });
  const ran = run(['--root', repo, '--cli', entry]);
  assert.equal(ran.code, 1);
  assert.equal(ran.json.status, 'refused');
  assert.match(ran.stderr, /plugins\/demo\/config\/kit: refused[\s\S]*IA-FAKE-REFUSED/);
});

test('a CLI other than the one sources.lock.json pins exits 2', t => {
  const { repo, entry } = fixture(t, { cliVersion: '9.9.8' });
  const ran = run(['--root', repo, '--cli', entry]);
  assert.equal(ran.code, 2);
  assert.match(ran.stderr, /9\.9\.8.*sources\.lock\.json pins 9\.9\.9/);
});

test('an unreadable sources.lock.json or kit lock exits 2, not as a refusal', t => {
  const { repo, entry } = fixture(t);
  writeFileSync(join(repo, 'plugins', 'demo', 'config', 'kit', '.ia', 'distributions.lock.json'), '{ not json');
  let ran = run(['--root', repo, '--cli', entry]);
  assert.equal(ran.code, 2);
  assert.match(ran.stderr, /distributions\.lock\.json/);
  writeFileSync(join(repo, 'sources.lock.json'), '{ not json');
  ran = run(['--root', repo, '--cli', entry]);
  assert.equal(ran.code, 2);
  assert.match(ran.stderr, /sources\.lock\.json/);
});

test('a missing CLI exits 2 and says how to install it', t => {
  const { repo } = fixture(t);
  const ran = run(['--root', repo]);
  assert.equal(ran.code, 2);
  assert.match(ran.stderr, /npm ci/);
});
