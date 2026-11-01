// Release notes and plugin releases (tools/release.mjs, decision public-release-notes): an ordinary pull request
// adds a note, and the operator's release pull request folds the notes into each plugin's next version.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHANGESET_FORMAT, check, main, mentions, NOTE_FORMAT } from '../tools/release.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const json = (root, rel) => JSON.parse(read(root, rel));

// What the release tool reads and writes, with no note pending.
function copy(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'release-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const rel of ['.claude-plugin/marketplace.json', 'sources.lock.json', 'plugins/ia/.claude-plugin/plugin.json', 'plugins/ia/.codex-plugin/plugin.json', 'plugins/ia/CHANGELOG.md']) cpSync(join(ROOT, rel), join(dir, rel), { recursive: true });
  return dir;
}
const run = (root, ...argv) => { let out = '', err = ''; const status = main(argv, root, t => { out += t; }, t => { err += t; }); return { status, out, err }; };
const note = (root, id, fields) => {
  mkdirSync(join(root, 'releases/pending'), { recursive: true });
  writeFileSync(join(root, `releases/pending/${id}.json`), `${JSON.stringify({ format: NOTE_FORMAT, bump: 'patch', title: 'A change', summary: 'What a user sees.', plugins: ['ia'], ...fields }, null, 2)}\n`);
};

test('the repository\'s own notes and changesets are well formed', () => {
  assert.deepEqual(check(ROOT), []);
});

test('note writes a pending note named after its title, and refuses a duplicate', t => {
  const root = copy(t);
  const first = run(root, 'note', '--plugin', 'ia', '--bump', 'minor', '--title', 'Add the upkeep agent', '--summary', 'It keeps derived files current.');
  assert.equal(first.status, 0, first.err);
  assert.deepEqual(json(root, 'releases/pending/add-the-upkeep-agent.json'), { format: NOTE_FORMAT, bump: 'minor', title: 'Add the upkeep agent', summary: 'It keeps derived files current.', plugins: ['ia'] });
  const again = run(root, 'note', '--plugin', 'ia', '--bump', 'minor', '--title', 'Add the upkeep agent', '--summary', 'Again.');
  assert.equal(again.status, 1);
  assert.match(again.err, /already pending; pass --id/);
});

test('a bare @word is a GitHub mention and is refused; one in backticks is not', t => {
  assert.deepEqual(mentions('records `@decision` and @decision, mail a@b.c'), ['@decision']);
  const root = copy(t);
  const refused = run(root, 'note', '--plugin', 'ia', '--bump', 'patch', '--title', 'Read @spec records', '--summary', 'Fine.');
  assert.equal(refused.status, 1);
  assert.match(refused.err, /title names @spec bare; put it in backticks/);
  assert.equal(existsSync(join(root, 'releases/pending')), false);
});

test('check names every malformed note', t => {
  const root = copy(t);
  note(root, 'Bad_Id', {});
  note(root, 'unknown-plugin', { plugins: ['nope'] });
  note(root, 'bad-bump', { bump: 'huge', extra: 1 });
  const problems = check(root);
  assert.ok(problems.some(p => /Bad_Id\.json: the id must be lower-case/.test(p)), problems.join('\n'));
  assert.ok(problems.some(p => /unknown-plugin\.json: no plugin nope/.test(p)));
  assert.ok(problems.some(p => /bad-bump\.json: bump must be one of/.test(p)));
  assert.ok(problems.some(p => /bad-bump\.json: keys must be exactly/.test(p)));
  assert.equal(run(root, 'version').status, 1);
});

test('notes that are all bump none start no release', t => {
  const root = copy(t);
  note(root, 'tests-only', { bump: 'none' });
  const result = run(root, 'version', '--write');
  assert.equal(result.status, 0, result.err);
  assert.equal(JSON.parse(result.out).action, 'none');
  assert.ok(existsSync(join(root, 'releases/pending/tests-only.json')));
});

test('version --write takes the highest bump and moves every version the consistency check compares', t => {
  const root = copy(t);
  const previous = json(root, 'plugins/ia/.claude-plugin/plugin.json').version;
  const [major, minor] = previous.split('.').map(Number);
  const next = `${major}.${minor + 1}.0`;
  note(root, 'a-fix', { bump: 'patch', title: 'Fix a thing', summary: 'It works now.' });
  note(root, 'a-feature', { bump: 'minor', title: 'Add a thing', summary: 'You can do more.' });
  note(root, 'tests-only', { bump: 'none', title: 'Cover a thing', summary: 'No user-facing change.' });
  const body = join(root, 'body.md');
  const result = run(root, 'version', '--write', '--pr-body', body);
  assert.equal(result.status, 0, result.err);
  const plan = JSON.parse(result.out);
  assert.equal(plan.title, `ia ${next}`);
  assert.deepEqual(plan.releases, [{ plugin: 'ia', previous, version: next, bump: 'minor', notes: ['a-feature', 'a-fix', 'tests-only'] }]);
  for (const host of ['.claude-plugin', '.codex-plugin']) assert.equal(json(root, `plugins/ia/${host}/plugin.json`).version, next);
  assert.equal(json(root, 'sources.lock.json').pluginVersion.ia, next);
  const changelog = read(root, 'plugins/ia/CHANGELOG.md');
  assert.ok(changelog.startsWith(`# Changelog\n\n## ${next}\n\nAdd a thing; Fix a thing.\n\n- **Add a thing.** You can do more.\n`), changelog.slice(0, 200));
  assert.ok(changelog.includes(`\n- **Cover a thing.** No user-facing change.\n\n## ${previous}\n`));
  const changeset = json(root, `releases/changesets/ia-${next}.json`);
  assert.equal(changeset.format, CHANGESET_FORMAT);
  assert.deepEqual(changeset.notes.map(n => n.id), ['a-feature', 'a-fix', 'tests-only']);
  assert.equal(existsSync(join(root, 'releases/pending/a-fix.json')), false);
  assert.match(read(root, 'body.md'), /Authored by InventArch/);
  assert.deepEqual(check(root), []);
  assert.equal(run(root, 'list').out, `ia-v${next}\n`);
  assert.match(run(root, 'show', `ia-v${next}`).out, new RegExp(`^ia ${next.replaceAll('.', '\\.')} \\(minor, from ${previous.replaceAll('.', '\\.')}\\)`));
  assert.equal(JSON.parse(run(root, 'version').out).action, 'none');
});

test('bad usage exits 2', t => {
  const root = copy(t);
  assert.equal(run(root).status, 2);
  assert.equal(run(root, 'note', '--plugin', 'ia').status, 2);
  assert.equal(run(root, 'version', '--force').status, 2);
});
