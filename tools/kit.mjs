#!/usr/bin/env node
// The maintainer front end for kits (decision public-kit-lookup). The user
// verbs (list, add, bind, upgrade, repin, rebind, check) ship in the core as
// plugins/ia/scripts/kit.mjs; these verbs work on the sources under kits/.
//   node tools/kit.mjs pack <kit> [--check | --replace-unpublished]   pack with IA_CLI_PATH and record the release (tools/pack-kit.mjs)
//   node tools/kit.mjs bundle (--check | --write)                     copy kits/ into the plugins (tools/bundle-kits.mjs)
//   node tools/kit.mjs index (--check | --write)                      kits/index.json from every kit's release index
//   node tools/kit.mjs convert <kit folder> [--check | --expand]      releases.json format 1 -> 2, lossless and verified
//   node tools/kit.mjs package (--check [--built] | --write | --build)   the @inventarch/public-kits package (tools/public-kits.mjs)
// Every write validates first; --check writes nothing. Exit 0 on success, 1 on
// drift or a refusal, 2 on bad usage.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as bundleMain } from './bundle-kits.mjs';
import { offeredKeys, packMain } from './pack-kit.mjs';
import { packageMain } from './public-kits.mjs';
import { readReleases } from '../plugins/ia/scripts/lib/kit.mjs';
import { convertFolder, expandFolder, releaseText } from '../plugins/ia/scripts/lib/releases.mjs';

const USAGE = `usage:
  node tools/kit.mjs pack <kit> [--check | --replace-unpublished]
  node tools/kit.mjs bundle (--check | --write)
  node tools/kit.mjs index (--check | --write)
  node tools/kit.mjs convert <kit folder> [--check | --expand]
  node tools/kit.mjs package (--check [--built] | --write | --build)
`;

// The broadcast: one row per kit under kits/, from its release index alone.
export function buildIndex(root) {
  const kits = join(root, 'kits');
  const rows = readdirSync(kits, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(kits, e.name, 'releases.json'))).map(e => e.name).sort().map(folder => {
    const dir = join(kits, folder);
    const index = readReleases(dir);
    const latest = index.releases.find(r => r.version === (index.latest ?? index.releases.at(-1)?.version)) ?? null;
    return {
      id: index.kit, folder: `kits/${folder}`, releases: `kits/${folder}/releases.json`,
      latest: latest ? { version: latest.version, archive: latest.archive, cli: latest.cli, language: latest.language, file: latest.file ? `kits/${folder}/${latest.file}` : null, source: latest.source ?? null } : null,
      versions: index.releases.map(r => r.version), offers: offeredKeys(dir),
    };
  });
  return { format: 1, kits: rows };
}

export function main(argv, root = fileURLToPath(new URL('../', import.meta.url)), out = t => process.stdout.write(t), err = t => process.stderr.write(t)) {
  const [verb, ...rest] = argv;
  if (verb === 'pack') return packMain(rest, { kitsDir: join(root, 'kits'), out, err });
  if (verb === 'bundle') return bundleMain(rest, root, out);
  if (verb === 'package') return packageMain(rest, root, out, err);
  if (verb === 'index') {
    if (rest.length !== 1 || !['--check', '--write'].includes(rest[0])) { err(USAGE); return 2; }
    const path = join(root, 'kits', 'index.json');
    const text = releaseText(buildIndex(root));
    const current = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : null;
    if (rest[0] === '--write') {
      if (current !== text) writeFileSync(path, text);
      out(`kits/index.json ${current === text ? 'unchanged' : 'written'}\n`);
      return 0;
    }
    if (current !== text) { err('kits/index.json differs from the kits\' release indexes; run node tools/kit.mjs index --write\n'); return 1; }
    out('kits/index.json matches the kits\n');
    return 0;
  }
  if (verb === 'convert') {
    const flags = rest.filter(a => a.startsWith('--')), positional = rest.filter(a => !a.startsWith('--'));
    if (positional.length !== 1 || flags.length > 1 || flags.some(f => !['--check', '--expand'].includes(f))) { err(USAGE); return 2; }
    try {
      if (flags[0] === '--expand') out(releaseText(expandFolder(positional[0])));
      else out(JSON.stringify(convertFolder(positional[0], { check: flags[0] === '--check' })) + '\n');
      return 0;
    } catch (error) {
      if (!error.code && !(error instanceof SyntaxError)) throw error;
      err(`${positional[0]}: ${String(error.message).split('\n')[0]}\n`);
      return 1;
    }
  }
  err(USAGE);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
