import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { methodDigest, methodError } from './method-json.mjs';

// Inventory the private copy used by a check, including lock/source-binding
// metadata. Derived runtime databases and work output are not authored inputs.
export function snapshotInventory(root) {
  const files = []; let total = 0;
  const visit = dir => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = relative(root, path).replace(/\\/g, '/');
      if (['.ia/work', '.ia/.iadb'].includes(rel)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw methodError('Execution snapshot contains an alias');
      if (stat.isDirectory()) { visit(path); continue; }
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || files.length >= 10000 || total + stat.size > 128 * 1024 * 1024) throw methodError('Execution snapshot exceeds resource bounds');
      const bytes = readFileSync(path);
      total += bytes.length;
      if (bytes.length > 16 * 1024 * 1024 || total > 128 * 1024 * 1024) throw methodError('Execution snapshot grew beyond resource bounds');
      files.push({ path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  };
  visit(root);
  return { files, sha256: methodDigest(files) };
}
