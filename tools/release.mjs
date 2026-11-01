#!/usr/bin/env node
// Release notes and plugin releases (decision public-release-notes). A pull request that changes a plugin's shipped
// bytes adds a note under releases/pending/ instead of bumping the plugin; the release pull request, which only an
// operator starts (.github/workflows/release-pr.yml), folds the pending notes into each plugin's next version.
//   node tools/release.mjs note --plugin <name> --bump <patch|minor|major|none> --title <t> --summary <s> [--id <id>]
//   node tools/release.mjs check                                    every pending note and changeset is well formed
//   node tools/release.mjs version [--write] [--pr-body <file>]     the next version of each plugin with notes
//   node tools/release.mjs list                                     the tag of every recorded changeset, one per line
//   node tools/release.mjs show <tag>                               one changeset as release notes
// version --write bumps both manifests, sources.lock.json pluginVersion and the CHANGELOG, records
// releases/changesets/<plugin>-<version>.json and removes the notes it consumed; run python tools/selection.py --write
// after it. A note with bump none satisfies the consistency check but never starts a release. Built-ins only: the
// release workflow runs this with a write token and no dependency install. Exit 0 on success, 1 on a refusal, 2 on
// bad usage.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOTE_FORMAT = 'inventarch-marketplace.release-note.v1';
export const CHANGESET_FORMAT = 'inventarch-marketplace.changeset.v1';
const BUMPS = ['none', 'patch', 'minor', 'major'];
const PENDING = 'releases/pending';
const CHANGESETS = 'releases/changesets';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOOTER = '<img src="https://inventarch.com/mark.svg" width="18" height="18" alt="InventArch" /> **Authored by InventArch · admin@inventarch.dev**';

const USAGE = `usage:
  node tools/release.mjs note --plugin <name> --bump <patch|minor|major|none> --title <t> --summary <s> [--id <id>]
  node tools/release.mjs check
  node tools/release.mjs version [--write] [--pr-body <file>]
  node tools/release.mjs list
  node tools/release.mjs show <plugin>-v<version>
`;

const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const writeText = (root, rel, text) => writeFileSync(join(root, rel), text, { encoding: 'utf8' });
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;

export function plugins(root) {
  return readJson(root, '.claude-plugin/marketplace.json').plugins.map(p => p.name).sort();
}

function files(root, dir) {
  const full = join(root, dir);
  return existsSync(full) ? readdirSync(full).filter(n => n.endsWith('.json')).sort() : [];
}

// A bare @word is a GitHub mention wherever release notes are published; IA words go in backticks.
export function mentions(text) {
  return [...text.replace(/(`+)(?:(?!\1).)+?\1/g, ' ').matchAll(/(?:^|[^\w`/.])@([A-Za-z0-9][\w-]*)/g)].map(m => `@${m[1]}`);
}

export function noteProblems(note, known, name = 'note') {
  const problems = [];
  if (!note || typeof note !== 'object' || Array.isArray(note)) return [`${name}: not a JSON object`];
  const keys = Object.keys(note).sort().join(',');
  if (keys !== 'bump,format,plugins,summary,title') problems.push(`${name}: keys must be exactly format, bump, title, summary and plugins (found ${keys})`);
  if (note.format !== NOTE_FORMAT) problems.push(`${name}: format must be ${NOTE_FORMAT}`);
  if (!BUMPS.includes(note.bump)) problems.push(`${name}: bump must be one of ${BUMPS.join(', ')}`);
  for (const field of ['title', 'summary']) {
    if (typeof note[field] !== 'string' || !note[field].trim()) problems.push(`${name}: ${field} must be a non-empty string`);
    else if (note[field] !== note[field].trim()) problems.push(`${name}: ${field} has leading or trailing whitespace`);
    else for (const m of mentions(note[field])) problems.push(`${name}: ${field} names ${m} bare; put it in backticks`);
  }
  if (typeof note.title === 'string' && note.title.includes('\n')) problems.push(`${name}: title is one line`);
  if (!Array.isArray(note.plugins) || note.plugins.length === 0) problems.push(`${name}: plugins must list at least one plugin`);
  else {
    if (new Set(note.plugins).size !== note.plugins.length || note.plugins.join() !== [...note.plugins].sort().join()) problems.push(`${name}: plugins must be sorted and unique`);
    for (const p of note.plugins) if (!known.includes(p)) problems.push(`${name}: no plugin ${p} in the catalogue`);
  }
  return problems;
}

