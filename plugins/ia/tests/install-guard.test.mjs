import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { installedKit, installedKits, kitInstallMatches, kitInstallation, requireKitInstalled } from '../scripts/lib/kit.mjs';
import { makeRepo, sandbox } from './helpers/fixtures.mjs';

// Which kits a repository's own lock installs: presence is one question, identity another.
const KIT = 'inventarch/ia-kb-kit';
const ARCHIVE = 'd'.repeat(64), OTHER = 'e'.repeat(64);
const base = { id: 'inventarch/language', version: '3.2.0', archive: 'b'.repeat(64) };
const carrier = kits => ({ kind: 'package', name: '@inventarch/public-kits', version: '1.0.0', integrity: 'sha512-' + 'E'.repeat(86) + '==', kits });
const repoWith = (t, lock) => makeRepo(join(sandbox(t, 'ia-install-guard-'), 'repo'), lock === undefined ? {} : { lock });
const codeOf = action => { try { action(); } catch (error) { return error.code ?? `other:${error.message}`; } return undefined; };

test('a packages row installs', t => {
  const repo = repoWith(t, { packages: [base, { id: KIT, version: '0.9.0', archive: ARCHIVE }] });
  assert.doesNotThrow(() => requireKitInstalled(repo, { id: KIT }));
  assert.deepEqual(kitInstallation(repo, KIT), { via: 'package', version: '0.9.0', archive: ARCHIVE });
  assert.equal(installedKit(repo, KIT).archive, ARCHIVE);
});

test('an entries package carrier row naming the kit installs', t => {
  const repo = repoWith(t, { packages: [base], entries: [carrier([{ id: KIT, version: '0.9.0', archive: ARCHIVE }])] });
  assert.doesNotThrow(() => requireKitInstalled(repo, { id: KIT }));
  assert.deepEqual(kitInstallation(repo, KIT), { via: 'entry', version: '0.9.0', archive: ARCHIVE });
  assert.equal(installedKit(repo, KIT).id, KIT, 'installedKit returns the entries row too');
  assert.deepEqual(installedKits(repo).map(k => k.id), [KIT], 'installedKits lists carrier kits and leaves out the base');
});

test('presence ignores the archive: an entries row with another archive for the id still counts as installed', t => {
  const repo = repoWith(t, { packages: [base], entries: [carrier([{ id: KIT, version: '0.9.0', archive: OTHER }])] });
  assert.doesNotThrow(() => requireKitInstalled(repo, { id: KIT }));
});

test('installed at another version than the one resolved is still installed (the retained pin keeps running)', t => {
  const repo = repoWith(t, { packages: [base, { id: KIT, version: '1.2.0', archive: ARCHIVE }] });
  assert.doesNotThrow(() => requireKitInstalled(repo, { id: KIT }));
});

test('kitInstallMatches is false for another archive or version and true for the row\'s own', t => {
  const repo = repoWith(t, { packages: [base, { id: KIT, version: '0.9.0', archive: ARCHIVE }] });
  assert.equal(kitInstallMatches(repo, { id: KIT, version: '0.9.0', archive: ARCHIVE }), true);
  assert.equal(kitInstallMatches(repo, { id: KIT, version: '0.9.0', archive: OTHER }), false);
  assert.equal(kitInstallMatches(repo, { id: KIT, version: '0.8.0', archive: ARCHIVE }), false);
  assert.equal(kitInstallMatches(repo, { id: 'inventarch/none', version: '0.9.0', archive: ARCHIVE }), false);
  const viaEntry = repoWith(t, { packages: [base], entries: [carrier([{ id: KIT, version: '0.9.0', archive: ARCHIVE }])] });
  assert.equal(kitInstallMatches(viaEntry, { id: KIT, version: '0.9.0', archive: ARCHIVE }), true);
  assert.equal(kitInstallMatches(viaEntry, { id: KIT, version: '0.9.0', archive: OTHER }), false);
});

test('a row for another kit, or a carrier row that is not a package carrier, does not install it', t => {
  const other = repoWith(t, { packages: [base, { id: 'inventarch/other-kit', version: '0.9.0', archive: ARCHIVE }] });
  assert.equal(codeOf(() => requireKitInstalled(other, { id: KIT })), 'IA-CORE-KIT-NOT-INSTALLED');
  const file = repoWith(t, { packages: [base], entries: [{ ...carrier([{ id: KIT, version: '0.9.0', archive: ARCHIVE }]), kind: 'file' }] });
  assert.equal(codeOf(() => requireKitInstalled(file, { id: KIT })), 'IA-CORE-KIT-NOT-INSTALLED');
});

test('no lock at all is not installed', t => {
  const repo = repoWith(t);
  assert.equal(codeOf(() => requireKitInstalled(repo, { id: KIT })), 'IA-CORE-KIT-NOT-INSTALLED');
  assert.equal(kitInstallation(repo, KIT), null);
});

test('an unreadable lock refuses as corrupt, not as not-installed', t => {
  const repo = repoWith(t);
  writeLock(repo, '{ not json');
  assert.throws(() => requireKitInstalled(repo, { id: KIT }), SyntaxError);
});

test('the error code is IA-CORE-KIT-NOT-INSTALLED and not IA-CORE-PIN-UNAVAILABLE, and the message names the kit and the remedy', t => {
  const repo = repoWith(t, { packages: [base] });
  assert.throws(() => requireKitInstalled(repo, { id: KIT }), error => {
    assert.equal(error.code, 'IA-CORE-KIT-NOT-INSTALLED');
    assert.notEqual(error.code, 'IA-CORE-PIN-UNAVAILABLE');
    assert.equal(error.message, `kit ${KIT} is bound by this repository but its lock does not install it; run ia install ${KIT} (or kit.mjs add ${KIT}), then resolve again`);
    return true;
  });
});
function writeLock(repo, text) { writeFileSync(join(repo, '.ia', 'distributions.lock.json'), text); }
