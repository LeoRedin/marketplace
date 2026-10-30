// The ceiling report (the ia-method kit's law method-provisional-foundation-
// ceiling, contract ia-method REQ-METHOD-01). The kit's cases name the two
// REQ-METHOD-01 tests below as their evaluators. The script runs here against
// a stand-in CLI that answers `ia next` and `ia inspect` from fixtures; with
// IA_CORE_TEST_CLI=<@inventarch/cli dist/main.js> it also runs against a real
// workspace with the kit adopted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ceilingReport, describe, nodeFromInspect } from '../scripts/lib/ceiling.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(PLUGIN, 'scripts', 'ceiling.mjs');
const id = (word, name) => `work-system/${word === 'spec' ? 'contract' : 'definition'}/${word}/${name}`;
const task = (name, { requires = [], cites = [] } = {}) => [id('task', name), { word: 'task', status: 'open', choice: false, requires, cites, groundedBy: [] }];
const decision = (name, choice) => [id('decision', name), { word: 'decision', status: choice ? 'made' : 'open', choice, requires: [], cites: [], groundedBy: [] }];
const spec = (name, status, groundedBy = []) => [id('spec', name), { word: 'spec', status, choice: false, requires: [], cites: [], groundedBy }];
const byName = (report, name) => report.tasks.find(t => t.identity === id('task', name));

// A stand-in IA CLI: `next` lists the fixture's tasks, `inspect <id>` returns
// the fixture's record in the shape ia inspect reports, or exits 3 for an
// identity listed in `failing`.
function fakeCli(t, graph, failing = []) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-ceiling-fakecli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const records = Object.fromEntries(Object.entries(graph).map(([identity, n]) => [identity, {
    identity,
    discriminator: n.word,
    sections: [
      { name: 'work', fields: [{ key: 'status', value: { kind: 'scalar', text: n.status } }] },
      ...(n.choice ? [{ name: 'decision', fields: [{ key: 'choice', value: { kind: 'string', text: 'a' } }] }] : []),
    ],
    edges: [
      ...n.requires.map(target => ({ predicate: 'require', direction: 'out', target })),
      ...n.cites.map(target => ({ predicate: 'cite', direction: 'out', target })),
      ...n.groundedBy.map(target => ({ predicate: 'ground', direction: 'in', target })),
    ],
  }]));
  writeFileSync(join(dir, 'records.json'), JSON.stringify({ records, failing }));
  const main = join(dir, 'main.mjs');
  writeFileSync(main, `import { readFileSync } from 'node:fs';
const { records, failing } = JSON.parse(readFileSync(new URL('./records.json', import.meta.url), 'utf8'));
const [command, identity] = process.argv.slice(2);
if (command === 'next') {
  const tasks = Object.values(records).filter(r => r.discriminator === 'task').map(r => ({ identity: r.identity }));
  process.stdout.write(JSON.stringify({ ok: true, view: { tasks } }));
} else if (command === 'inspect') {
  if (failing.includes(identity)) { process.stdout.write(JSON.stringify({ ok: false, code: 'IA-DB-SOURCE-UNAVAILABLE' })); process.exit(3); }
  process.stdout.write(JSON.stringify({ records: records[identity] ? [records[identity]] : [] }));
} else process.exit(2);
`);
  const root = join(dir, 'repo');
  mkdirSync(join(root, '.git'), { recursive: true });
  const env = { ...process.env, IA_CLI_PATH: main };
  delete env.IA_METHOD_CLI;
  return { root, env };
}

const runScript = (cli, args) => spawnSync(process.execPath, [SCRIPT, '--root', cli.root, ...args], { env: cli.env, encoding: 'utf8' });

test('REQ-METHOD-01 success: direct dependants stay within the first layer', t => {
  const graph = Object.fromEntries([decision('d-open', false), task('t1', { requires: [id('decision', 'd-open')] }), decision('d-made', true), task('t2', { requires: [id('decision', 'd-made')] })]);
  const report = ceilingReport(graph, [id('task', 't1'), id('task', 't2')]);
  assert.equal(byName(report, 't1').position, 'first-layer');
  assert.deepEqual(byName(report, 't1').foundations.map(f => f.identity), [id('decision', 'd-open')]);
  assert.equal(byName(report, 't2').position, 'clear');
  assert.equal(report.counts.beyondCeiling, 0);
  const cli = fakeCli(t, graph);
  const ran = runScript(cli, ['--task', id('task', 't1')]);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /first layer on decision\/d-open \(no choice\)/);
});

