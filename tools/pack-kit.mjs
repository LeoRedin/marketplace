#!/usr/bin/env node
// Maintainer tool: packs one kit (kits/<kit>, the source of truth; run
// node tools/kit.mjs bundle --write afterwards) with an exact IA CLI in a
// temporary copy, and records the release in the kit's format 2 history:
// releases/<version>.json (the record names per system and the binding keys
// the kit offers) and the index row in releases.json (the archive and manifest
// digests, the CLI, the language range, the digest of the sources, the file,
// and the repository and commit the sources were packed from). The catalogue
// ships no archive: adopt packs the same sources and checks this digest.
//   IA_CLI_PATH=<@inventarch/cli dist/main.js> node tools/pack-kit.mjs <kit> [--check | --replace-unpublished]
// (also: node tools/kit.mjs pack ...). <kit> is a kit id or its folder under kits/.
// --check packs and compares with the recorded release without writing.
// A recorded release is never rewritten once published: changed records need
// a new version in the kit's .ia/release.json. Before the first publication
// of a version, --replace-unpublished rewrites that version's entry and file.
// A format 1 releases.json is refused: convert it first (node tools/kit.mjs convert).
// Exit 0 on success, 1 when the sources do not match or a pack fails, 2 on bad usage.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCli } from '../plugins/ia/scripts/lib/cli.mjs';
import { buildKit, findKit, readDescriptor, sourcesDigest } from '../plugins/ia/scripts/lib/kit.mjs';
import { kitRecordNames } from '../plugins/ia/scripts/lib/records.mjs';
import { recordRelease } from '../plugins/ia/scripts/lib/releases.mjs';

export const USAGE = 'usage: IA_CLI_PATH=<@inventarch/cli dist/main.js> node tools/pack-kit.mjs <kit> [--check | --replace-unpublished]\n';

// The binding keys a kit offers: its bindings.json recommend keys, sorted.
export function offeredKeys(kitDir) {
  const path = join(kitDir, 'bindings.json');
  if (!existsSync(path)) return [];
  return Object.keys(JSON.parse(readFileSync(path, 'utf8')).recommend ?? {}).sort();
}

export function packMain(args, { kitsDir = fileURLToPath(new URL('../kits/', import.meta.url)), out = t => process.stdout.write(t), err = t => process.stderr.write(t) } = {}) {
  const flags = args.filter(a => a.startsWith('-'));
  const positional = args.filter(a => !a.startsWith('-'));
  if (positional.length !== 1 || flags.length > 1 || flags.some(f => !['--check', '--replace-unpublished'].includes(f))) { err(USAGE); return 2; }
  if (!process.env.IA_CLI_PATH) { err('set IA_CLI_PATH to an exact @inventarch/cli dist/main.js\n' + USAGE); return 2; }
  const check = flags.includes('--check');
  const replace = flags.includes('--replace-unpublished');
  let built;
  try {
    const kit = findKit(positional[0], kitsDir);
    const releases = JSON.parse(readFileSync(join(kit.dir, 'releases.json'), 'utf8'));
    if (releases.format !== 2) { err(`${kit.id}: releases.json is format 1; run node tools/kit.mjs convert ${kit.dir} first\n`); return 1; }
    const cli = resolveCli(kit.dir);
    built = buildKit(kit, cli);
    const { digest: archive, manifest, version } = built;
    const descriptor = readDescriptor(kit.dir);
    const language = descriptor.dependencies.find(d => d.id === 'inventarch/language');
    const recorded = releases.releases.find(r => r.version === version);
    if (check) {
      if (!recorded || recorded.archive !== archive) {
        err(`${kit.id} ${version} packs to ${archive}, but releases.json records ${recorded?.archive ?? 'nothing'}: records changed without a repack and version bump\n`);
        return 1;
      }
      out(`${kit.id} ${version} packs to the recorded ${archive}\n`);
      return 0;
    }
    if (!replace && recorded && (recorded.archive !== archive || recorded.manifest !== manifest || recorded.cli !== `@inventarch/cli ${cli.version}`)) {
      err(`${kit.id} ${version} is recorded as ${recorded.archive} packed with ${recorded.cli}, and these sources pack to ${archive} with @inventarch/cli ${cli.version}: bump the version in ${kit.folder}/.ia/release.json first\n`);
      return 1;
    }
    const source = descriptor.source?.repository && descriptor.source?.commit ? { repository: descriptor.source.repository, commit: descriptor.source.commit } : undefined;
    const row = { version, archive, manifest, sources: sourcesDigest(kit.dir), language: `${language.id} ${language.range}`, cli: `@inventarch/cli ${cli.version}`, ...(source ? { source } : {}) };
    const records = kitRecordNames(kit.dir);
    recordRelease(kit.dir, row, records, { offers: { keys: offeredKeys(kit.dir) }, replace: replace || Boolean(recorded) });
    out(`${kit.id} ${version}: ${archive} (${records.length} records)\n`);
    return 0;
  } catch (error) {
    if (!error.code) throw error;
    err(`${error.code}: ${error.message}\n`);
    return 1;
  } finally {
    built?.cleanup();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = packMain(process.argv.slice(2));
