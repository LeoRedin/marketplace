// Required real-consumer journey for inventarch/ia-kb-kit (REQ-KB-09 of the
// ia-kb contract): npm ci installs the repository's pinned CLI, a fresh
// workspace adopts the kit, and the declared task-manifest check runs the
// kit's locator checker on the task's own manifest through the core's runner,
// never falling back to the kit's example.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PLUGIN = join(ROOT, 'plugins/ia');
const CLI = join(ROOT, 'node_modules/@inventarch/cli/dist/main.js');
const KIT = join(PLUGIN, 'config/kits/ia-kb');

function world(t) {
  assert.ok(existsSync(CLI), 'npm ci must install the pinned CLI before running the ingestion journey');
  const scratch = mkdtempSync(join(tmpdir(), 'ia-kb-ingestion-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const env = { ...process.env, IA_HOME: join(scratch, 'home'), IA_CLI_PATH: CLI, TMPDIR: scratch, TEMP: scratch, TMP: scratch, IA_CORE_CLOSURES_DIR: join(scratch, 'closures') };
  delete env.IA_CORE_KITS_DIR;
  delete env.IA_CORE_RUN_ROOT;
  function run(entry, args, cwd = scratch) {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    assert.ifError(result.error);
    let json;
    try { json = JSON.parse(result.stdout); } catch { assert.fail(result.stdout + result.stderr); }
    return { ...result, json };
  }
  function ok(entry, args, cwd) {
    const result = run(entry, args, cwd);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.json;
  }
  return { scratch, run, ok };
}

test('adopted KB kit checks the task manifest and delivers its gate-runner profile', t => {
  const { scratch, run, ok } = world(t);
  const repo = join(scratch, 'consumer');
  ok(CLI, ['init', repo, '--host', 'none', '--apply', '--yes', '--json']);
  const kitScript = join(PLUGIN, 'scripts/kit.mjs');
  const adopted = ok(kitScript, ['adopt', 'ia-kb', repo], repo);
  assert.equal(adopted.version, JSON.parse(readFileSync(join(KIT, '.ia/release.json'), 'utf8')).version);
  assert.ok(adopted.written.length);
  assert.equal(ok(kitScript, ['adopt', 'ia-kb', repo], repo).already, true);
  const status = ok(kitScript, ['status', 'ia-kb', repo], repo);
  assert.equal(status.current, true);
  assert.equal(status.installed.archive, JSON.parse(readFileSync(join(KIT, 'releases.json'), 'utf8')).releases.at(-1).archive);
  writeFileSync(join(repo, '.ia/bindings.json'), JSON.stringify({ format: 1, bindings: { 'knowledge.check': { kit: 'inventarch/ia-kb-kit', capability: 'kb-gates' } } }));
  const packet = ok(join(PLUGIN, 'scripts/resolve.mjs'), ['--entry', 'knowledge', '--activity', 'check', '--root', repo], repo);
  assert.equal(packet.role.profile, 'agent-composition-system/binding/agent-profile/kb-gate-runner-profile');
  assert.ok(packet.evidence.required.includes('kb-check-task-locators'));
  assert.ok(packet.role.brief.includes('--manifest'));
  mkdirSync(join(repo, 'docs'));
  const manifest = JSON.parse(readFileSync(join(KIT, 'assets/examples/split-body/locators.json'), 'utf8'));
  manifest.documents[0].documentId = 'task-specific-document';
  const path = join(repo, 'docs/task locators.json');
  writeFileSync(path, JSON.stringify(manifest));
  const check = join(PLUGIN, 'scripts/check.mjs');
  const args = ['kb-check-task-locators', '--root', repo, '--manifest', 'docs/task locators.json'];
  const passed = ok(check, args, repo);
  // Match the runner's native canonicalization, including Windows 8.3 aliases.
  assert.equal(passed.argv.at(-1), realpathSync.native(path));
  const report = JSON.parse(passed.stdout);
  assert.equal(report.documents[0].documentId, 'task-specific-document');
  assert.equal(report.documents[0].standing, 'metadata-only; bytes unavailable');
  assert.equal(report.networkRequests, 0);
  assert.equal(report.bodyDisclosure, false);
  assert.equal(report.nativeGraphClosure, 'not evaluated');
  const admission = ok(check, ['kb-check-validate', '--root', repo], repo);
  assert.equal(JSON.parse(admission.stdout).counts.errors, 0);
  manifest.documents[0].commit = 'main';
  writeFileSync(path, JSON.stringify(manifest));
  const failed = run(check, args, repo);
  assert.equal(failed.status, 3);
  assert.match(failed.json.stderr, /exact object ID/);
  assert.equal(run(check, ['kb-check-task-locators', '--root', repo], repo).status, 2);
  assert.equal(run(check, ['kb-check-locators', '--root', repo, '--manifest', 'docs/task locators.json'], repo).status, 2);
});