test('REQ-METHOD-01 failure: a second layer is beyond the ceiling', t => {
  const graph = Object.fromEntries([spec('s-draft', 'draft'), task('t1', { cites: [id('spec', 's-draft')] }), task('t2', { requires: [id('task', 't1')] })]);
  const report = ceilingReport(graph, [id('task', 't1'), id('task', 't2')]);
  const second = byName(report, 't2');
  assert.equal(second.position, 'beyond-ceiling');
  assert.equal(second.layer, 2);
  assert.deepEqual(second.via, [id('task', 't1')]);
  assert.deepEqual(second.foundations.map(f => f.identity), [id('spec', 's-draft')]);
  assert.match(describe(second), /beyond the ceiling \(layer 2, through task\/t1\) waiting on spec\/s-draft \(status draft\)/);
  const cli = fakeCli(t, graph);
  const ran = runScript(cli, ['--task', id('task', 't2')]);
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /beyond the ceiling/);
  const all = runScript(cli, ['--json']);
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.equal(JSON.parse(all.stdout).counts.beyondCeiling, 1);
});

test('a task beyond the ceiling names every foundation it waits on, its own and those of its chain', () => {
  const graph = Object.fromEntries([decision('d-a', false), decision('d-b', false), task('t1', { requires: [id('decision', 'd-a')] }), task('t2', { requires: [id('decision', 'd-b'), id('task', 't1')] })]);
  const entry = byName(ceilingReport(graph, [id('task', 't1'), id('task', 't2')]), 't2');
  assert.equal(entry.position, 'beyond-ceiling');
  assert.deepEqual(entry.foundations.map(f => f.identity).sort(), [id('decision', 'd-a'), id('decision', 'd-b')]);
});

test('a decision that grounds a cited spec is a foundation even when the spec is accepted', () => {
  const graph = Object.fromEntries([decision('d-ratify', false), spec('s-ok', 'accepted', [id('decision', 'd-ratify')]), task('t1', { cites: [id('spec', 's-ok')] })]);
  const entry = ceilingReport(graph, [id('task', 't1')]).tasks[0];
  assert.equal(entry.position, 'first-layer');
  assert.deepEqual(entry.foundations.map(f => f.identity), [id('decision', 'd-ratify')]);
});

test('an accepted spec on decisions with a choice is clear; a cited superseded spec is a foundation until the work points at its successor', () => {
  const graph = Object.fromEntries([decision('d-made', true), spec('s-ok', 'accepted', [id('decision', 'd-made')]), spec('s-old', 'superseded'), task('t1', { cites: [id('spec', 's-ok')] }), task('t2', { cites: [id('spec', 's-ok'), id('spec', 's-old')] })]);
  const report = ceilingReport(graph, [id('task', 't1'), id('task', 't2')]);
  assert.equal(byName(report, 't1').position, 'clear');
  assert.equal(byName(report, 't2').position, 'first-layer');
  assert.match(describe(byName(report, 't2')), /spec\/s-old \(status superseded; point the work at its successor\)/);
});

test('layers count through chains and a requires cycle terminates', () => {
  const graph = Object.fromEntries([decision('d-open', false), task('t1', { requires: [id('decision', 'd-open')] }), task('t2', { requires: [id('task', 't1')] }), task('t3', { requires: [id('task', 't2'), id('task', 't4')] }), task('t4', { requires: [id('task', 't3')] })]);
  const report = ceilingReport(graph, ['t1', 't2', 't3', 't4'].map(n => id('task', n)));
  assert.equal(byName(report, 't3').layer, 3);
  assert.deepEqual(byName(report, 't3').via, [id('task', 't2'), id('task', 't1')]);
  assert.ok(byName(report, 't4').layer >= 3);
});

test('the report fails closed: a record it cannot read leaves the task unknown, and --task exits 2', t => {
  const graph = Object.fromEntries([decision('d-open', false), task('t1', { requires: [id('decision', 'd-open')] })]);
  const cli = fakeCli(t, graph, [id('decision', 'd-open')]);
  const ran = runScript(cli, ['--task', id('task', 't1')]);
  assert.equal(ran.status, 2, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /task\/t1: unknown; could not read decision\/d-open: do not treat it as clear/);
  const report = ceilingReport({ ...graph, [id('decision', 'd-open')]: null }, [id('task', 't1')]);
  assert.equal(report.tasks[0].position, 'unknown');
  assert.equal(report.counts.unknown, 1);
});

