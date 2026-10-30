#!/usr/bin/env node
// Maintainer tool: keeps the kits a plugin carries equal to their source of
// truth under kits/. kits/bundle.json maps each kit folder to the plugin
// config folder that carries a copy of it:
//   { "format": 1, "bundles": [ { "kit": "<folder under kits/>", "into": "plugins/<plugin>/config/kits/<folder>" } ],
//     "unbundled": [ "<plugin kit folder still authored in its plugin>" ] }
//   node tools/bundle-kits.mjs --check    compare the copies with the sources
//   node tools/bundle-kits.mjs --write    make each copy equal to its source
// Files are compared byte for byte. Installed and scratch folders (node_modules,
// .scratch, build, __pycache__, .qualification, .ia/distributions, .ia/work)
// are never copied or compared, and a symlink or junction in a source or a target
// (or in any folder above them) is refused. A kit under kits/ that no entry names,
// and a plugin kit folder that no entry generates and "unbundled" does not list,
// are drift too. Exit 0 on success, 1 on drift, 2 on bad usage or a refused map.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node tools/bundle-kits.mjs (--check | --write)\n';
const SKIPPED_FOLDERS = new Set(['node_modules', '.scratch', 'build', '__pycache__', '.qualification']);
const SKIPPED_PATHS = new Set(['.ia/distributions', '.ia/work']);
const KIT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const TARGET = /^plugins\/([a-z0-9-]+)\/config\/(kits\/[a-z0-9-]+|kit)$/;

export class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BundleError';
    this.code = code;
  }
}

function parseMap(root) {
  const file = join(root, 'kits', 'bundle.json');
  let map;
  try {
    map = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new BundleError('IA-BUNDLE-MAP', `kits/bundle.json cannot be read: ${error.message}`);
  }
  if (map?.format !== 1 || !Array.isArray(map.bundles) || map.bundles.length === 0) {
    throw new BundleError('IA-BUNDLE-MAP', 'kits/bundle.json must be { "format": 1, "bundles": [...] } with at least one bundle');
  }
  const seen = new Set();
  const bundles = map.bundles.map(bundle => {
    const { kit, into } = bundle ?? {};
    if (typeof kit !== 'string' || !KIT_NAME.test(kit)) throw new BundleError('IA-BUNDLE-MAP', `kit ${JSON.stringify(kit)} must match ${KIT_NAME}`);
    if (typeof into !== 'string') throw new BundleError('IA-BUNDLE-MAP', `kit ${kit} needs an "into" path`);
    if (seen.has(into)) throw new BundleError('IA-BUNDLE-MAP', `two kits are bundled into ${into}`);
    seen.add(into);
    if (!existsSync(join(root, 'kits', kit, 'releases.json'))) throw new BundleError('IA-BUNDLE-NOT-KIT', `kits/${kit} has no releases.json`);
    const target = TARGET.exec(into);
    if (!target) throw new BundleError('IA-BUNDLE-TARGET', `${into} must match ${TARGET}`);
    if (!existsSync(join(root, 'plugins', target[1], '.claude-plugin', 'plugin.json'))) throw new BundleError('IA-BUNDLE-TARGET', `plugins/${target[1]} has no .claude-plugin/plugin.json`);
    return { kit, source: `kits/${kit}`, into };
  });
  const rawUnbundled = map.unbundled ?? [];
  if (!Array.isArray(rawUnbundled)) throw new BundleError('IA-BUNDLE-MAP', '"unbundled" must be an array of plugin kit folders');
  const listed = new Set();
  for (const path of rawUnbundled) {
    if (typeof path !== 'string' || !TARGET.test(path)) throw new BundleError('IA-BUNDLE-MAP', `unbundled entry ${JSON.stringify(path)} must match ${TARGET}`);
    if (seen.has(path)) throw new BundleError('IA-BUNDLE-MAP', `${path} is both bundled into and listed under unbundled`);
    if (listed.has(path)) throw new BundleError('IA-BUNDLE-MAP', `${path} is listed twice under unbundled`);
    if (!existsSync(join(root, path))) throw new BundleError('IA-BUNDLE-MAP', `unbundled folder ${path} does not exist`);
    listed.add(path);
  }
  return { bundles, unbundled: [...listed] };
}

export function readBundleMap(root) {
  return parseMap(root).bundles;
}

export function readUnbundled(root) {
  return parseMap(root).unbundled;
}

function refuseAlias(path, shown) {
  if (lstatSync(path).isSymbolicLink()) throw new BundleError('IA-BUNDLE-ALIAS', `${shown} is a symlink or junction`);
}

// Every folder from the repository root down to the path must be a real folder.
function refuseAliasedAncestors(root, path) {
  let folder = root;
  let shown = '';
  for (const part of path.split('/')) {
    folder = join(folder, part);
    shown = shown ? `${shown}/${part}` : part;
    if (!existsSync(folder)) return;
    refuseAlias(folder, shown);
  }
}

