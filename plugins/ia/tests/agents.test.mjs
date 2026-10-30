import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const agentsDir = new URL('../agents/', import.meta.url);

function tools(name) {
  const text = readFileSync(fileURLToPath(new URL(`${name}.md`, agentsDir)), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('tools:'));
  assert.ok(line, `${name} declares tools`);
  return line
    .slice('tools:'.length)
    .split(',')
    .map((t) => t.trim());
}

test('reader and worker list the IA door; checker does not', () => {
  assert.ok(tools('reader').includes('mcp__ia-workspace'));
  assert.ok(tools('worker').includes('mcp__ia-workspace'));
  assert.ok(!tools('checker').some((t) => t.startsWith('mcp__')));
});
