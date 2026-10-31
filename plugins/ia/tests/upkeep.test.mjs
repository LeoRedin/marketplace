import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCRIPTS, sandbox } from './helpers/fixtures.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/upkeep/', import.meta.url));
const UPKEEP = join(SCRIPTS, 'upkeep.mjs');

function repo(t) {
  const dir = sandbox(t, 'ia-upkeep-');
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [UPKEEP, ...args, '--root', dir], { encoding: 'utf8' });
const stale = (dir, ...extra) => JSON.parse(run(dir, 'stale', '--json', ...extra).stdout);

test('a fresh workspace has never-recorded outputs, so the agent is worth starting', (t) => {
  const dir = repo(t);
  const r = run(dir, 'stale');
  assert.equal(r.status, 3);
  assert.match(r.stdout, /stale architecture-map \(never-recorded\)/);
});

test('the map goes stale when a record changes and fresh again after a rebuild', (t) => {
  const dir = repo(t);
  assert.equal(run(dir, 'build', 'architecture-map', '--allow-code').status, 0);
  writeFileSync(join(dir, 'docs/spec.plain.md'), 'plain\n');
  assert.equal(run(dir, 'record', 'spec-plain-voice').status, 0);

  const clean = run(dir, 'stale');
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, '', 'silent when nothing is stale');
  const map = readFileSync(join(dir, 'docs/architecture.mmd'), 'utf8');
  assert.match(map, /intake-spec -->\|uses\| intake-law/);
  assert.match(map, /intake-law -->\|grounded-by\| intake-spec/);

  appendFileSync(join(dir, '.ia/src/records.ia'), '\n@decision pick-voice\n  cites intake-law\n');
  const after = stale(dir);
  assert.deepEqual(after.stale.map(s => [s.id, s.reason]), [['architecture-map', 'inputs-changed']]);
  assert.equal(after.startAgent, true);

  assert.equal(run(dir, 'build', 'architecture-map', '--allow-code').status, 0);
  assert.match(readFileSync(join(dir, 'docs/architecture.mmd'), 'utf8'), /pick-voice/);
  assert.equal(run(dir, 'stale').status, 0);
});

test('a capability output goes stale when its input changes, and a hand edit is flagged, not overwritten', (t) => {
  const dir = repo(t);
  run(dir, 'build', 'architecture-map', '--allow-code');
  writeFileSync(join(dir, 'docs/spec.plain.md'), 'plain\n');
  run(dir, 'record', 'spec-plain-voice');
  appendFileSync(join(dir, 'docs/spec.md'), 'A second statement.\n');
  assert.deepEqual(stale(dir).stale.map(s => [s.id, s.reason, s.generator]), [['spec-plain-voice', 'inputs-changed', 'capability']]);

  run(dir, 'record', 'spec-plain-voice');
  writeFileSync(join(dir, 'docs/architecture.mmd'), 'graph LR\n  hand-edited\n');
  assert.deepEqual(stale(dir).stale.map(s => [s.id, s.reason]), [['architecture-map', 'output-edited']]);
});

test('a missing output is stale', (t) => {
  const dir = repo(t);
  run(dir, 'build', 'architecture-map', '--allow-code');
  writeFileSync(join(dir, 'docs/spec.plain.md'), 'plain\n');
  run(dir, 'record', 'spec-plain-voice');
  rmSync(join(dir, 'docs/architecture.mmd'));
  assert.deepEqual(stale(dir).stale.map(s => s.reason), ['output-missing']);
});

test('records that cite a changed file are listed, with the relation and line', (t) => {
  const dir = repo(t);
  run(dir, 'build', 'architecture-map', '--allow-code');
  const report = stale(dir, '--changed', 'docs/spec.md');
  assert.deepEqual(report.citing, [{ record: 'spec/intake-spec', relation: 'source', file: 'docs/spec.md', at: '.ia/src/records.ia:4' }]);
  assert.equal(report.startAgent, true);
  assert.deepEqual(stale(dir, '--changed', 'README.md').citing, []);
});

test('changed files come from git diff --name-only <base> plus untracked files', (t) => {
  const dir = repo(t);
  const git = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  appendFileSync(join(dir, 'docs/spec.md'), 'changed\n');
  const report = stale(dir, '--base', 'HEAD');
  assert.ok(report.changed.includes('docs/spec.md'));
  assert.equal(report.citing[0].record, 'spec/intake-spec');
});

test('build refuses without --allow-code, and a malformed sidecar is a usage error', (t) => {
  const dir = repo(t);
  assert.equal(run(dir, 'build').status, 2);
  writeFileSync(join(dir, 'derived.json'), JSON.stringify({ format: 1, outputs: [{ id: 'x', inputs: ['../a'], output: 'o', generator: { script: 's.mjs' } }] }));
  const r = run(dir, 'stale');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /root-relative globs/);
});
