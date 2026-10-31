// Releases format 2 (lib/releases.mjs, decision public-releases-format-2): a
// format 1 history converts losslessly (expanding rebuilds its bytes), a
// converted folder is left alone, a differing per-version file is refused, the
// readers accept both formats, and recording a release appends the file and
// the index row with latest and never rewrites another version's file.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandReleases, listKits, readReleases, releaseRecords } from '../scripts/lib/kit.mjs';
import { checkFile, checkIndex, convertFolder, expandFolder, isVersion, recordRelease, releaseText, split } from '../scripts/lib/releases.mjs';
import { sandbox } from './helpers/fixtures.mjs';

const row = (version, n) => ({ version, archive: String(n).repeat(64), manifest: 'm'.repeat(64), sources: 's'.repeat(64), language: 'inventarch/language ^3.2.0', cli: '@inventarch/cli 3.4.1', records: [{ system: 'x', word: 'law', name: `law-${n}` }] });
function kitFolder(t) {
  const dir = join(sandbox(t, 'ia-core-releases-'), 'kits', 'x');
  mkdirSync(join(dir, '.ia'), { recursive: true });
  writeFileSync(join(dir, '.ia', 'release.json'), JSON.stringify({ id: 'inventarch/x-kit', version: '0.2.0' }));
  const original = { kit: 'inventarch/x-kit', releases: [row('0.1.0', 1), row('0.2.0', 2)] };
  writeFileSync(join(dir, 'releases.json'), releaseText(original));
  return { dir, original };
}

test('a format 1 history converts to an index and per-version files, and expands back byte for byte', t => {
  const { dir, original } = kitFolder(t);
  const before = readFileSync(join(dir, 'releases.json'), 'utf8');
  assert.equal(convertFolder(dir, { check: true }).status, 'planned');
  assert.equal(readFileSync(join(dir, 'releases.json'), 'utf8'), before, '--check writes nothing');
  const converted = convertFolder(dir);
  assert.deepEqual([converted.status, converted.bytesEqual, converted.latest], ['converted', true, '0.2.0']);
  const index = JSON.parse(readFileSync(join(dir, 'releases.json'), 'utf8'));
  assert.deepEqual(Object.keys(index), ['format', 'kit', 'latest', 'releases']);
  assert.deepEqual(Object.keys(index.releases[0]), ['version', 'archive', 'manifest', 'sources', 'language', 'cli', 'file'], '"file" sits where "records" was');
  assert.equal(releaseText(expandFolder(dir)), before);
  assert.deepEqual(expandReleases(dir), original);
  assert.equal(convertFolder(dir).status, 'already');
  const kit = listKits(join(dir, '..'))[0];
  assert.equal(kit.latest.version, '0.2.0');
  assert.deepEqual(releaseRecords(dir, kit.latest), original.releases[1].records);
});

test('a differing per-version file is refused, and readers refuse an index whose latest is not its last row', t => {
  const { dir } = kitFolder(t);
  mkdirSync(join(dir, 'releases'));
  writeFileSync(join(dir, 'releases', '0.1.0.json'), '{"format":2}\n');
  assert.throws(() => convertFolder(dir), /exists with other bytes/);
  const other = kitFolder(t);
  convertFolder(other.dir);
  const index = JSON.parse(readFileSync(join(other.dir, 'releases.json'), 'utf8'));
  writeFileSync(join(other.dir, 'releases.json'), releaseText({ ...index, latest: '0.1.0' }));
  assert.throws(() => readReleases(other.dir), /latest 0\.1\.0 is not its last release 0\.2\.0/);
  writeFileSync(join(other.dir, 'releases.json'), releaseText(index));
  const file = JSON.parse(readFileSync(join(other.dir, 'releases', '0.2.0.json'), 'utf8'));
  writeFileSync(join(other.dir, 'releases', '0.2.0.json'), releaseText({ ...file, archive: 'f'.repeat(64) }));
  assert.throws(() => releaseRecords(other.dir, index.releases[1]), /does not belong to/);
});

