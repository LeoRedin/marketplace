#!/usr/bin/env node
// SPIKE (docs/spikes/upkeep-agent.md): the deterministic half of the upkeep
// agent. It decides, with no model, whether anything is worth starting the
// agent for.
//   upkeep.mjs stale  [--root <dir>] [--sidecar <file>] [--base <ref>] [--changed a,b] [--json]
//   upkeep.mjs record <id> [--root] [--sidecar]                  record the current digests as fresh
//   upkeep.mjs build  [<id>] --allow-code [--root] [--sidecar]   run script generators, then record
// A sidecar (derived.json, format 1) declares derived outputs:
//   { format: 1, outputs: [ { id, inputs: [glob...], output: "path",
//       generator: { script: "scripts/x.mjs" } | { capability: "<capability>" } } ] }
// Inputs and output are relative to the workspace root. The recorded digests
// live in <root>/.ia/derived.lock.json. Stale reasons: never-recorded,
// inputs-changed, output-missing, output-edited (a person changed it by hand:
// the agent must not overwrite it silently). Also lists records (.ia/src/**.ia)
// whose `source`, `cites` or `grounded-by` lines name a changed file.
// Exit 0 nothing stale (and silent without --json), 3 something stale, 2 usage.
// `build` runs kit code, so a production version must take the trust check of
// lib/trust.mjs kitTrust, as handlers do; here --allow-code stands in for it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCK = '.ia/derived.lock.json';
const sha = b => createHash('sha256').update(b).digest('hex');
const lf = f => sha(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));

