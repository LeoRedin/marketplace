// Retains exact carried method and core helper bytes. This deliberately does
// not claim the full qualified method-closure schema or ambient executor proof.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closureStore } from './home.mjs';
import { findKit, KitError } from './kit.mjs';
import { canonical } from './packet.mjs';

const FORMAT = 'inventarch.method-bytes/1';
const PLUGIN = fileURLToPath(new URL('../..', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new KitError(message, 'IA-CORE-CLOSURE-INTEGRITY'); };
const store = () => closureStore();
function files(root) {
  const found = [], folded = new Set();
  let bytes = 0;
  function visit(dir) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`method directory is not regular: ${dir}`);
    for (const name of readdirSync(dir).sort()) {
      if (name.includes('\\') || name.includes(':') || name.includes('\0')) fail('unsafe retained path');
      const path = join(dir, name), rel = relative(root, path).replace(/\\/g, '/');
      if (rel === '.ia/distributions' || rel === '.ia/work') continue;
      const entry = lstatSync(path);
      const key = rel.normalize('NFC').toLowerCase();
      if (folded.has(key)) fail(`case-fold collision in method: ${rel}`);
      folded.add(key);
      if (entry.isSymbolicLink()) fail(`method symlink is unsupported: ${rel}`);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile()) fail(`method content is not a file: ${rel}`);
      const data = readFileSync(path);
      bytes += data.length;
      if (data.length > 16 * 1024 * 1024 || bytes > 128 * 1024 * 1024 || found.length >= 10000) fail('retained method resource limit exceeded');
      found.push({ path: rel, sha256: sha(data), bytes: data.length, data });
    }
  }
  visit(root);
  return found;
}
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
function inventory(root) { return files(root).map(({ data, ...entry }) => entry).sort(byPath); }
// Ordinary retained runners use the core identity and the process helper's
// qualified Windows supervisor data. Retain these exact dependencies too;
// do not copy the other kits or silently consult a current installation.
function supportFiles() {
  return ['.claude-plugin/plugin.json', 'config/qualified-process-tools.json'].map(path => {
    let current = PLUGIN;
    for (const [index, part] of path.split('/').entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index === 0 ? !stat.isDirectory() : !stat.isFile())) fail(`core support input is not regular: ${path}`);
      if (index === 1 && stat.size > 256 * 1024) fail(`core support input is too large: ${path}`);
    }
    const data = readFileSync(current);
    if (data.length > 256 * 1024) fail(`core support input is too large: ${path}`);
    return { path, sha256: sha(data), bytes: data.length, data };
  });
}
function verify(root, manifest, digest) {
  if (manifest.format !== FORMAT || sha(canonical(manifest)) !== digest) fail('retained method manifest digest mismatch');
  if (canonical(inventory(join(root, 'payload'))) !== canonical(manifest.files)) fail('retained method bytes differ from their content digest');
  return manifest;
}
export function retainedKit(digest) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) fail('invalid retained method digest');
  const root = join(store(), digest), path = join(root, 'manifest.json');
  if (!existsSync(path)) throw new KitError(`retained method ${digest} is missing; restore its exact bytes or explicitly rebind`, 'IA-CORE-CLOSURE-MISSING');
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('retained method manifest is not JSON'); }
  verify(root, manifest, digest);
  const pluginDir = join(root, 'payload');
  const kit = findKit(manifest.kit, join(pluginDir, 'config', 'kits'));
  return { ...kit, pluginDir, retained: digest };
}
export function retainKit(kit) {
  if (kit.retained) return retainedKit(kit.retained);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(kit.folder)) fail('unsafe kit folder');
  const source = [
    ...files(kit.dir).map(entry => ({ ...entry, path: `config/kits/${kit.folder}/${entry.path}` })),
    ...files(join(PLUGIN, 'scripts')).map(entry => ({ ...entry, path: `scripts/${entry.path}` })),
    ...supportFiles(),
  ];
  if (source.length > 10000 || source.reduce((sum, entry) => sum + entry.bytes, 0) > 128 * 1024 * 1024) fail('retained method resource limit exceeded');
  // Canonical order is the complete relative path, not directory traversal order.
  source.sort(byPath);
  const manifest = { format: FORMAT, kit: kit.id, files: source.map(({ data, ...entry }) => entry) };
  const digest = sha(canonical(manifest));
  mkdirSync(store(), { recursive: true, mode: 0o700 });
  const target = join(store(), digest);
  if (existsSync(target)) return retainedKit(digest);
  const work = mkdtempSync(join(store(), 'staging-'));
  try {
    for (const entry of source) {
      const destination = join(work, 'payload', entry.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, entry.data, { flag: 'wx' });
    }
    writeFileSync(join(work, 'manifest.json'), canonical(manifest) + '\n', { flag: 'wx' });
    verify(work, manifest, digest);
    // Source changes during capture refuse publication rather than mixing reads.
    const now = [
      ...inventory(kit.dir).map(entry => ({ ...entry, path: `config/kits/${kit.folder}/${entry.path}` })),
      ...inventory(join(PLUGIN, 'scripts')).map(entry => ({ ...entry, path: `scripts/${entry.path}` })),
      ...supportFiles().map(({ data, ...entry }) => entry),
    ].sort(byPath);
    if (canonical(now) !== canonical(manifest.files)) fail('method changed while retaining its bytes');
    try { renameSync(work, target); } catch (error) { if (!existsSync(target)) throw error; }
    return retainedKit(digest);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
