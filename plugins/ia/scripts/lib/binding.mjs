// Bindings: which kit and capability answer an entry point's activity in a
// repository. An interim sidecar, <repo>/.ia/bindings.json, until it is
// lowered to records:
//   { "format": 1,
//     "bindings": { "delivery.probe": { "kit": "inventarch/ia-authoring-kit", "capability": "authoring-probing-the-ia-toolchain" },
//                   "work.*": [ { "kit": "a", "capability": "x" }, { "kit": "b", "capability": "y" } ] },
//     "precedence": ["inventarch/ia-authoring-kit", "inventarch/ia-method-kit"],
//     "defaults": { "knowledge": { "kit": "inventarch/ia-kb-kit", "capability": "kb-knowledge" } } }
// A key is <entry>.<activity>; <entry>.* answers every activity of the entry
// that has no exact key; defaults.<entry> answers when neither does. A key may
// hold one binding or a list of candidates. Several candidates for one key
// are a conflict unless `precedence` (kit ids, first wins) orders them.
// The entry points are Work, Delivery and Knowledge:
// Delivery took Development's place, so a development key or default is
// refused with the name to write instead, never read as another entry.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ENTRIES = ['work', 'delivery', 'knowledge'];
// A retired entry point and the one that took its place.
export const RENAMED = { development: 'delivery' };
export const renamedMessage = entry => `the ${entry} entry point is now ${RENAMED[entry]}: write ${RENAMED[entry]} where ${entry} was written`;

export class BindingError extends Error {
  constructor(message, code, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export const bindingsPath = root => join(root, '.ia', 'bindings.json');

function checkBinding(value, where) {
  if (typeof value !== 'object' || value === null || typeof value.kit !== 'string' || typeof value.capability !== 'string') throw new BindingError(`${where} needs { kit, capability }`, 'IA-CORE-BINDINGS-MALFORMED');
  return { kit: value.kit, capability: value.capability, ...(value.profile ? { profile: value.profile } : {}) };
}

// The parsed sidecar, or null when the repository has none.
export function readBindings(root) {
  const path = bindingsPath(root);
  if (!existsSync(path)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new BindingError(`${path} is not JSON: ${error.message}`, 'IA-CORE-BINDINGS-MALFORMED'); }
  if (parsed.format !== 1 || typeof parsed.bindings !== 'object' || parsed.bindings === null) throw new BindingError(`${path} needs format 1 and a bindings object`, 'IA-CORE-BINDINGS-MALFORMED');
  const bindings = {};
  for (const [key, value] of Object.entries(parsed.bindings)) {
    if (!/^[a-z]+\.(?:[a-z][a-z0-9-]*|\*)$/.test(key)) throw new BindingError(`${path}: key ${key} is not <entry>.<activity>`, 'IA-CORE-BINDINGS-MALFORMED');
    const entry = key.slice(0, key.indexOf('.'));
    if (RENAMED[entry]) throw new BindingError(`${path}: key ${key}: ${renamedMessage(entry)}, so ${RENAMED[entry]}${key.slice(entry.length)}`, 'IA-CORE-BINDINGS-MALFORMED', { key });
    bindings[key] = (Array.isArray(value) ? value : [value]).map((v, i) => checkBinding(v, `${path}: ${key}[${i}]`));
  }
  const precedence = parsed.precedence ?? [];
  if (!Array.isArray(precedence) || !precedence.every(p => typeof p === 'string')) throw new BindingError(`${path}: precedence must be a list of kit ids`, 'IA-CORE-BINDINGS-MALFORMED');
  const defaults = {};
  for (const [entry, value] of Object.entries(parsed.defaults ?? {})) {
    if (RENAMED[entry]) throw new BindingError(`${path}: defaults.${entry}: ${renamedMessage(entry)}, so defaults.${RENAMED[entry]}`, 'IA-CORE-BINDINGS-MALFORMED');
    defaults[entry] = checkBinding(value, `${path}: defaults.${entry}`);
  }
  return { format: 1, path, bindings, precedence, defaults };
}

export function writeBindings(root, data) {
  const path = bindingsPath(root);
  const out = { format: 1, bindings: {}, precedence: data.precedence ?? [], defaults: data.defaults ?? {} };
  for (const [key, list] of Object.entries(data.bindings)) out.bindings[key] = list.length === 1 ? list[0] : list;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  return path;
}

// The one binding for <entry>.<activity>, with how it was chosen:
// { kit, capability, profile?, key, via: "exact"|"wildcard"|"default" }.
export function selectBinding(data, entry, activity) {
  if (RENAMED[entry]) throw new BindingError(renamedMessage(entry), 'IA-CORE-USAGE');
  if (!ENTRIES.includes(entry)) throw new BindingError(`unknown entry point ${entry}; the entry points are ${ENTRIES.join(', ')}`, 'IA-CORE-USAGE');
  const key = `${entry}.${activity}`;
  const none = () => new BindingError(`no method is bound for ${key} in this repository: .ia/bindings.json names no ${key}, no ${entry}.*, and no defaults.${entry}. List the kits with kit.mjs list and bind one with bind.mjs set ${key} <kit> <capability>`, 'IA-CORE-NO-METHOD', { key });
  if (!data) throw none();
  let candidates, via;
  if (data.bindings[key]?.length) { candidates = data.bindings[key]; via = 'exact'; } else if (data.bindings[`${entry}.*`]?.length) { candidates = data.bindings[`${entry}.*`]; via = 'wildcard'; } else if (data.defaults[entry]) { candidates = [data.defaults[entry]]; via = 'default'; } else throw none();
  if (candidates.length === 1) return { ...candidates[0], key, via };
  const ranked = candidates.map(c => ({ c, rank: data.precedence.indexOf(c.kit) })).filter(r => r.rank >= 0).sort((a, b) => a.rank - b.rank);
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0].rank === ranked[1].rank)) {
    throw new BindingError(`${key} is bound to ${candidates.length} methods and precedence does not order them: ${candidates.map(c => `${c.kit}#${c.capability}`).join(', ')}. Run bind.mjs precedence <kit...> to rank the kits, or bind.mjs set ${key} <kit> <capability> to keep one`, 'IA-CORE-CONFLICT', { key, candidates: candidates.map(c => ({ kit: c.kit, capability: c.capability })) });
  }
  return { ...ranked[0].c, key, via: `${via}+precedence` };
}