function walk(root, dir = root, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(root, p, out); else out.push(relative(root, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

export function globToRegExp(glob) {
  let r = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { r += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') r += '[^/]*';
    else r += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${r}$`);
}

export function readSidecar(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed?.format !== 1 || !Array.isArray(parsed.outputs)) throw new Error(`${path} is malformed (format 1 with an outputs list)`);
  const ids = new Set();
  for (const [i, o] of parsed.outputs.entries()) {
    const where = `${path}: outputs[${i}]`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(o?.id ?? '') || ids.has(o.id)) throw new Error(`${where} needs a unique lowercase id`);
    ids.add(o.id);
    if (!Array.isArray(o.inputs) || !o.inputs.length || !o.inputs.every(s => typeof s === 'string' && !s.startsWith('/') && !s.includes('..'))) throw new Error(`${where}: inputs are root-relative globs`);
    if (typeof o.output !== 'string' || o.output.startsWith('/') || o.output.includes('..')) throw new Error(`${where}: output is a root-relative path`);
    const g = o.generator;
    if (!g || (Boolean(g.script) === Boolean(g.capability))) throw new Error(`${where}: generator is { script } or { capability }`);
  }
  return parsed.outputs;
}

// One digest over the matched input files: paths and LF-normalized bytes.
export function inputsDigest(root, globs) {
  const res = globs.map(globToRegExp);
  const files = walk(root).filter(f => f !== LOCK && res.some(r => r.test(f)));
  return { digest: sha(files.map(f => `${f}\0${lf(join(root, f))}`).join('\n')), files };
}

const readLock = root => { try { return JSON.parse(readFileSync(join(root, LOCK), 'utf8')).outputs ?? {}; } catch { return {}; } };
function writeLock(root, outputs) {
  mkdirSync(join(root, '.ia'), { recursive: true });
  writeFileSync(join(root, LOCK), `${JSON.stringify({ format: 1, outputs }, null, 2)}\n`);
}

export function staleOutputs(root, outputs) {
  const lock = readLock(root);
  const stale = [];
  for (const o of outputs) {
    const { digest, files } = inputsDigest(root, o.inputs);
    const rec = lock[o.id];
    const out = join(root, o.output);
    let reason = null;
    if (!rec) reason = 'never-recorded';
    else if (!existsSync(out)) reason = 'output-missing';
    else if (rec.output !== lf(out)) reason = 'output-edited';
    else if (rec.inputs !== digest) reason = 'inputs-changed';
    if (reason) stale.push({ id: o.id, reason, output: o.output, generator: o.generator.script ? 'script' : 'capability', inputFiles: files.length });
  }
  return stale;
}

export function record(root, outputs, id) {
  const lock = readLock(root);
  for (const o of outputs.filter(x => !id || x.id === id)) {
    if (!existsSync(join(root, o.output))) throw new Error(`${o.id}: ${o.output} does not exist`);
    lock[o.id] = { inputs: inputsDigest(root, o.inputs).digest, output: lf(join(root, o.output)) };
  }
  writeLock(root, lock);
}

// Records whose source, cites or grounded-by line names a changed file.
export function citingRecords(root, changed) {
  const hits = [];
  for (const f of walk(root).filter(f => f.startsWith('.ia/src/') && f.endsWith('.ia'))) {
    let id = null, word = null;
    for (const [n, line] of readFileSync(join(root, f), 'utf8').split(/\r?\n/).entries()) {
      const head = /^@([a-z-]+) (\S+)/.exec(line);
      if (head) { word = head[1]; id = head[2]; continue; }
      const rel = /^\s+(source|cites|grounded-by)\s+(.+)$/.exec(line);
      if (!rel) continue;
      for (const c of changed) if (rel[2].includes(c)) hits.push({ record: `${word}/${id}`, relation: rel[1], file: c, at: `${f}:${n + 1}` });
    }
  }
  return hits;
}

export function changedFiles(root, base) {
  const run = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const diff = run(['diff', '--name-only', base]);
  if (diff.status !== 0) throw new Error(`git diff ${base} failed: ${diff.stderr.trim()}`);
  const untracked = run(['ls-files', '-o', '--exclude-standard']).stdout;
  return [...new Set(`${diff.stdout}\n${untracked}`.split(/\r?\n/).filter(Boolean))].sort();
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const root = resolve(opt('--root') ?? process.cwd());
  const sidecar = resolve(opt('--sidecar') ?? join(root, 'derived.json'));
  const positional = rest.find((a, i) => !a.startsWith('--') && !String(rest[i - 1] ?? '').startsWith('--'));
  try {
    if (cmd === 'stale') {
      const outputs = existsSync(sidecar) ? readSidecar(sidecar) : [];
      const changed = opt('--changed') ? opt('--changed').split(',').filter(Boolean) : opt('--base') ? changedFiles(root, opt('--base')) : [];
      const report = { stale: staleOutputs(root, outputs), citing: citingRecords(root, changed), changed };
      const any = report.stale.length || report.citing.length;
      if (rest.includes('--json')) console.log(JSON.stringify({ ...report, startAgent: Boolean(any) }, null, 2));
      else if (any) {
        for (const s of report.stale) console.log(`stale ${s.id} (${s.reason}) -> ${s.output}`);
        for (const c of report.citing) console.log(`cites ${c.file}: ${c.record} (${c.relation}, ${c.at})`);
      }
      return any ? 3 : 0;
    }
    if (cmd === 'record') { record(root, readSidecar(sidecar), positional); return 0; }
    if (cmd === 'build') {
      if (!rest.includes('--allow-code')) { console.error('build runs kit code; pass --allow-code (production: kitTrust must hold)'); return 2; }
      const outputs = readSidecar(sidecar).filter(o => !positional || o.id === positional);
      for (const o of outputs) {
        if (!o.generator.script) { console.error(`${o.id}: capability generator, left to the agent`); continue; }
        const script = resolve(dirname(sidecar), o.generator.script);
        const r = spawnSync(process.execPath, [script, '--root', root, '--out', join(root, o.output)], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`${o.id}: generator failed: ${r.stderr.trim()}`);
        record(root, [o], o.id);
      }
      return 0;
    }
    console.error('usage: upkeep.mjs stale|record|build ...');
    return 2;
  } catch (error) { console.error(error.message); return 2; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
