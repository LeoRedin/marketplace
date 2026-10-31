// Deterministic generator: a Mermaid map of the records' relations.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const arg = n => process.argv[process.argv.indexOf(n) + 1];
const root = arg('--root');
const out = arg('--out');
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ia') ? [join(d, e.name)] : []));
const nodes = new Set();
const edges = [];
for (const f of walk(join(root, '.ia', 'src')).sort()) {
  let id = null;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const h = /^@([a-z-]+) (\S+)/.exec(line);
    if (h) { id = h[2]; nodes.add(id); continue; }
    const r = /^\s+(grounded-by|cites|uses)\s+(\S+)/.exec(line);
    if (r && id) edges.push(`  ${id} -->|${r[1]}| ${r[2]}`);
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `graph LR\n${[...nodes].sort().map(n => `  ${n}`).join('\n')}\n${edges.sort().join('\n')}\n`);
