// Tests for the trigger-evaluation runner of the inventarch/ia-authoring-kit's
// host-authoring part, config/kits/ia-authoring/scripts/eval-triggers.mjs: its
// exported functions and its exit codes, run against a stub host. The kit's
// sources (records, checks, cases, assets, release) are tested in
// kit-authoring.test.mjs. None of this needs the IA CLI or a logged-in host.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashDirectory, loadCases, newcombe, parseStream, planSessions, validateConfig, verdict, wilson } from '../config/kits/ia-authoring/scripts/eval-triggers.mjs';

const KIT = fileURLToPath(new URL('../config/kits/ia-authoring/', import.meta.url));
const RUNNER = join(KIT, 'scripts', 'eval-triggers.mjs');
const STUB = fileURLToPath(new URL('./fixtures/stub-claude.mjs', import.meta.url));

// ------------------------------------------------------------- the runner

const lines = (...events) => events.map((event) => JSON.stringify(event)).join('\n');
test('a Skill call to the target counts as triggered; the listing is captured', () => {
  const parsed = parseStream(
    lines(
      { type: 'system', subtype: 'init', skills: ['game-design-lab:game-design-lab', 'other:x'] },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'game-design-lab:game-design-lab' } }] } },
    ),
  );
  assert.deepEqual(verdict(parsed, 'game-design-lab:game-design-lab'), { listed: true, triggered: true });
  assert.deepEqual(verdict(parseStream(lines({ type: 'system', subtype: 'init', skills: [] })), 'a:b'), { listed: false, triggered: false });
});
test('cases are read from the captured snapshot by the contract requirement they implement', () => {
  const scenario = (kind, request) => ({ name: 'scenario', fields: [
    { key: 'kind', value: { kind: 'scalar', text: kind } }, { key: 'request', value: { kind: 'string', text: request } } ] });
  const edge = (fragment) => ({ spelling: 'implements', reference: { discriminator: 'contract', name: 'gdl-triggers', fragment } });
  const snapshot = { records: [
    { discriminator: 'case', name: 'gdl-t-01', sections: [scenario('success', 'Why is my card game boring?')], edges: [edge('REQ-GDL-01')] },
    { discriminator: 'case', name: 'gdl-n-01', sections: [scenario('refusal', 'Fix this shader')], edges: [edge('REQ-GDL-01')] },
    { discriminator: 'case', name: 'other', sections: [scenario('success', 'x')], edges: [edge('REQ-OTHER')] },
  ] };
  assert.deepEqual(loadCases(snapshot, 'gdl-triggers', 'REQ-GDL-01'), [
    { id: 'gdl-n-01', prompt: 'Fix this shader', shouldTrigger: false },
    { id: 'gdl-t-01', prompt: 'Why is my card game boring?', shouldTrigger: true },
  ]);
});
test('the session plan refuses to exceed the declared cap', () => {
  const cases = [{ id: 'a', prompt: 'p', shouldTrigger: true }];
  const config = { arms: [{ id: 'original' }, { id: 'regenerated' }], runs: 3, cap: 5 };
  assert.throws(() => planSessions(config, cases), /cap/);
  assert.equal(planSessions({ ...config, cap: 6 }, cases).length, 6);
});
test('the runner exits 2 without --config and 1 for a config whose cases are missing, before any session', () => {
  const run = (args) => spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', windowsHide: true });
  const usage = run([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage/);
  const dir = mkdtempSync(join(tmpdir(), 'ia-authoring-runner-'));
  try {
    mkdirSync(join(dir, '.ia', 'work'), { recursive: true });
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ records: [] }));
    writeFileSync(join(dir, '.ia', 'work', 'trigger-eval.json'), JSON.stringify({ snapshot: 'snapshot.json', contract: 'c', requirement: 'R', skill: 'a:b', arms: [{ id: 'a' }], runs: 1, cap: 1, model: 'haiku', out: 'out', claude: 'no-such-claude' }));
    const refused = run(['--config', join(dir, '.ia', 'work', 'trigger-eval.json')]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /no cases/);
    assert.equal(existsSync(join(dir, 'out')), false, 'nothing is written before cases exist');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// ------------------------------------------- the runner against a stub host

const caseRecord = (name, kind, request) => ({ discriminator: 'case', name, edges: [{ spelling: 'implements', reference: { discriminator: 'contract', name: 'c', fragment: 'REQ-1' } }],
  sections: [{ name: 'scenario', fields: [{ key: 'kind', value: { kind: 'scalar', text: kind } }, ...(request === undefined ? [] : [{ key: 'request', value: { kind: 'string', text: request } }])] }] });
const goodCases = () => [...Array.from({ length: 10 }, (_, i) => caseRecord(`t-${String(i).padStart(2, '0')}`, 'success', `TRIGGER ${i}`)), ...Array.from({ length: 10 }, (_, i) => caseRecord(`n-${String(i).padStart(2, '0')}`, 'refusal', `other ${i}`))];

// A scratch workspace with a snapshot, two arm plugin dirs and a config; mutate edits the config.
function world(mutate, { behavior = ['', ''], records } = {}) {
  // Canonical, so the stub's STUB_FORBID compares equal to the physical cwd a session reports (macOS /var -> /private/var).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-authoring-world-')));
  mkdirSync(join(dir, '.ia', 'work'), { recursive: true });
  for (const [i, id] of ['original', 'regenerated'].entries()) { mkdirSync(join(dir, id)); writeFileSync(join(dir, id, 'behavior.txt'), behavior[i]); }
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ records: records ?? goodCases() }));
  const config = { mode: 'dev', model: 'haiku', skill: 'p:s', contract: 'c', requirement: 'REQ-1', snapshot: 'snapshot.json', out: 'out', runs: 1, cap: 40, disable: [],
    arms: [{ id: 'original', pluginDir: 'original' }, { id: 'regenerated', pluginDir: 'regenerated' }], claude: [process.execPath, STUB] };
  mutate?.(config);
  const path = join(dir, '.ia', 'work', 'trigger-eval.json');
  writeFileSync(path, JSON.stringify(config));
  return { dir, path, out: join(dir, 'out'), run: (env = {}) => spawnSync(process.execPath, [RUNNER, '--config', path], { encoding: 'utf8', windowsHide: true, env: { ...process.env, STUB_SKILL: 'p:s', STUB_MANIFEST: join(dir, 'out', 'manifest.json'), ...env } }), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a complete, equal run writes the manifest before the first session and exits 0 with intervals', () => {
  const w = world();
  try {
    const ran = w.run();
    assert.equal(ran.status, 0, ran.stderr);
    const manifest = JSON.parse(readFileSync(join(w.out, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest).sort(), ['arms', 'cap', 'caseSet', 'contract', 'disable', 'format', 'host', 'mode', 'model', 'requirement', 'runner', 'runs', 'session', 'sessions', 'skill']);
    assert.deepEqual(manifest.host, { name: 'claude', version: 'stub-claude 1.2.3' });
    assert.equal(manifest.sessions, 40);
    assert.match(manifest.caseSet, /^[0-9a-f]{64}$/);
    assert.deepEqual(manifest.arms.map(a => a.id), ['original', 'regenerated']);
    assert.equal(manifest.arms[0].plugin, hashDirectory(join(w.dir, 'original')));
    assert.doesNotMatch(JSON.stringify(manifest), /Users|[A-Za-z]:\\|\d{4}-\d\d-\d\dT/);
    const results = JSON.parse(readFileSync(join(w.out, 'results.json'), 'utf8'));
    assert.equal(results.complete, true);
    assert.equal(results.summary.original.correct, 20);
    assert.equal(results.summary.original.sessions, 20);
    assert.ok(results.summary.original.interval95.low > 0.8 && results.summary.original.interval95.high === 1);
    assert.equal(readdirSync(join(w.out, 'raw')).length, 40);
  } finally { w.done(); }
});