export function changesetProblems(changeset, known, name) {
  const problems = [];
  if (changeset?.format !== CHANGESET_FORMAT) problems.push(`${name}: format must be ${CHANGESET_FORMAT}`);
  if (!known.includes(changeset?.plugin)) problems.push(`${name}: no plugin ${changeset?.plugin} in the catalogue`);
  for (const field of ['version', 'previous']) if (!SEMVER.test(changeset?.[field] ?? '')) problems.push(`${name}: ${field} must be a release version`);
  if (!BUMPS.slice(1).includes(changeset?.bump)) problems.push(`${name}: bump must be patch, minor or major`);
  if (name !== `${changeset?.plugin}-${changeset?.version}.json`) problems.push(`${name}: the file is named <plugin>-<version>.json`);
  if (!Array.isArray(changeset?.notes) || changeset.notes.length === 0) problems.push(`${name}: notes must list the notes it consumed`);
  else for (const note of changeset.notes) {
    if (!ID.test(note?.id ?? '')) problems.push(`${name}: a note id must be lower-case words joined by hyphens`);
    const { id: _id, ...rest } = note ?? {};
    problems.push(...noteProblems({ format: NOTE_FORMAT, plugins: [changeset?.plugin], ...rest }, known, `${name} ${note?.id}`));
  }
  return problems;
}

export function readPending(root) {
  return files(root, PENDING).map(file => ({ id: file.slice(0, -5), file: `${PENDING}/${file}`, note: readJson(root, `${PENDING}/${file}`) }));
}

export function check(root) {
  const known = plugins(root);
  const problems = [];
  for (const { id, file } of readPending(root)) {
    if (!ID.test(id)) problems.push(`${file}: the id must be lower-case words joined by hyphens`);
    let note;
    try { note = readJson(root, file); } catch (error) { problems.push(`${file}: ${error.message}`); continue; }
    problems.push(...noteProblems(note, known, file));
  }
  for (const file of files(root, CHANGESETS)) {
    let changeset;
    try { changeset = readJson(root, `${CHANGESETS}/${file}`); } catch (error) { problems.push(`${CHANGESETS}/${file}: ${error.message}`); continue; }
    problems.push(...changesetProblems(changeset, known, file));
  }
  return problems;
}

export function bumpVersion(version, bump) {
  const [, major, minor, patch] = version.match(SEMVER).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// The release each plugin with a note that bumps would get; plugins whose notes are all bump none stay unreleased.
export function plan(root) {
  const pending = readPending(root);
  const releases = [];
  for (const plugin of plugins(root)) {
    const notes = pending.filter(p => p.note.plugins.includes(plugin));
    const bump = notes.reduce((top, p) => (BUMPS.indexOf(p.note.bump) > BUMPS.indexOf(top) ? p.note.bump : top), 'none');
    if (bump === 'none') continue;
    const previous = readJson(root, `plugins/${plugin}/.claude-plugin/plugin.json`).version;
    releases.push({ plugin, previous, version: bumpVersion(previous, bump), bump, notes });
  }
  return { action: releases.length ? 'release' : 'none', pending: pending.length, releases };
}

const sentence = text => (/[.!?]$/.test(text) ? text : `${text}.`);

export function changelogEntry(release) {
  const bumping = release.notes.filter(n => n.note.bump !== 'none');
  const lead = `${bumping.map(n => n.note.title).join('; ')}.`;
  const items = release.notes.map(n => `- **${sentence(n.note.title)}** ${n.note.summary}`);
  return `## ${release.version}\n\n${lead}\n\n${items.join('\n')}\n`;
}

export function changesetFor(release) {
  return {
    format: CHANGESET_FORMAT, plugin: release.plugin, version: release.version, previous: release.previous, bump: release.bump,
    notes: release.notes.map(n => ({ id: n.id, bump: n.note.bump, title: n.note.title, summary: n.note.summary })),
  };
}

export function releaseNotes(changeset) {
  const items = changeset.notes.map(n => `- **${sentence(n.title)}** ${n.summary}`);
  return `${changeset.plugin} ${changeset.version} (${changeset.bump}, from ${changeset.previous}).\n\n${items.join('\n')}\n`;
}

function setVersion(root, rel, from, to) {
  const text = readFileSync(join(root, rel), 'utf8');
  const next = text.replace(`"version": "${from}"`, `"version": "${to}"`);
  if (next === text) throw new Error(`${rel}: no "version": "${from}" to raise`);
  writeText(root, rel, next);
}

export function apply(root, result) {
  for (const release of result.releases) {
    const { plugin, previous, version } = release;
    for (const host of ['.claude-plugin', '.codex-plugin']) setVersion(root, `plugins/${plugin}/${host}/plugin.json`, previous, version);
    const lock = readFileSync(join(root, 'sources.lock.json'), 'utf8');
    const pinned = new RegExp(`("pluginVersion": \\{[^}]*"${plugin}": ")${previous.replaceAll('.', '\\.')}"`);
    if (!pinned.test(lock)) throw new Error(`sources.lock.json: pluginVersion ${plugin} is not ${previous}`);
    writeText(root, 'sources.lock.json', lock.replace(pinned, `$1${version}"`));
    const changelog = `plugins/${plugin}/CHANGELOG.md`;
    const text = readFileSync(join(root, changelog), 'utf8');
    const at = text.indexOf('\n## ');
    if (!text.startsWith('# Changelog\n') || at < 0) throw new Error(`${changelog}: expected "# Changelog" and an earlier entry`);
    writeText(root, changelog, `${text.slice(0, at + 1)}${changelogEntry(release)}\n${text.slice(at + 1)}`);
    mkdirSync(join(root, CHANGESETS), { recursive: true });
    writeText(root, `${CHANGESETS}/${plugin}-${version}.json`, jsonText(changesetFor(release)));
  }
  const consumed = new Set(result.releases.flatMap(r => r.notes.map(n => n.file)));
  for (const file of consumed) rmSync(join(root, file));
}

export function prBody(result) {
  const parts = result.releases.map(r => `## ${r.plugin} ${r.version}\n\n${releaseNotes(changesetFor(r))}`);
  return [
    'Folds the pending release notes into the next plugin versions (decision `public-release-notes`). Review the changelog text like any other change, then merge with a merge commit: the merge records the release, and the Release workflow tags it once Gates passes on main.',
    ...parts,
    FOOTER,
    '',
  ].join('\n\n');
}

export function tags(root) {
  return files(root, CHANGESETS).map(file => {
    const changeset = readJson(root, `${CHANGESETS}/${file}`);
    return `${changeset.plugin}-v${changeset.version}`;
  });
}

function slugId(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 7).join('-');
}

