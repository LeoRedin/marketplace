import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIa } from './cli.mjs';
import { methodError } from './method-json.mjs';
import { isWholeProcedure, scopeKey } from './workspace.mjs';

const fail = message => { throw methodError(message, 'IA-CORE-COMPOSITION-MISSING'); };
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Only the native runtime decides position membership. It reads a disposable
// offline restoration of retained sources; selected text still comes from the
// retained admitted graph, never the runtime's current plugin installation.
export async function selectMethodPosition({ closure, capability: identity, activityKey, shape, phase, cli, importNative, workspaceIdentity }) {
  const { manifest, graph } = closure;
  const capability = manifest.capabilities.find(row => row.identity === identity);
  if (!capability) fail(`Capability is not retained: ${identity}`);
  const separator = activityKey.indexOf('.');
  if (separator < 1) fail('Method activity key has no entry');
  const entry = activityKey.slice(0, separator), activity = activityKey.slice(separator + 1);
  const scope = scopeKey(entry, activity, { shape, phase });
  const addresses = graph.records.filter(record => capability.playbooks.includes(record.identity)).flatMap(record => record.cells.map(cell => `${record.identity}#${cell.phase}/${cell.primitive}`));
  const all = [...new Set(addresses)].sort(order);
  let whole = isWholeProcedure(entry, activity);
  if (manifest.files.some(row => row.path === 'kit/delivery.json')) {
    const delivery = JSON.parse(readFileSync(join(closure.root, 'kit/delivery.json'), 'utf8'));
    if (delivery.format !== 1 || !Array.isArray(delivery.whole) || delivery.whole.some(name => typeof name !== 'string')) fail('Invalid retained delivery qualification');
    whole ||= delivery.whole.includes(identity.split('/').at(-1));
  }
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'method-position-'));
  try {
    cpSync(join(closure.root, 'kit'), scratch, { recursive: true });
    const cache = join(scratch, '.ia/distributions/cache');
    mkdirSync(cache, { recursive: true });
    copyFileSync(join(closure.root, 'native/language.ia.tgz'), join(cache, `${manifest.native.languageArchiveSha256}.ia.tgz`));
    const restored = runIa(scratch, ['restore', '--offline', '--apply', '--yes'], { cli, timeoutMs: 120000 });
    if (restored.code !== 0) fail('Retained method could not be restored offline for position');
    const { openWorkspaceSession } = await importNative('@inventarch/distribution/services');
    const { position } = await importNative('@inventarch/runtime');
    const session = openWorkspaceSession({ root: scratch, checks: 'structural' });
    try {
      if (session.admission().status !== 'admitted' || session.reader.revision !== graph.revision) fail('Retained method position has different native admission or revision');
      const seat = workspaceIdentity && session.reader.get(workspaceIdentity)?.discriminator === 'workspace' ? workspaceIdentity : undefined;
      const selected = position(session.reader, session.reader.resolveScope().token, { shape: scope.shape, phase: scope.phase, ...(seat ? { seat } : {}) });
      if (!Array.isArray(selected.body?.cells)) fail('Native position did not return a cell selection');
      const own = [...new Set(selected.body.cells.filter(cell => capability.playbooks.includes(cell.playbook)).map(cell => cell.address))].sort(order);
      if (own.some(address => !all.includes(address))) fail('Native position selected a cell absent from retained method');
      const mode = whole ? 'whole-procedure' : own.length ? 'position' : 'empty-position-fallback';
      return { shape: scope.shape, phase: scope.phase, mode, methodRevision: graph.revision, addresses: capability.mode === 'inspection-only' ? [] : mode === 'position' ? own : all };
    } finally { session.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
