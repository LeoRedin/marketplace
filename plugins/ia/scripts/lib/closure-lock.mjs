// Cooperative publication locks. Time never establishes owner death.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalMethod, methodError } from './method-json.mjs';

const fail = message => { throw methodError(message, 'IA-CORE-PIN-CONFLICT'); };
const ownerFor = staging => ({ pid: process.pid, host: hostname(), nonce: randomUUID(), staging });
function directory(path) {
  for (let current = resolve(path);;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Publication lock path is not a regular directory');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function readOwner(path) {
  directory(path);
  const file = join(path, 'owner.json'), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) fail('Publication lock owner is not a bounded regular file');
  const owner = JSON.parse(readFileSync(file, 'utf8'));
  // Earlier pin writers recorded no staging, but their PID/host/nonce still
  // provide the same conservative death proof. They authorize no cleanup.
  if (owner.staging === undefined) owner.staging = [];
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.host !== 'string' || !owner.host || !/^[a-f0-9-]{36}$/.test(owner.nonce ?? '') || !Array.isArray(owner.staging) || owner.staging.length > 32 || owner.staging.some(name => typeof name !== 'string' || !/^\.staging-[a-zA-Z0-9_-]+$/.test(name))) fail('Publication lock owner is incomplete');
  return owner;
}
function dead(owner) {
  if (owner.host !== hostname()) return false;
  try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
function removeOwned(path, owner) {
  const current = readOwner(path);
  if (canonicalMethod(current) !== canonicalMethod(owner)) fail('Publication lock owner changed');
  rmSync(path, { recursive: true });
}

// Recovery is itself exclusive. If its process dies, the same protocol may
// recover that child claim, to a bounded depth. An incomplete child claim is
// deliberately left for operator recovery, never inferred dead from its age.
function recover(path, recovered, depth = 0) {
  if (depth > 4) return false;
  let observed;
  try { observed = readOwner(path); } catch { return false; }
  if (!dead(observed)) return false;
  const claim = join(path, `recovering-${observed.nonce}`), owner = ownerFor([]);
  try {
    mkdirSync(claim);
    writeFileSync(join(claim, 'owner.json'), canonicalMethod(owner), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') recover(claim, recovered, depth + 1);
    return false;
  }
  let moved = false;
  try {
    const current = readOwner(path);
    if (canonicalMethod(current) !== canonicalMethod(observed) || !dead(current)) return false;
    const abandoned = join(dirname(path), `.abandoned-${randomUUID()}`);
    renameSync(path, abandoned);
    moved = true;
    // Only direct sibling staging names in the proven-dead owner's metadata
    // may be cleaned. A moved/published stage is already absent and is kept.
    for (const name of current.staging) {
      const staging = join(dirname(path), name);
      if (!existsSync(staging)) continue;
      const stat = lstatSync(staging);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Dead owner staging path is aliased');
      rmSync(staging, { recursive: true });
    }
    recovered.push({ pid: current.pid, host: current.host, nonce: current.nonce, staging: [...current.staging] });
    rmSync(abandoned, { recursive: true });
    return true;
  } finally { if (!moved) removeOwned(claim, owner); }
}

/** Synchronous bounded lock for existing synchronous pin/publication writers. */
export function acquireClosureLock(lockPath, { timeoutMs = 5000, stagingPaths = [] } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 5000 || !Array.isArray(stagingPaths) || stagingPaths.length > 32) fail('Invalid publication lock bounds');
  const path = resolve(lockPath), parent = dirname(path);
  directory(parent);
  const staging = stagingPaths.map(input => {
    const target = resolve(input), name = basename(target);
    if (dirname(target) !== parent || !/^\.staging-[a-zA-Z0-9_-]+$/.test(name)) fail('Staging cleanup must name direct .staging-* siblings of the lock');
    if (existsSync(target)) directory(target);
    return name;
  });
  if (new Set(staging).size !== staging.length) fail('Duplicate lock staging path');
  const owner = ownerFor(staging.sort()), recovered = [], deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, 'owner.json'), canonicalMethod(owner), { flag: 'wx', mode: 0o600 });
      let released = false;
      return { owner, recovered, release() { if (!released) { removeOwned(path, owner); released = true; } } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (recover(path, recovered)) continue;
      if (Date.now() >= deadline) fail('Publication lock acquisition timed out; ownership was not proven dead');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
}
