// Bindings: selection by key, wildcard and default; precedence resolving a
// conflict; a conflict without precedence refused with its candidates; no
// binding and no default refused as IA-CORE-NO-METHOD; bind.mjs writing the
// sidecar; and bind.mjs recommend showing a kit's recommended keys and
// writing only those the repository does not bind yet.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BindingError, readBindings, selectBinding } from '../scripts/lib/binding.mjs';
import { envFor, makeKit, makeRepo, run, sandbox } from './helpers/fixtures.mjs';

const A = { kit: 'inventarch/a-kit', capability: 'a-review' };
const B = { kit: 'inventarch/b-kit', capability: 'b-review' };

const data = (bindings, extra = {}) => readBindings(makeRepo(sandboxDir, { bindings: { format: 1, bindings, ...extra } }));
let sandboxDir;

test('selection: exact key, then <entry>.*, then defaults.<entry>', t => {
  sandboxDir = sandbox(t);
  const d = data({ 'delivery.review': A, 'delivery.*': B }, { defaults: { knowledge: A } });
  assert.deepEqual(selectBinding(d, 'delivery', 'review'), { ...A, key: 'delivery.review', via: 'exact' });
  assert.deepEqual(selectBinding(d, 'delivery', 'change'), { ...B, key: 'delivery.change', via: 'wildcard' });
  assert.deepEqual(selectBinding(d, 'knowledge', 'find'), { ...A, key: 'knowledge.find', via: 'default' });
});

test('no binding and no default refuses IA-CORE-NO-METHOD, naming the key and the commands that bind one', t => {
  sandboxDir = sandbox(t);
  const d = data({ 'delivery.review': A });
  for (const [entry, activity] of [['work', 'task'], ['delivery', 'change']]) {
    assert.throws(() => selectBinding(d, entry, activity), e => e instanceof BindingError && e.code === 'IA-CORE-NO-METHOD' && e.key === `${entry}.${activity}` && /kit\.mjs list/.test(e.message) && /bind\.mjs set/.test(e.message));
  }
  assert.throws(() => selectBinding(null, 'work', 'task'), e => e.code === 'IA-CORE-NO-METHOD');
  assert.throws(() => selectBinding(d, 'other', 'x'), e => e.code === 'IA-CORE-USAGE');
});

test('two bindings for one key without precedence refuse IA-CORE-CONFLICT with the candidates', t => {
  sandboxDir = sandbox(t);
  const d = data({ 'work.task': [A, B] });
  assert.throws(() => selectBinding(d, 'work', 'task'), e => e.code === 'IA-CORE-CONFLICT' && e.key === 'work.task' && JSON.stringify(e.candidates) === JSON.stringify([A, B]));
  // Precedence that ranks only one of them, or ranks them equally, still conflicts.
  assert.throws(() => selectBinding(data({ 'work.task': [A, B] }, { precedence: ['inventarch/other-kit'] }), 'work', 'task'), e => e.code === 'IA-CORE-CONFLICT');
});

test('precedence resolves a conflict: the first listed kit wins', t => {
  sandboxDir = sandbox(t);
  assert.deepEqual(selectBinding(data({ 'work.task': [A, B] }, { precedence: ['inventarch/b-kit', 'inventarch/a-kit'] }), 'work', 'task'), { ...B, key: 'work.task', via: 'exact+precedence' });
  assert.deepEqual(selectBinding(data({ 'work.task': [A, B] }, { precedence: ['inventarch/a-kit'] }), 'work', 'task'), { ...A, key: 'work.task', via: 'exact+precedence' });
});

test('a malformed sidecar is refused rather than read as empty', t => {
  const dir = sandbox(t);
  makeRepo(dir);
  for (const bad of ['{"format":2,"bindings":{}}', '{"format":1,"bindings":{"nokey":{"kit":"a","capability":"b"}}}', '{"format":1,"bindings":{"work.task":{"kit":"a"}}}', 'nope']) {
    writeFileSync(join(dir, '.ia', 'bindings.json'), bad);
    assert.throws(() => readBindings(dir), e => e.code === 'IA-CORE-BINDINGS-MALFORMED', bad);
  }
});

test('bind.mjs set, --add, default and precedence write the sidecar that show reads back', t => {
  const dir = sandbox(t);
  const repo = makeRepo(join(dir, 'repo'));
  const env = envFor({ cli: 'none', kitsDir: join(dir, 'kits'), temp: dir });
  const shown = run('bind.mjs', ['show', repo], env);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.equal(shown.json.bindings, null);
  assert.equal(run('bind.mjs', ['set', 'delivery.review', A.kit, A.capability, repo], env).status, 0);
  assert.equal(run('bind.mjs', ['set', 'delivery.review', B.kit, B.capability, repo, '--add'], env).status, 0);
  assert.equal(run('bind.mjs', ['default', 'knowledge', A.kit, 'a-read', repo], env).status, 0);
  assert.equal(run('bind.mjs', ['precedence', B.kit, A.kit, '--root', repo], env).status, 0);
  const file = JSON.parse(readFileSync(join(repo, '.ia', 'bindings.json'), 'utf8'));
  assert.deepEqual(file, { format: 1, bindings: { 'delivery.review': [A, B] }, precedence: [B.kit, A.kit], defaults: { knowledge: { kit: A.kit, capability: 'a-read' } } });
  assert.deepEqual(selectBinding(readBindings(repo), 'delivery', 'review').kit, B.kit);
  assert.equal(run('bind.mjs', ['set', 'delivery.review', A.kit, A.capability, repo], env).json.candidates, 1);
  assert.equal(run('bind.mjs', ['set', 'badkey', A.kit, A.capability, repo], env).status, 2);
  assert.equal(run('bind.mjs', ['bogus'], env).status, 2);
  assert.equal(run('bind.mjs', ['show', dir], env).status, 2, 'not a workspace');
});