test('the regenerated arm doing worse exits 3', () => {
  const w = world(undefined, { behavior: ['', 'never'] });
  try {
    const ran = w.run();
    assert.equal(ran.status, 3, ran.stderr);
    assert.equal(JSON.parse(readFileSync(join(w.out, 'results.json'), 'utf8')).summary.regenerated.correct, 10);
  } finally { w.done(); }
});

test('a non-zero host exit that comes with a result event still counts as complete', () => {
  const w = world();
  try {
    assert.equal(w.run({ STUB_EXIT_WITH_RESULT: '1' }).status, 0);
  } finally { w.done(); }
});

test('an incomplete run, an unlisted skill and a host that cannot start exit 1 and say so in results.json', () => {
  const failing = world();
  try {
    const ran = failing.run({ STUB_FAIL: '1' });
    assert.equal(ran.status, 1);
    const results = JSON.parse(readFileSync(join(failing.out, 'results.json'), 'utf8'));
    assert.equal(results.complete, false);
    assert.equal(results.incomplete, 40);
  } finally { failing.done(); }
  const unlisted = world();
  try {
    assert.equal(unlisted.run({ STUB_UNLISTED: '1' }).status, 1);
    const results = JSON.parse(readFileSync(join(unlisted.out, 'results.json'), 'utf8'));
    assert.equal(results.complete, false);
    assert.equal(results.unlisted, 40);
  } finally { unlisted.done(); }
  const missing = world(c => { c.claude = [join(tmpdir(), 'no-such-host-xyz')]; });
  try {
    const ran = missing.run();
    assert.equal(ran.status, 1);
    assert.match(ran.stderr, /--version/);
    assert.equal(existsSync(missing.out), false, 'nothing is written when the host cannot answer');
  } finally { missing.done(); }
});

