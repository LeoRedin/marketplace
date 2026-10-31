// A kit's recorded releases, in either layout.
//
// Format 1 (the old layout): kits/<kit>/releases.json is
//   { "kit": "<id>", "releases": [ { version, archive, manifest, sources, language, cli, records: [...] } ] }
// Format 2 (the current layout): a small index plus one file per version,
//   releases.json            { "format": 2, "kit", "latest", "releases": [ { ...the same fields, "file": "releases/<version>.json" where "records" was, source? } ] }
//   releases/<version>.json  { "format": 2, "kit", "version", "archive", "records": [...], offers? }
// An index row keeps every field in its original order, so expanding it
// (replacing "file" by the file's records) rebuilds the format 1 document
// byte for byte. A per-version file is immutable once published; its kit,
// version and archive must match its row, so it cannot be paired with another.
// Every version is strict semver (isVersion) and every row's file is exactly
// releases/<version>.json: a version names a folder and a file, so one such as
// ../../x would reach outside the kit, and the IA home an install writes to.
import { deepStrictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FORMAT = 2;
// Semantic Versioning 2.0.0, at most 64 characters: no separator, no "..".
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const isVersion = value => typeof value === 'string' && value.length <= 64 && SEMVER.test(value);
export const releaseText = value => JSON.stringify(value, null, 2) + '\n';
export const releaseFile = version => `releases/${version}.json`;

export class ReleaseError extends Error {
  constructor(message, code = 'IA-CORE-RELEASES') { super(message); this.code = code; }
}

// Refuses a version that is not strict semver; returns it.
export function assertVersion(value, what = 'version') {
  if (!isVersion(value)) throw new ReleaseError(`${what} ${JSON.stringify(value)} is not a semver version such as 1.2.0`);
  return value;
}

// Checks release rows (either format): each version strict semver, each once.
export function checkRows(rows) {
  const seen = new Set();
  for (const [i, row] of rows.entries()) {
    assertVersion(row?.version, `release ${i}'s version`);
    if (seen.has(row.version)) throw new ReleaseError(`version ${row.version} is recorded twice`);
    seen.add(row.version);
  }
  return rows;
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

// Format 1 -> { index, files: Map<relative path, object> }.
export function split(original) {
  const keys = Object.keys(original ?? {});
  if (typeof original?.kit !== 'string' || !Array.isArray(original.releases) || keys.some(k => !['kit', 'releases'].includes(k))) {
    throw new ReleaseError(`not a format 1 releases.json: expected exactly { kit, releases }, found { ${keys.join(', ')} }`);
  }
  if (original.releases.length === 0) throw new ReleaseError('records no release; nothing to split');
  const files = new Map();
  const rows = original.releases.map((release, i) => {
    const { version } = release ?? {};
    if (!isVersion(version)) throw new ReleaseError(`release ${i} has no semver version: ${JSON.stringify(version)}`);
    if (!Array.isArray(release.records)) throw new ReleaseError(`release ${version} has no records list`);
    if (Object.hasOwn(release, 'file')) throw new ReleaseError(`release ${version} already has a "file" field`);
    if (typeof release.archive !== 'string') throw new ReleaseError(`release ${version} has no archive`);
    const file = releaseFile(version);
    if (files.has(file)) throw new ReleaseError(`version ${version} is recorded twice`);
    files.set(file, { format: FORMAT, kit: original.kit, version, archive: release.archive, records: release.records });
    return Object.fromEntries(Object.entries(release).map(([k, v]) => (k === 'records' ? ['file', file] : [k, v])));
  });
  return { index: { format: FORMAT, kit: original.kit, latest: rows.at(-1).version, releases: rows }, files };
}

// Checks a format 2 index's shape: every version strict semver, latest is its
// last row, every row names exactly its own file, releases/<version>.json.
export function checkIndex(index) {
  if (index?.format !== FORMAT || typeof index.kit !== 'string' || !Array.isArray(index.releases)) throw new ReleaseError('not a format 2 releases.json index');
  checkRows(index.releases);
  if (index.latest !== null || index.releases.length) assertVersion(index.latest, 'index latest');
  if (index.latest !== (index.releases.at(-1)?.version ?? null)) throw new ReleaseError(`index latest ${index.latest} is not its last release ${index.releases.at(-1)?.version}`);
  for (const row of index.releases) if (row.file !== releaseFile(row.version)) throw new ReleaseError(`release ${row.version} names file ${row.file}, expected ${releaseFile(row.version)}`);
  return index;
}

// One per-version file, checked against its index row.
export function checkFile(index, row, file) {
  assertVersion(row?.version, 'release version');
  if (file?.format !== FORMAT || file.kit !== index.kit || file.version !== row.version || file.archive !== row.archive || !Array.isArray(file.records)) {
    throw new ReleaseError(`${row.file} does not belong to ${index.kit} ${row.version} ${row.archive}`);
  }
  return file;
}

// Format 2 -> format 1. readFile(relative path) returns the parsed per-version file.
export function expand(index, readFile) {
  checkIndex(index);
  const releases = index.releases.map(row => {
    const file = checkFile(index, row, readFile(row.file));
    return Object.fromEntries(Object.entries(row).map(([k, v]) => (k === 'file' ? ['records', file.records] : [k, v])));
  });
  return { kit: index.kit, releases };
}

// Any document -> format 1 (format 1 passes through unchanged).
export function expandDocument(doc, readFile) {
  return doc?.format === FORMAT ? expand(doc, readFile) : doc;
}

export function expandFolder(dir) {
  return expandDocument(readJson(join(dir, 'releases.json')), rel => readJson(join(dir, rel)));
}

const writeAtomic = (path, bytes, { exclusive = false } = {}) => {
  const temporary = `${path}.writing-${process.pid}`;
  writeFileSync(temporary, bytes, { flag: 'wx' });
  if (exclusive && existsSync(path)) throw new ReleaseError(`${path} exists; a published release file is never rewritten`);
  renameSync(temporary, path);
};

// Converts a kit folder to format 2 in place, proving the conversion lossless.
export function convertFolder(dir, { check = false } = {}) {
  const indexPath = join(dir, 'releases.json');
  if (!existsSync(indexPath)) throw new ReleaseError(`${dir} has no releases.json`);
  const bytes = readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
  const parsed = JSON.parse(bytes);
  if (parsed.format === FORMAT) {
    const rebuilt = expandFolder(dir);
    return { status: 'already', kit: rebuilt.kit, releases: rebuilt.releases.length, latest: parsed.latest };
  }
  const { index, files } = split(parsed);
  const rebuilt = expand(JSON.parse(releaseText(index)), rel => JSON.parse(releaseText(files.get(rel))));
  deepStrictEqual(rebuilt, parsed);
  const bytesEqual = releaseText(rebuilt) === bytes;
  for (const [rel, value] of files) {
    const path = join(dir, rel);
    if (existsSync(path) && readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== releaseText(value)) throw new ReleaseError(`${rel} exists with other bytes; refusing to overwrite a release file`);
  }
  if (check) return { status: 'planned', kit: parsed.kit, releases: files.size, latest: index.latest, bytesEqual };
  mkdirSync(join(dir, 'releases'), { recursive: true });
  for (const [rel, value] of files) if (!existsSync(join(dir, rel))) writeAtomic(join(dir, rel), releaseText(value), { exclusive: true });
  writeAtomic(indexPath, releaseText(index));
  deepStrictEqual(expandFolder(dir), parsed);
  return { status: 'converted', kit: parsed.kit, releases: files.size, latest: index.latest, bytesEqual };
}

// Appends (or, before publication, replaces) one release in a format 2 folder:
// the per-version file first, then the index row, then latest. Rows stay
// semver-sorted. A per-version file that exists with other bytes is refused
// unless `replace` is set (a version not yet published).
export function recordRelease(dir, row, records, { offers, replace = false } = {}) {
  assertVersion(row?.version, 'the recorded release version');
  const indexPath = join(dir, 'releases.json');
  const index = checkIndex(readJson(indexPath));
  const file = releaseFile(row.version);
  const body = { format: FORMAT, kit: index.kit, version: row.version, archive: row.archive, records, ...(offers ? { offers } : {}) };
  const path = join(dir, file);
  if (existsSync(path) && readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== releaseText(body) && !replace) throw new ReleaseError(`${file} exists with other bytes; bump the version instead`);
  mkdirSync(join(dir, 'releases'), { recursive: true });
  writeFileSync(path, releaseText(body));
  const { source, ...rest } = row;
  const next = { ...rest, file, ...(source ? { source } : {}) };
  index.releases = [...index.releases.filter(r => r.version !== row.version), next].sort((a, b) => compareVersions(a.version, b.version));
  index.latest = index.releases.at(-1).version;
  writeFileSync(indexPath, releaseText(index));
  return { index, file: body };
}

const parts = v => v.split(/[.-]/).map(p => (/^\d+$/.test(p) ? Number(p) : p));
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? -1) < (y[i] ?? -1) ? -1 : 1;
  return 0;
}