test('bind.mjs recommend shows a kit\'s keys, and --apply writes only the ones the repository does not bind, keeping the rest and precedence', t => {
  const dir = sandbox(t);
  const kitsDir = join(dir, 'kits');
  const kit = makeKit(kitsDir, { folder: 'alpha', id: 'inventarch/alpha-kit', capability: 'alpha-design' });
  writeFileSync(join(kit.dir, 'bindings.json'), JSON.stringify({ format: 1, recommend: { 'delivery.design': { capability: kit.capability }, 'delivery.survey': { capability: kit.capability, profile: kit.profile }, 'knowledge.records': { capability: kit.capability }, 'work.task': { capability: 'missing' } }, unbound: [kit.capability] }));
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'delivery.design': { kit: kit.id, capability: kit.capability }, 'knowledge.records': A }, precedence: [A.kit] } });
  const env = envFor({ cli: 'none', kitsDir, temp: dir });
  const shown = run('bind.mjs', ['recommend', kit.id, repo], env);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.deepEqual(shown.json.wouldAdd, ['delivery.survey']);
  assert.deepEqual(shown.json.already, ['delivery.design']);
  assert.deepEqual(shown.json.kept, [{ key: 'knowledge.records', bound: [A] }], 'a key bound to another kit is the repository\'s choice');
  assert.deepEqual(shown.json.undeclared, ['work.task']);
  assert.deepEqual(shown.json.unbound, [kit.capability]);
  assert.equal(shown.json.applied, false);
  const before = readFileSync(join(repo, '.ia', 'bindings.json'), 'utf8');
  assert.equal(readFileSync(join(repo, '.ia', 'bindings.json'), 'utf8'), before, 'without --apply nothing is written');
  const applied = run('bind.mjs', ['recommend', 'alpha', repo, '--apply'], env);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.deepEqual(applied.json.added, ['delivery.survey']);
  const file = JSON.parse(readFileSync(join(repo, '.ia', 'bindings.json'), 'utf8'));
  assert.deepEqual(file.bindings, { 'delivery.design': { kit: kit.id, capability: kit.capability }, 'knowledge.records': A, 'delivery.survey': { kit: kit.id, capability: kit.capability, profile: kit.profile } });
  assert.deepEqual(file.precedence, [A.kit], 'precedence is left alone');
  assert.deepEqual(run('bind.mjs', ['recommend', kit.id, repo, '--apply'], env).json.added, [], 'a second apply adds nothing');
  // Outside a workspace it still lists the keys; --apply needs one.
  const outside = run('bind.mjs', ['recommend', kit.id, join(dir, 'temp')], env);
  assert.equal(outside.status, 0, outside.stdout + outside.stderr);
  assert.equal(outside.json.root, null);
  assert.deepEqual(outside.json.wouldAdd, ['delivery.design', 'delivery.survey', 'knowledge.records']);
  assert.equal(run('bind.mjs', ['recommend', kit.id, join(dir, 'temp'), '--apply'], env).status, 2);
  const fresh = makeRepo(join(dir, 'fresh'));
  assert.deepEqual(run('bind.mjs', ['recommend', kit.id, fresh, '--apply'], env).json.added, ['delivery.design', 'delivery.survey', 'knowledge.records'], 'a repository without bindings gets the sidecar');
  assert.ok(existsSync(join(fresh, '.ia', 'bindings.json')));
  assert.equal(run('bind.mjs', ['recommend', 'inventarch/none-kit', repo], env).status, 1);
  assert.equal(run('bind.mjs', ['recommend'], env).status, 2);
});

test('the retired development entry point is refused with the delivery key to write instead (decision private-core-delivery-lanes)', t => {
  const dir = sandbox(t);
  const env = envFor({ cli: 'none', kitsDir: join(dir, 'kits'), temp: dir });
  const repo = makeRepo(join(dir, 'repo'), { bindings: { format: 1, bindings: { 'development.review': A } } });
  assert.throws(() => readBindings(repo), e => e.code === 'IA-CORE-BINDINGS-MALFORMED' && /now delivery/.test(e.message) && /delivery\.review/.test(e.message));
  writeFileSync(join(repo, '.ia', 'bindings.json'), JSON.stringify({ format: 1, bindings: {}, defaults: { development: A } }));
  assert.throws(() => readBindings(repo), e => e.code === 'IA-CORE-BINDINGS-MALFORMED' && /defaults\.delivery/.test(e.message));
  assert.throws(() => selectBinding({ bindings: {}, precedence: [], defaults: {} }, 'development', 'review'), e => e.code === 'IA-CORE-USAGE' && /now delivery/.test(e.message));
  const resolved = run('resolve.mjs', ['--entry', 'development', '--activity', 'review', '--root', repo], env);
  assert.equal(resolved.status, 2);
  assert.match(resolved.json.error.message, /the development entry point is now delivery/);
  assert.equal(run('bind.mjs', ['set', 'development.review', A.kit, A.capability, makeRepo(join(dir, 'fresh'))], env).status, 2, 'bind.mjs writes no development key');
});
