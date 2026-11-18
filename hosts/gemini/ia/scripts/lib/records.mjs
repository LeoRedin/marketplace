// A kit's record names as (system, word, name), read from its text sources.
// Each kit's releases.json records them per release, and the check runner
// admits only a check whose name is a @check record here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function kitRecordNames(kitDir) {
  const systems = join(kitDir, '.ia', 'src', 'systems');
  const names = [];
  if (!existsSync(systems)) return names;
  for (const system of readdirSync(systems).sort()) {
    const dir = join(systems, system);
    const records = join(dir, 'records');
    const files = [join(dir, 'system.ia'), ...(existsSync(records) ? readdirSync(records).filter(f => f.endsWith('.ia')).sort().map(f => join(records, f)) : [])].filter(f => existsSync(f));
    for (const file of files) for (const m of readFileSync(file, 'utf8').matchAll(/^@([a-z][a-z-]*) ([a-z0-9][a-z0-9-]*)/gm)) names.push({ system, word: m[1], name: m[2] });
  }
  const key = r => `${r.system}/${r.word}/${r.name}`;
  return names.sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

// The identity a kit record resolves to in the public language: words that
// lower to a fixed owner system and kind. A name that already holds a slash
// is taken as a full identity. Unknown words return undefined.
const PLACEMENTS = {
  capability: 'agent-composition-system/definition/capability/',
  'agent-profile': 'agent-composition-system/binding/agent-profile/',
  playbook: 'governance-system/definition/procedure/',
  convention: 'governance-system/governance/convention/',
  principle: 'governance-system/governance/principle/',
  law: 'governance-system/governance/law/',
  check: 'compliance-system/check/gate/',
  contract: 'compliance-system/contract/signature/',
  mandate: 'agent-system/policy/mandate/',
};

export function identityOf(word, name) {
  if (typeof name === 'string' && name.includes('/')) return name;
  const prefix = PLACEMENTS[word];
  return prefix ? prefix + name : undefined;
}