test('refusals exit 2: an unknown task, a missing CLI, and an unknown option', t => {
  const cli = fakeCli(t, Object.fromEntries([task('t1')]));
  const missing = runScript(cli, ['--task', id('task', 'missing')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /is not an admitted record/);
  const noCli = spawnSync(process.execPath, [SCRIPT, '--root', cli.root], { env: { ...cli.env, IA_CLI_PATH: join(cli.root, 'absent.js') }, encoding: 'utf8' });
  assert.equal(noCli.status, 2);
  assert.match(noCli.stdout, /IA-CORE-CLI-MISSING/);
  assert.equal(runScript(cli, ['--bogus']).status, 2);
});

test('nodeFromInspect reads status, choice and the three edge kinds as ia inspect reports them', () => {
  const node = nodeFromInspect({
    discriminator: 'spec',
    sections: [{ name: 'work', fields: [{ key: 'status', value: { kind: 'scalar', text: 'draft' } }] }],
    edges: [
      { predicate: 'ground', direction: 'in', spelling: 'grounded-by', target: id('decision', 'd') },
      { predicate: 'cite', direction: 'in', target: id('task', 'elsewhere') },
    ],
  });
  assert.deepEqual(node, { word: 'spec', status: 'draft', choice: false, requires: [], cites: [], groundedBy: [id('decision', 'd')] });
});

const CLI = process.env.IA_CORE_TEST_CLI;

test('real CLI: the ceiling report and both kit rules in an adopted workspace (opt-in: IA_CORE_TEST_CLI)', { skip: !CLI && 'set IA_CORE_TEST_CLI to an @inventarch/cli dist/main.js' }, async t => {
  const { runIa, resolveCli } = await import('../scripts/lib/cli.mjs');
  const { adopt, DEFAULT_KITS_DIR, findKit } = await import('../scripts/lib/kit.mjs');
  const kit = findKit('ia-method', DEFAULT_KITS_DIR);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-core-ceiling-e2e-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = resolveCli(root, { env: { IA_CLI_PATH: CLI } });
  // ia init takes the directory as an argument, not --root.
  const init = spawnSync(process.execPath, [CLI, 'init', root, '--host', 'none', '--apply', '--yes', '--json'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.ok(adopt(root, kit, { cli }).written.length > 0);
  assert.equal(adopt(root, kit, { cli }).already, true);
  const LAW = 'governance-system/governance/law/method-provisional-foundation-ceiling';
  const PRINCIPLE = 'governance-system/governance/principle/method-claims-within-evidence';
  const rules = (args) => runIa(root, ['position', ...args], { cli }).json?.body?.rules.filter(r => r.band === 90).map(r => r.identity).sort();
  // Both blocking rules reach the root seat of a repository with no work records.
  assert.deepEqual(rules(['--shape', 'governance', '--phase', 'plan']), [LAW, PRINCIPLE].sort());
  writeFileSync(join(root, '.ia', 'src', 'work.ia'), `#! ia 1.0

@plan p
  meaning
    says "Plan."
  work
    title "Plan"
    status open

@milestone m
  meaning
    says "Milestone."
  work
    title "Milestone"
    status open
    plan @plan p
    exit "Done."

@decision d-open
  meaning
    says "Open."
  work
    title "Open"
    status open
  decision
    question "Which?"
    options ["a", "b"]
    decider "owner"

@spec s-draft
  meaning
    says "Draft."
  work
    title "Draft"
    status draft
  relationships
    grounded-by @decision d-open

@task t1
  meaning
    says "First."
  work
    title "First"
    status open
    milestone @milestone m
  relationships
    requires @decision d-open

@task t2
  meaning
    says "Second."
  work
    title "Second"
    status open
    milestone @milestone m
  relationships
    requires @task t1

@task t3
  meaning
    says "On the draft spec."
  work
    title "Spec layer"
    status open
    milestone @milestone m
  relationships
    cites @spec s-draft
`);
  assert.equal(runIa(root, ['validate'], { cli }).json?.status, 'admitted');
  const ran = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json'], { env: { ...process.env, IA_CLI_PATH: CLI }, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const report = JSON.parse(ran.stdout);
  const at = name => report.tasks.find(x => x.identity.endsWith('/' + name));
  assert.equal(at('t1').position, 'first-layer');
  assert.equal(at('t2').position, 'beyond-ceiling');
  assert.equal(at('t3').position, 'first-layer');
  assert.deepEqual(at('t3').foundations.map(f => f.identity.split('/').pop()).sort(), ['d-open', 's-draft']);
  assert.ok(rules(['--seat', 'work-system/definition/task/t2', '--shape', 'sequence']).includes(LAW));
  assert.ok(rules(['--seat', 'work-system/contract/spec/s-draft', '--shape', 'governance']).includes(LAW));
});