function options(rest, allowed) {
  const found = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith('--') || !allowed.includes(key.slice(2))) return null;
    if (key === '--write') { found.write = true; continue; }
    if (i + 1 >= rest.length) return null;
    found[key.slice(2)] = rest[++i];
  }
  return found;
}

export function main(argv, root = fileURLToPath(new URL('../', import.meta.url)), out = t => process.stdout.write(t), err = t => process.stderr.write(t)) {
  const [verb, ...rest] = argv;
  const refuse = problems => { err(`Release refused:\n${problems.map(p => `  ${p}`).join('\n')}\n`); return 1; };
  if (verb === 'note') {
    const o = options(rest, ['plugin', 'bump', 'title', 'summary', 'id']);
    if (!o || !o.plugin || !o.bump || !o.title || !o.summary) { err(USAGE); return 2; }
    const note = { format: NOTE_FORMAT, bump: o.bump, title: o.title.trim(), summary: o.summary.trim(), plugins: o.plugin.split(',').map(s => s.trim()).sort() };
    const id = o.id ?? slugId(note.title);
    const file = `${PENDING}/${id}.json`;
    const problems = noteProblems(note, plugins(root), file);
    if (!ID.test(id)) problems.push(`${file}: the id must be lower-case words joined by hyphens`);
    if (existsSync(join(root, file))) problems.push(`${file}: a note with this id is already pending; pass --id`);
    if (problems.length) return refuse(problems);
    mkdirSync(join(root, PENDING), { recursive: true });
    writeText(root, file, jsonText(note));
    out(`${file} written\n`);
    return 0;
  }
  if (verb === 'check' && rest.length === 0) {
    const problems = check(root);
    if (problems.length) return refuse(problems);
    out(`release notes: ${readPending(root).length} pending, ${files(root, CHANGESETS).length} changesets, all well formed\n`);
    return 0;
  }
  if (verb === 'version') {
    const o = options(rest, ['write', 'pr-body']);
    if (!o) { err(USAGE); return 2; }
    const problems = check(root);
    if (problems.length) return refuse(problems);
    const result = plan(root);
    if (o.write && result.action === 'release') apply(root, result);
    if (o['pr-body'] && result.action === 'release') writeFileSync(o['pr-body'], prBody(result), 'utf8');
    out(jsonText({
      action: result.action, pending: result.pending, written: Boolean(o.write && result.action === 'release'),
      title: result.releases.map(r => `${r.plugin} ${r.version}`).join(', '),
      releases: result.releases.map(r => ({ plugin: r.plugin, previous: r.previous, version: r.version, bump: r.bump, notes: r.notes.map(n => n.id) })),
    }));
    return 0;
  }
  if (verb === 'list' && rest.length === 0) {
    for (const tag of tags(root)) out(`${tag}\n`);
    return 0;
  }
  if (verb === 'show' && rest.length === 1) {
    const match = rest[0].match(/^([a-z0-9-]+)-v(\d+\.\d+\.\d+)$/);
    const file = match && `${CHANGESETS}/${match[1]}-${match[2]}.json`;
    if (!file || !existsSync(join(root, file))) return refuse([`no changeset for ${rest[0]}`]);
    out(releaseNotes(readJson(root, file)));
    return 0;
  }
  err(USAGE);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