test('an out that already holds a manifest is refused, so no case is rerun selectively', () => {
  const w = world();
  try {
    assert.equal(w.run().status, 0);
    const again = w.run();
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already holds a manifest/);
  } finally { w.done(); }
});

test('config refusals name the field and write nothing', () => {
  const cases = [
    ['mode', c => { delete c.mode; }], ['mode', c => { c.mode = 'fast'; }], ['model', c => { c.model = ''; }], ['skill', c => { delete c.skill; }],
    ['runs', c => { c.runs = 3; }], ['runs', c => { delete c.runs; }], ['model', c => { c.mode = 'gate'; c.runs = 3; c.model = 'haiku'; }], ['cap', c => { delete c.cap; }],
    ['arms', c => { c.arms = []; }], ['arms', c => { c.arms[1].id = 'original'; }], ['arms', c => { c.arms.reverse(); }], ['arms', c => { c.arms[1].id = 'other'; }], ['arms[1].pluginDir', c => { c.arms[1].pluginDir = 'absent'; }], ['disable', c => { delete c.disable; }],
    ['out', c => { delete c.out; }],
  ];
  for (const [field, mutate] of cases) {
    const w = world(mutate);
    try {
      const ran = w.run();
      assert.equal(ran.status, 1, field);
      assert.ok(ran.stderr.includes(field), `${field}: ${ran.stderr}`);
      assert.equal(existsSync(w.out), false, `${field}: nothing is written`);
    } finally { w.done(); }
  }
  const few = world(undefined, { records: goodCases().slice(1) });
  try {
    const ran = few.run();
    assert.equal(ran.status, 1);
    assert.match(ran.stderr, /at least 10 success/);
  } finally { few.done(); }
  const over = world(c => { c.cap = 39; });
  try {
    assert.equal(over.run().status, 1);
    assert.equal(existsSync(over.out), false);
  } finally { over.done(); }
});

test('an error result gives exit 1; error_max_turns with a trigger still counts; a run with no trigger anywhere exits 1', () => {
  const errored = world();
  try {
    assert.equal(errored.run({ STUB_ERROR: '1' }).status, 1);
    const results = JSON.parse(readFileSync(join(errored.out, 'results.json'), 'utf8'));
    assert.equal(results.complete, false);
    assert.equal(results.incomplete, 40);
    assert.equal(results.results[0].isError, true);
    assert.equal(results.results[0].resultSubtype, 'error_during_execution');
  } finally { errored.done(); }
  const capped = world();
  try {
    assert.equal(capped.run({ STUB_MAXTURNS: '1' }).status, 0);
    const results = JSON.parse(readFileSync(join(capped.out, 'results.json'), 'utf8'));
    assert.equal(results.results[0].resultSubtype, 'error_max_turns');
    assert.deepEqual(results.results.find(r => r.case === 't-00').invoked, ['p:s']);
  } finally { capped.done(); }
  const blind = world(undefined, { behavior: ['never', 'never'] });
  try {
    const ran = blind.run();
    assert.equal(ran.status, 1);
    assert.match(ran.stderr, /no trigger observed in any session/);
  } finally { blind.done(); }
});

test('worse means worse beyond noise: 20/20 against 10/20 exits 3, 19/20 against 18/20 exits 0', () => {
  const clear = world(undefined, { behavior: ['', 'never'] });
  try {
    assert.equal(clear.run().status, 3);
    const difference = JSON.parse(readFileSync(join(clear.out, 'results.json'), 'utf8')).summary.difference;
    assert.equal(difference.estimate, -0.5);
    assert.ok(difference.interval95.high < 0);
  } finally { clear.done(); }
  const noise = world(undefined, { behavior: ['skip: TRIGGER 1', 'skip: TRIGGER 1\nskip: TRIGGER 2'] });
  try {
    assert.equal(noise.run().status, 0);
    const summary = JSON.parse(readFileSync(join(noise.out, 'results.json'), 'utf8')).summary;
    assert.equal(summary.original.correct, 19);
    assert.equal(summary.regenerated.correct, 18);
    assert.ok(summary.difference.interval95.high > 0);
  } finally { noise.done(); }
  const same = newcombe({ k: 10, n: 10 }, { k: 10, n: 10 });
  assert.equal(same.estimate, 0);
  assert.ok(same.interval95.low < 0 && same.interval95.high > 0);
});

