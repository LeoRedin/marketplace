#!/usr/bin/env node
// inventarch/ia-repo-kit offline structural layer & dependency-role checker (declared check: check-layers).
// Pure Node built-in ESM, zero external npm dependencies, zero network access, and zero hardcoded tier numbers.
//
// Usage from an IA workspace root (via plugins/ia/scripts/check.mjs):
//   node layer-checker.mjs [--ia] <the command words that run ia...>
// Prints { format, ok, counts, findings } on stdout and exits 0 when ok, 1 when findings exist,
// or 2 (with nothing on stdout) when the workspace is missing, refused by ia validate, or unreadable.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'ia.repo.layer-check.v1';
export const PACKAGE_KINDS = Object.freeze(['host', 'contract', 'core', 'adapter', 'view', 'composition', 'tool']);
const RUNTIME_KINDS = new Set(['host', 'contract', 'core', 'adapter', 'view', 'composition']);
const MAX_BUFFER = 256 * 1024 * 1024;

export function isCanonicalRepoPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('\\') &&
    !/[:\0]/.test(value) &&
    value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

const pathOverlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export function isCredentialFreeLocator(url) {
  if (typeof url !== 'string' || url.trim() !== url || url.length === 0 || /\s/.test(url)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    try {
      const parsed = new URL(url);
      return parsed.username === '' && parsed.password === '' && parsed.hostname.length > 0;
    } catch {
      return false;
    }
  }
  // SCP-like git@host:org/repo(.git) or stable repository alias without user:password@
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(url)) return true;
  return false;
}

function sectionField(record, path) {
  const [section, key] = path.split('.');
  return record.sections?.find(s => s.name === section)?.fields?.find(f => f.key === key)?.value;
}

function scalarText(value) {
  if (!value) return null;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.value === 'number' || typeof value.value === 'string') return String(value.value);
  return null;
}

