import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
test('Delivery discovers hosted UX before native resolution without restoring a fifth skill', () => {
  assert.deepEqual(readdirSync(fileURLToPath(new URL('skills/', root))).sort(), ['delivery', 'doctor', 'init', 'knowledge', 'work']);
  const delivery = read('skills/delivery/SKILL.md');
  assert.match(delivery.split('---')[1], /UX improvements.*design tokens.*accessibility audits/);
  const stage = delivery.indexOf('references/design-stage.md');
  const native = delivery.indexOf('scripts/resolve.mjs');
  assert.ok(stage >= 0 && stage < native, 'hosted UX must branch before native binding resolution');
  assert.match(delivery, /--entry delivery/);
  assert.match(delivery, /software architecture, code components or boundaries follows the resolver/);
  assert.match(read('skills/init/SKILL.md'), /references\/design-stage.md/);
  assert.match(read('references/design-stage.md'), /design-service.md/);
  assert.match(read('references/design-service.md'), /scripts\/design.mjs/);
  for (const host of ['.claude-plugin', '.codex-plugin']) {
    const manifest = JSON.parse(read(`${host}/plugin.json`));
    assert.match(manifest.description, /Delivery.*UX/);
  }
  for (const path of ['CODEX.md', 'README.md', 'references/design-stage.md', 'references/design-service.md']) {
    assert.doesNotMatch(read(path), /skills\/development\/|Development entry|Development description/);
  }
});
