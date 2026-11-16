import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalMethod, isDigest, methodError } from './method-json.mjs';
import { acquireClosureLock } from './closure-lock.mjs';

const fail = message => { throw methodError(message, 'IA-CORE-PIN-CONFLICT'); };
const read = path => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024) fail('Pin is not a bounded regular file');
  return readFileSync(path, 'utf8');
};
function validate(pin) {
  if (pin?.format !== 4 || !Number.isSafeInteger(pin.revision) || pin.revision < 1
    || typeof pin.workspace?.identity !== 'string' || !pin.workspace.identity.startsWith('workspace-system/definition/workspace/')
    || !isDigest(pin.workspace.revision) || !pin.kits || Array.isArray(pin.kits) || !pin.keys || Array.isArray(pin.keys)) fail('Not a complete format 4 method pin; explicit rebind is required');
  for (const [id, kit] of Object.entries(pin.kits)) {
    if (kit.id !== id || typeof kit.version !== 'string' || !kit.version || !isDigest(kit.closureSha256)) fail('Invalid pinned kit identity');
  }
  for (const row of Object.values(pin.keys)) {
    if (!row || !Object.hasOwn(pin.kits, row.kit) || typeof row.capability !== 'string' || !row.capability.includes('/') || (row.profile !== null && typeof row.profile !== 'string')) fail('Invalid activity composition in pin');
  }
  canonicalMethod(pin);
  return pin;
}

export function readMethodPin(root, { allowLegacy = false } = {}) {
  const path = join(root, 'binding.json');
  if (!existsSync(path)) return null;
  const pin = JSON.parse(read(path));
  if (allowLegacy && [1, 2, 3].includes(pin.format) && Number.isSafeInteger(pin.revision) && pin.revision > 0) return pin;
  return validate(pin);
}

export function previewMethodRebind(pin, kitId, nextClosureSha256) {
  if (!isDigest(nextClosureSha256)) fail('Invalid closure digest');
  return { priorRevision: pin?.revision ?? null, kitId, closureSha256: nextClosureSha256,
    affectedKeys: Object.entries(pin?.keys ?? {}).filter(([, row]) => row.kit === kitId).map(([key]) => key).sort() };
}

export function writeMethodPin(root, { workspace, kits, keys, task = null }, expectedRevision, { allowLegacyRebind = false } = {}) {
  mkdirSync(root, { recursive: true });
  const staging = join(root, `.staging-binding-${randomUUID()}`);
  const { release } = acquireClosureLock(join(root, '.binding.lock'), { stagingPaths: [staging] }), path = join(root, 'binding.json'), temporary = join(staging, 'next.json');
  try {
    mkdirSync(staging, { mode: 0o700 });
    const bytes = existsSync(path) ? read(path) : null;
    const current = bytes === null ? null : JSON.parse(bytes);
    if ((current?.revision ?? null) !== expectedRevision) fail('Method pin changed; resolve against its current revision');
    if (current && current.format !== 4 && !allowLegacyRebind) fail('Legacy pin requires explicit rebind');
    if (current?.format === 4) validate(current);
    if (current && current.format === 4 && current.workspace.identity !== workspace.identity) fail('Cannot silently change the selected native workspace');
    const pin = validate({ format: 4, revision: (current?.revision ?? 0) + 1, supersedes: current?.revision ?? null,
      workspace, kits, keys, task });
    writeFileSync(temporary, canonicalMethod(pin) + '\n', { flag: 'wx' });
    if (current) {
      const history = join(root, `binding.${current.revision}.json`);
      if (existsSync(history)) {
        if (read(history) !== bytes) fail('Pin history contains different bytes');
      } else {
        const prior = join(staging, 'prior.json');
        writeFileSync(prior, bytes, { flag: 'wx' });
        renameSync(prior, history);
      }
    }
    renameSync(temporary, path);
    return pin;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    release();
  }
}
