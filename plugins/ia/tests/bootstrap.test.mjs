// bootstrap.mjs: silent outside an IA workspace; inside one, one valid JSON
// SessionStart payload of at most 2,500 characters naming the workspace, the
// installed kits, the bindings grouped by kit and the resolve instruction,
// which survives however many keys are bound; exit 0 always, with or without
// a CLI.
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boundKeys, LIMIT } from '../scripts/bootstrap.mjs';
import { envFor, fakeCli, makeKit, makeRepo, run, sandbox } from './helpers/fixtures.mjs';

const hook = (cwd, env) => run('bootstrap.mjs', [], env, { input: JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', cwd }) });

test('outside an IA workspace the hook prints nothing and exits 0', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const env = envFor({ cli: fakeCli(dir), kitsDir: join(dir, 'kits'), temp: dir });
  const out = hook(join(dir, 'temp'), env);
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
  const garbage = run('bootstrap.mjs', [], env, { input: 'not json', cwd: join(dir, 'temp') });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});

test('inside a workspace it prints one SessionStart payload of at most 2000 characters with identity, kits, bindings and the instruction', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const alpha = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit' });
  const repo = makeRepo(join(dir, 'repo'), {
    bindings: { format: 1, bindings: { 'delivery.review': { kit: alpha.id, capability: alpha.capability }, 'work.*': { kit: alpha.id, capability: alpha.capability } }, precedence: [alpha.id], defaults: { knowledge: { kit: alpha.id, capability: alpha.capability } } },
    lock: { engine: '0.1.0', formatVersion: 1, packages: [{ id: 'inventarch/language', version: '1.2.0', archive: 'a'.repeat(64) }, { id: alpha.id, version: '0.1.0', archive: alpha.archive }] },
  });
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>' } });
  const out = hook(join(repo, 'sub'), env);
  assert.equal(out.status, 0, out.stderr);
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = payload.hookSpecificOutput.additionalContext;
  assert.ok(text.length <= LIMIT && LIMIT === 2500, `${text.length} chars`);
  assert.match(text, /^This repository is an InventArch workspace\. Before any other skill/, 'the routing instruction comes first');
  assert.match(text, /`ia:delivery`.*`ia:work`.*`ia:knowledge`/s);
  assert.match(text, /workspace-system\/definition\/workspace\/fake/);
  assert.match(text, /revision rev-fake/);
  assert.match(text, /Kits installed: inventarch\/alpha-kit@0\.1\.0\./);
  assert.match(text, /Bindings \(\.ia\/bindings\.json\): inventarch\/alpha-kit: delivery\.review, work\.\*; defaults for knowledge; precedence inventarch\/alpha-kit\./);
  assert.match(text, /node "<plugin>\/scripts\/resolve\.mjs" --entry <work\|delivery\|knowledge> --activity <activity>/);
  assert.equal(out.stdout.trim().split('\n').length, 1, 'one JSON line');
});

test('bound keys are grouped by kit, and however many there are the resolve instruction still closes the payload', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const kitsDir = join(dir, 'kits');
  const alpha = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit' });
  const beta = makeKit(kitsDir, { folder: 'beta', id: 'inventarch/beta-kit' });
  const one = { kit: alpha.id, capability: alpha.capability };
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`delivery.activity-number-${i}`, { kit: beta.id, capability: beta.capability }]));
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'delivery.review': one, 'delivery.change': one, 'work.*': [one, { kit: beta.id, capability: beta.capability }], ...many }, precedence: [alpha.id, beta.id] } });
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: dir, extra: { CLAUDE_PLUGIN_ROOT: '<plugin>' } });
  const out = hook(repo, env);
  assert.equal(out.status, 0, out.stderr);
  const text = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.ok(text.length <= LIMIT, `${text.length} chars`);
  assert.match(text, /inventarch\/alpha-kit: delivery\.\{review, change\}, work\.\*; inventarch\/beta-kit: work\.\*, delivery\.\{activity-number-0, /, 'a key with two candidates is listed under both kits');
  assert.match(text, / \.\.\. \(truncated; bind\.mjs show lists every key\); precedence inventarch\/alpha-kit > inventarch\/beta-kit\./);
  assert.match(text, /\nResolve before acting: node "<plugin>\/scripts\/resolve\.mjs" --entry .*\(ia:init has the protocol\)\.$/, 'the resolve instruction is whole and last');
  assert.equal(boundKeys({ bindings: { 'work.task': [one, { kit: alpha.id, capability: 'other' }] } }), 'inventarch/alpha-kit: work.task', 'two candidates of one kit list the key once');
});

test('without any CLI it still reports from the sources, and without bindings it says nothing is bound', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const repo = makeRepo(join(dir, 'repo'));
  const env = envFor({ cli: join(dir, 'absent', 'main.js'), kitsDir: join(dir, 'kits'), temp: dir, extra: { IA_CORE_NO_NPX: '1' } });
  const out = hook(repo, env);
  assert.equal(out.status, 0, out.stderr);
  const text = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /@workspace repo \(identity unread\)/);
  assert.match(text, /IA CLI unavailable: IA-CORE-CLI-MISSING/);
  assert.match(text, /Kits installed: none/);
  assert.match(text, /no \.ia\/bindings\.json, so no method is bound.*kit\.mjs bind <kit> --apply/);
  assert.ok(text.length <= LIMIT);
});

test('after a compaction it re-injects the current task pin, the one written last for this workspace', t => {
  const dir = sandbox(t, 'ia-core-boot-');
  const repo = makeRepo(join(dir, 'repo'));
  const home = join(dir, 'home');
  const env = envFor({ cli: fakeCli(dir), kitsDir: join(dir, 'kits'), temp: dir, extra: { IA_HOME: home, CLAUDE_PLUGIN_ROOT: '<plugin>', IA_NO_ACCOUNT_OFFER: '1' } });
  const pin = (project, task, root, capability, when) => {
    const folder = join(home, 'work-v1', project, task);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'binding.json');
    writeFileSync(file, JSON.stringify({ format: 3, revision: 2, workspace: { root, revision: 'r' }, task, kits: { 'inventarch/alpha-kit': { version: '0.3.0', archive: 'a'.repeat(64), sources: 'b'.repeat(64) } }, keys: { 'work.milestone': { kit: 'inventarch/alpha-kit', capability, records: [], scopeKey: null, intent: null } } }));
    utimesSync(file, when, when);
  };
  pin('proj', 'older', repo, 'old-method', new Date('2026-10-01T00:00:00Z'));
  pin('proj', 'newer', repo, 'milestone-method', new Date('2026-10-20T00:00:00Z'));
  pin('proj', 'elsewhere', join(dir, 'other-repo'), 'not-this-one', new Date('2026-10-29T00:00:00Z'));
  const compact = run('bootstrap.mjs', [], env, { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', cwd: repo }) });
  assert.equal(compact.status, 0, compact.stderr);
  const text = compact.json.hookSpecificOutput.additionalContext;
  assert.match(text, /Current task pin \(proj\/newer, revision 2\): work\.milestone -> inventarch\/alpha-kit@0\.3\.0 milestone-method/);
  assert.match(text, /ia_method \{key, task: "newer"\}/);
  assert.match(text, /<plugin>\/scripts\/resolve\.mjs" --entry <lane> --activity <activity> --project proj --task newer --json/);
  assert.doesNotMatch(text, /old-method|not-this-one/);
  const startup = run('bootstrap.mjs', [], env, { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: repo }) });
  assert.doesNotMatch(startup.json.hookSpecificOutput.additionalContext, /Current task pin/, 'only a compaction re-injects the pin');
});