test('recording a release appends its file and row, sets latest, adds source and offers, and never rewrites a published file', t => {
  const { dir } = kitFolder(t);
  convertFolder(dir);
  const published = readFileSync(join(dir, 'releases', '0.1.0.json'), 'utf8');
  const { records, ...next } = row('0.3.0', 3);
  recordRelease(dir, { ...next, source: { repository: 'https://example.invalid/kits.git', commit: 'c'.repeat(40) } }, records, { offers: { keys: ['work.*'] } });
  const index = JSON.parse(readFileSync(join(dir, 'releases.json'), 'utf8'));
  assert.equal(index.latest, '0.3.0');
  assert.deepEqual(Object.keys(index.releases[2]), ['version', 'archive', 'manifest', 'sources', 'language', 'cli', 'file', 'source']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'releases', '0.3.0.json'), 'utf8')).offers, { keys: ['work.*'] });
  assert.equal(readFileSync(join(dir, 'releases', '0.1.0.json'), 'utf8'), published);
  const { records: again, ...changed } = row('0.1.0', 9);
  assert.throws(() => recordRelease(dir, changed, again), /bump the version/);
  assert.equal(readFileSync(join(dir, 'releases', '0.1.0.json'), 'utf8'), published);
});

test('a version is strict semver: the index, its rows, the per-version file and a recorded release refuse a version that names a path', t => {
  for (const version of ['1.2.0', '0.1.0-rc.1', '1.0.0+build.7']) assert.equal(isVersion(version), true, version);
  for (const version of ['../../../escaped-kit', '..', '1.0', '01.0.0', '1.0.0/..', '1.0.0\\..\\x', '', null, 'x'.repeat(65)]) assert.equal(isVersion(version), false, String(version));
  const escaped = '../../../escaped-kit';
  const { records, ...rest } = row(escaped, 1);
  const index = { format: 2, kit: 'inventarch/x-kit', latest: escaped, releases: [{ ...rest, file: `releases/${escaped}.json` }] };
  assert.throws(() => checkIndex(index), /release 0's version "\.\.\/\.\.\/\.\.\/escaped-kit" is not a semver version/);
  // The file names exactly releases/<version>.json, nothing that resolves to it.
  const good = row('0.1.0', 1);
  delete good.records;
  assert.throws(() => checkIndex({ format: 2, kit: 'inventarch/x-kit', latest: '0.1.0', releases: [{ ...good, file: 'releases/../releases/0.1.0.json' }] }), /names file releases\/\.\.\/releases\/0\.1\.0\.json, expected releases\/0\.1\.0\.json/);
  assert.throws(() => checkIndex({ format: 2, kit: 'inventarch/x-kit', latest: '0.1.0', releases: [{ ...good, file: 'releases/0.1.0.json' }, { ...good, file: 'releases/0.1.0.json' }] }), /recorded twice/);
  assert.throws(() => checkFile({ kit: 'inventarch/x-kit' }, { ...rest, version: escaped }, { format: 2, kit: 'inventarch/x-kit', version: escaped, archive: rest.archive, records }), /is not a semver version/);
  assert.throws(() => split({ kit: 'inventarch/x-kit', releases: [row(escaped, 1)] }), /no semver version/);
  // A kit folder whose index (either format) carries such a version is refused by the readers, before any file is read.
  const { dir } = kitFolder(t);
  writeFileSync(join(dir, 'releases.json'), releaseText(index));
  assert.throws(() => readReleases(dir), e => e.code === 'IA-CORE-KIT' && /not a semver version/.test(e.message));
  writeFileSync(join(dir, 'releases.json'), releaseText({ kit: 'inventarch/x-kit', releases: [row(escaped, 1)] }));
  assert.throws(() => readReleases(dir), e => e.code === 'IA-CORE-KIT' && /not a semver version/.test(e.message));
  const other = kitFolder(t);
  convertFolder(other.dir);
  assert.throws(() => recordRelease(other.dir, rest, records), /the recorded release version "\.\.\/\.\.\/\.\.\/escaped-kit" is not a semver version/);
  assert.equal(existsSync(join(other.dir, '..', '..', 'escaped-kit.json')), false, 'nothing is written outside the kit');
});
