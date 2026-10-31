// Kit execution trust (decision public-kit-trust). A kit may run code (a
// handlers.json `run` script, an onwrite.json command, a checks.json command)
// only when both hold:
//   (a) its publisher is on this plugin's list, config/trusted-publishers.json
//       ({ format: 1, publishers: ["inventarch"] }). The publisher is the kit
//       id's namespace (inventarch/<name>-kit); a .ia/release.json `publisher`
//       field, when there is one, must name the same publisher, or the kit is
//       untrusted.
//   (b) its bytes are its recorded release: the sources digest (lib/kit.mjs
//       sourcesDigest, over .ia/, the declared assets and the sidecars) equals
//       the latest release row's `sources`, and .ia/release.json names that
//       release. A kit with no recorded release is untrusted for code.
// Everything else a kit carries stays data: its records, its sidecars and a
// handler entry's `context` text, which the core delivers without running
// anything.
//
// What this is not. The list ships with the plugin and nothing extends it at
// run time: no setting, environment variable or file in the IA home adds a
// publisher, because an agent with a shell can write any of those and so
// could approve itself. The publisher is a claim the kit makes, not a
// signature: whoever can write into the IA home can install a kit that names
// itself inventarch/<name>-kit, and the digest is checked against the release
// the kit's own releases.json records. So (a) keeps other publishers' kits
// from running code, and (b) stops a recorded release whose bytes drifted or
// were edited afterwards; neither stops a deliberate impersonation, and the
// sources digest covers only a kit's entry scripts (declared assets), not every
// module they import. Signed releases close that, at the execution-binding
// release.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { declaredAssets, readDescriptor, sourcesDigest } from './kit.mjs';

export const TRUSTED_PUBLISHERS_FILE = fileURLToPath(new URL('../../config/trusted-publishers.json', import.meta.url));
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const DIGEST = /^[a-f0-9]{64}$/;

// The publishers this plugin trusts to run code. A missing or malformed file
// trusts none (fail closed): every kit's code is then skipped.
export function trustedPublishers(path = TRUSTED_PUBLISHERS_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.format === 1 && Array.isArray(parsed.publishers) && parsed.publishers.every(p => typeof p === 'string' && NAME.test(p))) return [...parsed.publishers];
  } catch { /* unreadable: trust none */ }
  return [];
}

// { publisher, problem }: the kit id's namespace, checked against the
// descriptor's own id and publisher field.
export function publisherOf(kit) {
  const match = /^([a-z0-9][a-z0-9-]*)\/[a-z0-9][a-z0-9.-]*$/.exec(String(kit?.id ?? ''));
  if (!match) return { publisher: null, problem: `its id ${JSON.stringify(kit?.id ?? null)} names no publisher` };
  let descriptor = {};
  try { descriptor = readDescriptor(kit.dir); } catch { return { publisher: match[1], problem: 'it carries no .ia/release.json' }; }
  if (descriptor.id !== undefined && descriptor.id !== kit.id) return { publisher: match[1], problem: `its .ia/release.json id ${descriptor.id} is not its release index's ${kit.id}` };
  if (descriptor.publisher !== undefined && descriptor.publisher !== match[1]) return { publisher: match[1], problem: `its .ia/release.json names publisher ${JSON.stringify(descriptor.publisher)}, not its id's ${match[1]}` };
  return { publisher: match[1], problem: null, descriptor };
}

// Whether one kit may run code: { trusted, publisher, reason }. reason says why
// not, in a phrase that follows "because".
export function kitTrust(kit, { publishers = trustedPublishers() } = {}) {
  const { publisher, problem, descriptor } = publisherOf(kit);
  const no = reason => ({ trusted: false, publisher, reason });
  if (problem) return no(problem);
  if (!publishers.includes(publisher)) return no(`its publisher ${publisher} is not on this plugin's trusted list (config/trusted-publishers.json)`);
  const latest = kit.latest;
  if (!latest || !DIGEST.test(latest.sources ?? '')) return no('it records no release with a sources digest');
  if (descriptor.version !== latest.version) return no(`its .ia/release.json is version ${descriptor.version}, not its latest release ${latest.version}`);
  let digest;
  try { digest = sourcesDigest(kit.dir); } catch (error) { return no(`its sources cannot be digested: ${error.message}`); }
  if (digest !== latest.sources) return no(`its bytes are not its recorded release ${latest.version} (the sources digest differs)`);
  return { trusted: true, publisher, reason: null };
}

// Is a kit-relative script one of the kit's declared assets, so its recorded
// sources digest covers it? A handler's `run` script must be.
export function coversScript(kit, rel) {
  try { return declaredAssets(kit.dir).some(a => a.rel === rel); } catch { return false; }
}

// The one short note for an untrusted kit whose code was skipped.
export function trustNote(kit, trust, what = 'its code') {
  return `${kit.id}: ${what} did not run, because ${trust.reason}. Only kits from a trusted publisher whose bytes are their recorded release run code; this kit's data-only handler context still applies (decision public-kit-trust).`;
}