export function kitFiles(dir) {
  if (!existsSync(dir)) return [];
  refuseAlias(dir, dir);
  const files = [];
  const walk = (folder, prefix) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const relative = prefix + entry.name;
      refuseAlias(path, relative);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name) && !SKIPPED_PATHS.has(relative)) walk(path, `${relative}/`);
      } else files.push(relative);
    }
  };
  walk(dir, '');
  return files.sort();
}

export function compareBundle(root, entry) {
  refuseAliasedAncestors(root, entry.source);
  refuseAliasedAncestors(root, entry.into);
  const from = join(root, entry.source);
  const to = join(root, entry.into);
  const source = kitFiles(from);
  const target = kitFiles(to);
  const inTarget = new Set(target);
  const inSource = new Set(source);
  return {
    missing: source.filter(p => !inTarget.has(p)),
    extra: target.filter(p => !inSource.has(p)),
    differ: source.filter(p => inTarget.has(p) && !readFileSync(join(from, p)).equals(readFileSync(join(to, p)))),
  };
}

export function writeBundle(root, entry) {
  const from = join(root, entry.source);
  const to = join(root, entry.into);
  const { missing, extra, differ } = compareBundle(root, entry);
  const written = [...missing, ...differ].sort();
  // Remove first, so a case-only rename or a file/folder swap cannot collide.
  for (const p of extra) rmSync(join(to, p));
  for (const p of extra) {
    for (let folder = dirname(join(to, p)); folder !== to && folder.startsWith(to); folder = dirname(folder)) {
      if (!existsSync(folder) || readdirSync(folder).length > 0) break;
      rmdirSync(folder);
    }
  }
  for (const p of written) {
    mkdirSync(dirname(join(to, p)), { recursive: true });
    copyFileSync(join(from, p), join(to, p));
  }
  return { written, removed: extra };
}

// Kits that exist on disk but that the map neither bundles nor lists.
export function findDrift(root, bundles, unbundled) {
  const named = new Set(bundles.map(b => b.kit));
  const generated = new Set([...bundles.map(b => b.into), ...unbundled]);
  const subfolders = folder => (existsSync(folder) ? readdirSync(folder, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : []);
  const lines = [];
  for (const dir of subfolders(join(root, 'kits'))) {
    if (!named.has(dir) && existsSync(join(root, 'kits', dir, 'releases.json'))) lines.push(`kits/${dir} is a kit no bundle entry names; add it to kits/bundle.json`);
  }
  for (const plugin of subfolders(join(root, 'plugins'))) {
    const config = `plugins/${plugin}/config`;
    const candidates = [`${config}/kit`, ...subfolders(join(root, config, 'kits')).map(dir => `${config}/kits/${dir}`)];
    for (const path of candidates) {
      if (!generated.has(path) && existsSync(join(root, path, 'releases.json'))) {
        lines.push(`${path} holds a kit no bundle entry generates; map it in kits/bundle.json, list it under unbundled, or remove it`);
      }
    }
  }
  return lines;
}

const list = names => (names.length ? names.join(' ') : 'none');

export function main(argv, root = new URL('../', import.meta.url), out = text => process.stdout.write(text)) {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root;
  const modes = argv.filter(a => a === '--check' || a === '--write');
  if (argv.length !== 1 || modes.length !== 1) {
    out(USAGE);
    return 2;
  }
  try {
    const { bundles: entries, unbundled } = parseMap(rootPath);
    let status = 0;
    if (argv[0] === '--write') {
      for (const entry of entries) {
        const { written, removed } = writeBundle(rootPath, entry);
        out(`kits/${entry.kit} -> ${entry.into}: wrote ${list(written)}, removed ${list(removed)}\n`);
      }
    } else {
      for (const entry of entries) {
        const { missing, extra, differ } = compareBundle(rootPath, entry);
        if (missing.length + extra.length + differ.length === 0) continue;
        status = 1;
        out(`kits/${entry.kit} -> ${entry.into}: missing ${list(missing)}, extra ${list(extra)}, differ ${list(differ)}\n`);
        out(`kits/${entry.kit} is the source: carry any change made in ${entry.into} over to kits/${entry.kit} first, then run node tools/bundle-kits.mjs --write (it overwrites ${entry.into} and deletes files kits/${entry.kit} lacks)\n`);
      }
    }
    const drift = findDrift(rootPath, entries, unbundled);
    for (const line of drift) out(`${line}\n`);
    if (drift.length > 0) status = 1;
    if (status === 0 && argv[0] === '--check') out(`${entries.length} bundled kit(s) match their sources\n`);
    return status;
  } catch (error) {
    if (!(error instanceof BundleError)) throw error;
    out(`${error.code} ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
