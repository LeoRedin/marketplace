import { createHash } from 'node:crypto';

export function methodError(message, code = 'IA-CORE-CLOSURE-INTEGRITY') {
  return Object.assign(new Error(message), { code });
}

// RFC 8785's JSON serialization, restricted to the contract's safe integers.
// Reject values JSON.stringify would silently omit or coerce.
export function canonicalMethod(value) {
  const seen = new Set();
  let nodes = 0;
  function encode(item, depth = 0) {
    if (++nodes > 1000000 || depth > 64) throw methodError('Canonical JSON resource bound exceeded');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') {
      if (!item.isWellFormed()) throw methodError('Ill-formed Unicode in method contract');
      return JSON.stringify(item);
    }
    if (typeof item === 'number' && Number.isSafeInteger(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || seen.has(item)) throw methodError('Method contract is not canonical JSON');
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string') || Object.values(Object.getOwnPropertyDescriptors(item)).some(row => row.get || row.set)) throw methodError('JSON accessors and symbols are unsupported');
    seen.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw methodError('Sparse or extended JSON array');
      result = `[${item.map(value => encode(value, depth + 1)).join(',')}]`;
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Object.getOwnPropertySymbols(item).length) throw methodError('Method contract must contain plain JSON objects');
      result = `{${Object.keys(item).sort().map(key => `${encode(key, depth + 1)}:${encode(item[key], depth + 1)}`).join(',')}}`;
    }
    seen.delete(item);
    return result;
  }
  return encode(value);
}

export const methodDigest = value => createHash('sha256').update(canonicalMethod(value)).digest('hex');
export const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function safeMethodPath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}