function numberValue(value) {
  if (!value) return null;
  if (typeof value.value === 'number') return Number.isFinite(value.value) ? value.value : null;
  if (typeof value.text === 'string' && value.text.trim() !== '') {
    const parsed = Number(value.text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function refKey(value) {
  if (!value) return null;
  if (value.kind === 'identity' && typeof value.identity === 'string') return value.identity;
  if (value.kind === 'ref' && value.discriminator && value.name) {
    return `@${value.discriminator} ${String(value.name).toLowerCase()}`;
  }
  return null;
}

function listItems(value) {
  return value?.kind === 'list' && Array.isArray(value.items) ? value.items : [];
}

function buildLookup(records) {
  const byIdentity = new Map();
  const byRef = new Map();
  for (const r of records) {
    byIdentity.set(r.identity, r);
    // Workspace records take precedence over adopted ones at the same @word name, matching IA band resolution.
    const key = `@${r.discriminator} ${String(r.name ?? '').toLowerCase()}`;
    if (!byRef.has(key) || r.provenance === 'workspace') byRef.set(key, r.identity);
  }
  const resolveRef = ref => {
    if (!ref) return null;
    if (typeof ref === 'string') return byIdentity.has(ref) ? ref : (byRef.get(ref.toLowerCase()) ?? null);
    if (ref.target && byIdentity.has(ref.target)) return ref.target;
    const key = refKey(ref.reference ?? ref);
    if (!key) return null;
    return byIdentity.has(key) ? key : (byRef.get(key) ?? null);
  };
  return { byIdentity, resolveRef };
}

function outgoingRequires(record, targetDiscriminator, resolveRef, byIdentity) {
  const targets = [];
  for (const edge of record.edges ?? []) {
    if (edge.predicate !== 'require' || (edge.direction && edge.direction !== 'out')) continue;
    const resolved = resolveRef(edge);
    if (!resolved) continue;
    const targetRecord = byIdentity.get(resolved);
    if (targetRecord?.discriminator === targetDiscriminator) targets.push(resolved);
  }
  return [...new Set(targets)];
}

function detectCycles(graph) {
  const active = new Set();
  const visited = new Set();
  const cyclic = new Set();

  function dfs(node, stack) {
    if (active.has(node)) {
      const idx = stack.indexOf(node);
      for (const member of stack.slice(idx >= 0 ? idx : 0)) cyclic.add(member);
      cyclic.add(node);
      return;
    }
    if (visited.has(node)) return;
    active.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (graph.has(next)) dfs(next, stack);
    }
    stack.pop();
    active.delete(node);
    visited.add(node);
  }

  for (const node of [...graph.keys()].sort()) dfs(node, []);
  return [...cyclic].sort();
}

export function checkLayers(snapshot) {
  const allRecords = snapshot?.records ?? [];
  const { byIdentity, resolveRef } = buildLookup(allRecords);
  const findings = [];
  const report = (code, record, message) => {
    findings.push({
      code,
      record: `@${record.discriminator} ${record.name}`,
      identity: record.identity,
      path: record.source?.path ?? null,
      line: record.source?.line ?? null,
      message,
    });
  };

  const own = disc =>
    allRecords
      .filter(r => r.discriminator === disc && (r.provenance ?? 'workspace') === 'workspace')
      .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));

  const allLayers = allRecords
    .filter(r => r.discriminator === 'layer')
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  const repositories = own('repository');
  const ownLayers = own('layer');
  const packages = own('package');
  const areas = own('area');

  // 1. @repository checks
  for (const repo of repositories) {
    const url = scalarText(sectionField(repo, 'repository.url'));
    if (!isCredentialFreeLocator(url)) {
      report('REPOSITORY_URL', repo, `@repository ${repo.name}: repository.url must be a canonical Git URL or SSH locator without embedded credentials`);
    }
    const org = scalarText(sectionField(repo, 'repository.organisation'));
    const kb = scalarText(sectionField(repo, 'repository.knowledge-base'));
    if (org !== null && org.trim() === '') {
      report('REPOSITORY_ORGANISATION', repo, `@repository ${repo.name}: repository.organisation must not be blank when present`);
    }
    if (kb !== null && kb.trim() === '') {
      report('REPOSITORY_KNOWLEDGE_BASE', repo, `@repository ${repo.name}: repository.knowledge-base must not be blank when present`);
    }
  }

  // 2. @layer rank & path checks (index all layers for rank lookup; report findings on workspace layers + cycles)
  const layerRank = new Map();
  const layerGraph = new Map();
  for (const layer of allLayers) {
    const rank = numberValue(sectionField(layer, 'layer.rank'));
    if (rank === null) {
      if ((layer.provenance ?? 'workspace') === 'workspace') {
        report('LAYER_RANK', layer, `@layer ${layer.name}: layer.rank must be a finite number`);
      }
    } else {
      layerRank.set(layer.identity, rank);
    }
    const deps = outgoingRequires(layer, 'layer', resolveRef, byIdentity);
    layerGraph.set(layer.identity, deps);
    if ((layer.provenance ?? 'workspace') === 'workspace') {
      const paths = listItems(sectionField(layer, 'layer.paths')).map(scalarText);
      for (const p of paths) {
        if (!isCanonicalRepoPath(p)) {
          report('CANONICAL_PATH', layer, `@layer ${layer.name}: layer.paths entry ${JSON.stringify(p)} is not a canonical repository-relative POSIX path`);
        }
      }
    }
  }

  for (const layer of ownLayers) {
    const fromRank = layerRank.get(layer.identity);
    for (const depId of layerGraph.get(layer.identity) ?? []) {
      const toLayer = byIdentity.get(depId);
      const toRank = layerRank.get(depId);
      if (fromRank !== undefined && toRank !== undefined && !(toRank < fromRank)) {
        report(
          'LAYER_RANK_ORDER',
          layer,
          `@layer ${layer.name} (rank ${fromRank}) may require only layers of strictly lower rank, not @layer ${toLayer?.name ?? depId} (rank ${toRank})`,
        );
      }
    }
  }

  for (const cyclicId of detectCycles(layerGraph)) {
    const layer = byIdentity.get(cyclicId);
    if (layer && (layer.provenance ?? 'workspace') === 'workspace') {
      report('LAYER_CYCLE', layer, `@layer ${layer.name} participates in a require cycle`);
    }
  }

  // 3. @package checks: path hygiene, non-overlap per repository scope, package.layer alignment, rank ordering, role purity & cycles
  const packageInfo = new Map();
  const packageGraph = new Map();
  const packagesByScope = new Map();

  for (const pkg of packages) {
    const pkgPath = scalarText(sectionField(pkg, 'package.path'));
    if (!isCanonicalRepoPath(pkgPath)) {
      report('CANONICAL_PATH', pkg, `@package ${pkg.name}: package.path ${JSON.stringify(pkgPath)} is not a canonical repository-relative POSIX path`);
    }
    const repoTarget = resolveRef(sectionField(pkg, 'package.repository')) ?? '__default__';
    if (pkgPath && isCanonicalRepoPath(pkgPath)) {
      const peers = packagesByScope.get(repoTarget) ?? [];
      const clash = peers.find(other => pathOverlaps(pkgPath, other.path));
      if (clash) {
        report('PACKAGE_PATH_OVERLAP', pkg, `@package ${pkg.name} (${pkgPath}) overlaps @package ${clash.name} (${clash.path})`);
      }
      peers.push({ name: pkg.name, path: pkgPath });
      packagesByScope.set(repoTarget, peers);
    }

    const assignedLayerId = resolveRef(sectionField(pkg, 'package.layer'));
    const requiredLayers = outgoingRequires(pkg, 'layer', resolveRef, byIdentity);
    for (const reqLayerId of requiredLayers) {
      if (assignedLayerId && reqLayerId !== assignedLayerId) {
        const reqLayer = byIdentity.get(reqLayerId);
        const assignedLayer = byIdentity.get(assignedLayerId);
        report(
          'PACKAGE_LAYER_MISMATCH',
          pkg,
          `@package ${pkg.name} sets package.layer to @layer ${assignedLayer?.name ?? assignedLayerId} but requires @layer ${reqLayer?.name ?? reqLayerId}`,
        );
      }
    }

    const kind = scalarText(sectionField(pkg, 'package.kind'));
    if (kind !== null && !PACKAGE_KINDS.includes(kind)) {
      report('PACKAGE_KIND_UNKNOWN', pkg, `@package ${pkg.name}: unknown package.kind ${JSON.stringify(kind)}`);
    }

    const rank = assignedLayerId ? layerRank.get(assignedLayerId) : undefined;
    const deps = outgoingRequires(pkg, 'package', resolveRef, byIdentity);
    packageInfo.set(pkg.identity, { record: pkg, layerId: assignedLayerId, rank, kind });
    packageGraph.set(pkg.identity, deps);
  }

  // Also index adopted packages if referenced
  for (const pkg of allRecords.filter(r => r.discriminator === 'package' && !packageInfo.has(r.identity))) {
    const assignedLayerId = resolveRef(sectionField(pkg, 'package.layer'));
    const kind = scalarText(sectionField(pkg, 'package.kind'));
    const rank = assignedLayerId ? layerRank.get(assignedLayerId) : undefined;
    packageInfo.set(pkg.identity, { record: pkg, layerId: assignedLayerId, rank, kind });
    packageGraph.set(pkg.identity, outgoingRequires(pkg, 'package', resolveRef, byIdentity));
  }

  for (const pkg of packages) {
    const from = packageInfo.get(pkg.identity);
    for (const depId of packageGraph.get(pkg.identity) ?? []) {
      const to = packageInfo.get(depId);
      if (!to) continue;
      const toName = `@package ${to.record.name}`;
      if (from.rank !== undefined && to.rank !== undefined && to.rank > from.rank) {
        report(
          'PACKAGE_LAYER_ORDER',
          pkg,
          `@package ${pkg.name} (layer rank ${from.rank}) cannot require higher-ranked ${toName} (layer rank ${to.rank})`,
        );
      }
      if (to.kind === 'host') {
        report('HOST_DEPENDENCY', pkg, `@package ${pkg.name} cannot require deployable host ${toName}`);
      }
      if (from.kind && RUNTIME_KINDS.has(from.kind) && to.kind === 'tool') {
        report('TOOL_DEPENDENCY', pkg, `runtime @package ${pkg.name} (${from.kind}) cannot require tool ${toName}`);
      }
      if (from.kind === 'contract' && to.kind !== null && to.kind !== 'contract') {
        report('CONTRACT_PURITY', pkg, `contract @package ${pkg.name} may require only contract packages, not ${toName} (${to.kind})`);
      }
      if (from.kind === 'core' && to.kind !== null && !['core', 'contract'].includes(to.kind)) {
        report('CORE_PURITY', pkg, `core @package ${pkg.name} may require only core or contract packages, not ${toName} (${to.kind})`);
      }
      if (from.kind === 'composition' && to.kind === 'composition' && from.rank !== undefined && from.rank === to.rank) {
        report('COMPOSITION_ISOLATION', pkg, `composition @package ${pkg.name} cannot require same-rank composition ${toName}`);
      }
    }
  }

  for (const cyclicId of detectCycles(packageGraph)) {
    const pkg = byIdentity.get(cyclicId);
    if (pkg && (pkg.provenance ?? 'workspace') === 'workspace') {
      report('PACKAGE_CYCLE', pkg, `@package ${pkg.name} participates in a require cycle`);
    }
  }

  // 4. @area checks: non-empty area.packages and acyclic require @area graph
  const areaGraph = new Map();
  for (const area of allRecords.filter(r => r.discriminator === 'area')) {
    areaGraph.set(area.identity, outgoingRequires(area, 'area', resolveRef, byIdentity));
  }
  for (const area of areas) {
    const members = listItems(sectionField(area, 'area.packages'));
    if (members.length === 0) {
      report('AREA_EMPTY', area, `@area ${area.name}: area.packages must reference at least one @package`);
    }
  }
  for (const cyclicId of detectCycles(areaGraph)) {
    const area = byIdentity.get(cyclicId);
    if (area && (area.provenance ?? 'workspace') === 'workspace') {
      report('AREA_CYCLE', area, `@area ${area.name} participates in a require cycle`);
    }
  }

  findings.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    format: FORMAT,
    revision: snapshot?.revision ?? null,
    ok: findings.length === 0,
    counts: {
      repositories: repositories.length,
      layers: ownLayers.length,
      packages: packages.length,
      areas: areas.length,
      findings: findings.length,
    },
    findings,
  };
}