test('the manifest names the runner, the disabled plugins and the session limits', () => {
  const w = world(c => { c.disable = ['other@market']; });
  try {
    assert.equal(w.run().status, 0);
    const manifest = JSON.parse(readFileSync(join(w.out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.runner.sha256, createHash('sha256').update(readFileSync(RUNNER, 'utf8').replace(/\r\n/g, '\n')).digest('hex'));
    assert.deepEqual(manifest.disable, ['other@market']);
    assert.deepEqual(manifest.session, { maxTurns: 2, allowedTools: ['Skill'], timeoutSeconds: 600 });
  } finally { w.done(); }
});

test('the per-session timeout is configurable, defaults to 600 and a bad value is refused', () => {
  const configured = world(c => { c.sessionTimeoutSeconds = 1; }, { behavior: ['sleep: TRIGGER 0 ', 'sleep: TRIGGER 0 '] });
  try {
    const ran = configured.run();
    assert.equal(ran.status, 1);
    assert.equal(JSON.parse(readFileSync(join(configured.out, 'manifest.json'), 'utf8')).session.timeoutSeconds, 1);
    const results = JSON.parse(readFileSync(join(configured.out, 'results.json'), 'utf8'));
    assert.equal(results.complete, false);
    assert.equal(results.incomplete, 2, 'only the two sleeping sessions time out');
  } finally { configured.done(); }
  for (const bad of [0, -5, 1.5, '60']) {
    const w = world(c => { c.sessionTimeoutSeconds = bad; });
    try {
      const ran = w.run();
      assert.equal(ran.status, 1, String(bad));
      assert.ok(ran.stderr.includes('sessionTimeoutSeconds'), ran.stderr);
      assert.equal(existsSync(w.out), false);
    } finally { w.done(); }
  }
});

test('sessions are interleaved by case, run, then arm', () => {
  const cases = [{ id: 'a' }, { id: 'b' }];
  const plan = planSessions({ arms: [{ id: 'original' }, { id: 'regenerated' }], runs: 2, cap: 100 }, cases);
  assert.deepEqual(plan.slice(0, 5).map(s => `${s.case}${s.run}${s.arm[0]}`), ['a0o', 'a0r', 'a1o', 'a1r', 'b0o']);
  assert.equal(plan.length, 8);
});

test('sessions run outside the workspace: a stub that forbids the workspace passes, and would fail in out', () => {
  const w = world();
  try {
    assert.equal(w.run({ STUB_FORBID: w.dir }).status, 0);
    mkdirSync(w.out, { recursive: true });
    const inOut = spawnSync(process.execPath, [STUB, '-p'], { cwd: w.out, input: 'TRIGGER', encoding: 'utf8', env: { ...process.env, STUB_FORBID: w.dir } });
    assert.equal(inOut.status, 8);
  } finally { w.done(); }
});

test('validateConfig accepts a gate config and loadCases refuses a case without a request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-authoring-gate-'));
  try {
    mkdirSync(join(dir, 'a')); mkdirSync(join(dir, 'b'));
    const cases = loadCases({ records: goodCases() }, 'c', 'REQ-1');
    const config = { mode: 'gate', model: 'claude-opus-4', skill: 's', contract: 'c', requirement: 'R', snapshot: 's', out: 'o', runs: 3, cap: 120, disable: [], arms: [{ id: 'original', pluginDir: 'a' }, { id: 'regenerated', pluginDir: 'b' }] };
    assert.doesNotThrow(() => validateConfig(config, cases, dir));
    assert.throws(() => loadCases({ records: [caseRecord('bad', 'success', undefined)] }, 'c', 'REQ-1'), /case bad: request/);
    assert.throws(() => loadCases({ records: [caseRecord('bad', 'success', '  ')] }, 'c', 'REQ-1'), /case bad: request/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hashDirectory covers every file but .git, and wilson gives a 95% score interval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-authoring-hash-'));
  try {
    mkdirSync(join(dir, 'sub')); mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'a.txt'), 'a'); writeFileSync(join(dir, 'sub', 'b.txt'), 'b'); writeFileSync(join(dir, '.git', 'HEAD'), 'x');
    const first = hashDirectory(dir);
    writeFileSync(join(dir, '.git', 'HEAD'), 'y');
    assert.equal(hashDirectory(dir), first);
    writeFileSync(join(dir, 'sub', 'b.txt'), 'c');
    assert.notEqual(hashDirectory(dir), first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
  assert.deepEqual(wilson(10, 10), { low: 0.7225, high: 1 });
  assert.deepEqual(wilson(5, 10), { low: 0.2366, high: 0.7634 });
});
