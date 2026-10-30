import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const lib = await import('../scripts/lib/home.mjs').catch(() => ({}));
const { iaHome, closureStore } = lib;
const scripts = new URL('../scripts/', import.meta.url);

test('iaHome defaults to the user home .ia', () => {
  assert.equal(iaHome({}, 'C:/u'), join('C:/u', '.ia'));
});

test('iaHome uses an absolute IA_HOME', () => {
  const dir = tmpdir();
  assert.equal(iaHome({ IA_HOME: dir }, 'C:/u'), resolve(dir));
});

test('iaHome treats an empty IA_HOME as unset', () => {
  assert.equal(iaHome({ IA_HOME: '' }, 'C:/u'), join('C:/u', '.ia'));
});

test('iaHome refuses a relative IA_HOME', () => {
  for (const value of ['.ia', 'sub/dir', ...(process.platform === 'win32' ? ['C:', 'C:foo'] : [])]) {
    assert.throws(() => iaHome({ IA_HOME: value }, 'C:/u'), { code: 'IA-CORE-HOME-RELATIVE' }, value);
  }
});

test('closureStore uses IA_CORE_CLOSURES_DIR, else the IA home', () => {
  const dir = tmpdir(), other = join(dir, 'other');
  assert.equal(closureStore({ IA_CORE_CLOSURES_DIR: other, IA_HOME: dir }), resolve(other));
  assert.equal(closureStore({ IA_HOME: dir }), join(resolve(dir), 'method-closures-v1'));
  assert.equal(closureStore({ IA_CORE_CLOSURES_DIR: '' , IA_HOME: dir }), join(resolve(dir), 'method-closures-v1'));
});

test('the core entry points pass the closure store', () => {
  for (const [file, call] of [['check.mjs', 'runMethodCheck'], ['resolve.mjs', 'resolveQualifiedMethod']]) {
    const source = readFileSync(fileURLToPath(new URL(file, scripts)), 'utf8');
    const line = source.split('\n').find(text => text.includes(`await ${call}(`));
    assert.ok(line, `${file} calls ${call}`);
    assert.match(line, /storeRoot: closureStore\(\)/, `${file} passes storeRoot`);
  }
});

test('the core skill, README and CODEX.md place task pins under the IA home, not a fixed ~/.ia', () => {
  for (const rel of ['../skills/init/SKILL.md', '../README.md', '../CODEX.md']) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /~\/\.ia\/work-v1\/<project>/, rel);
    assert.match(text, /<IA home>\/work-v1\/<project>\/<task>/, rel);
  }
});