// ---------------------------------------------------------------------------
// CLI adapter (runs ia validate + ia records through the resolved CLI)
// ---------------------------------------------------------------------------

const handoffOff = () => ({ ...process.env, IA_NO_HANDOFF: '1' });

function refusal(ran, reply) {
  if (ran.error) return ran.error.message;
  if (typeof reply?.message === 'string') return reply.code && !reply.message.startsWith(reply.code) ? `${reply.code}: ${reply.message}` : reply.message;
  if (reply?.ok === true) return ran.status !== 0 ? `it answered ok but exited ${ran.status}` : 'its answer holds no records';
  return (ran.stderr || ran.stdout || '').trim() || `exit ${ran.status}`;
}

function readAdmission(command, root) {
  const ran = spawnSync(command[0], [...command.slice(1), 'validate', '--root', root, '--severity', 'error', '--json'], {
    cwd: root,
    env: handoffOff(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  let reply;
  try {
    reply = JSON.parse(ran.stdout);
  } catch {
    reply = undefined;
  }
  if (reply?.status === 'admitted') return;
  if (reply?.status === 'refused') {
    const errors = reply.counts?.errors;
    const first = (reply.findings ?? []).find(f => f.severity === 'error');
    const named = first ? `, the first ${first.code}: ${first.message}` : '';
    throw new Error(`ia validate refused the workspace with ${errors} error${errors === 1 ? '' : 's'}${named}; a refused workspace is not judged`);
  }
  throw new Error(`ia validate did not admit the workspace: ${refusal(ran, reply)}`);
}

function readRecords(command, root) {
  const ran = spawnSync(command[0], [...command.slice(1), 'records', '--root', root, '--params', '{}'], {
    cwd: root,
    env: handoffOff(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  let reply;
  try {
    reply = JSON.parse(ran.stdout);
  } catch {
    reply = undefined;
  }
  if (!ran.error && ran.status === 0 && reply?.ok === true && Array.isArray(reply.result?.records)) return reply.result;
  throw new Error(`ia records did not return the admitted records: ${refusal(ran, reply)}`);
}

export function runWorkspaceLayerCheck(rawCommand, root = process.cwd()) {
  const command = rawCommand[0] === '--ia' ? rawCommand.slice(1) : rawCommand;
  if (!command.length) {
    throw new Error('usage: node layer-checker.mjs <the command words that run ia>, from the workspace root');
  }
  if (!existsSync(join(root, '.ia', 'src'))) {
    throw new Error(`${root} is not an IA workspace root (missing .ia/src)`);
  }
  readAdmission(command, root);
  return checkLayers(readRecords(command, root));
}

function samePath(a, b) {
  const [x, y] = [realpathSync.native(a), realpathSync.native(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const report = runWorkspaceLayerCheck(process.argv.slice(2), process.cwd());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`check-layers: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
