#!/usr/bin/env node
// inventarch/ia-product-base-kit offline PRD completeness & traceability checker (declared check: check-prds).
// Pure Node built-in ESM, zero external npm dependencies, and zero network access.
//
// Usage from an IA workspace root (via plugins/ia/scripts/check.mjs):
//   node check-prds.mjs [--ia] <the command words that run ia...>
// Prints { format, revision, ok, counts, findings } on stdout and exits 0 when ok, 1 when findings exist,
// or 2 (with nothing on stdout) when the workspace is missing, refused by ia validate, or unreadable.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'ia.product.prd-check.v1';
const MAX_BUFFER = 256 * 1024 * 1024;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const CLAUSE_PREFIX_RE = /^([A-Za-z][A-Za-z0-9_-]*-\d+)\s*:/;
const ENFORCED_STATUSES = new Set(['ratified', 'active']);

export function isValidPrdSource(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || /\s/.test(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.username === '' && parsed.password === '' && parsed.hostname.length > 0;
    } catch {
      return false;
    }
  }
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\') || /[:@\0]/.test(value)) return false;
  return value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
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

function listItems(value) {
  return value?.kind === 'list' && Array.isArray(value.items) ? value.items : [];
}

function refKey(value) {
  if (!value) return null;
  if (value.kind === 'identity' && typeof value.identity === 'string') return value.identity;
  if (value.kind === 'ref' && value.discriminator && value.name) {
    return `@${value.discriminator} ${String(value.name).toLowerCase()}`;
  }
  return null;
}

function buildLookup(records) {
  const byIdentity = new Map();
  const byRef = new Map();
  for (const r of records) {
    byIdentity.set(r.identity, r);
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

export function checkPrds(snapshot) {
  const allRecords = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const { byIdentity, resolveRef } = buildLookup(allRecords);
  const findings = [];

  const report = (code, record, message) => {
    findings.push({
      code,
      severity: 'error',
      discriminator: record.discriminator,
      identity: record.identity,
      name: record.name ?? null,
      file: record.origin?.file ?? null,
      line: record.origin?.line ?? null,
      message,
    });
  };

  const own = allRecords.filter(r => (r.provenance ?? 'workspace') === 'workspace');
  const prds = own.filter(r => r.discriminator === 'prd');
  const specs = allRecords.filter(r => r.discriminator === 'spec');
  const decisions = allRecords.filter(r => r.discriminator === 'decision');
  const approvals = allRecords.filter(r => r.discriminator === 'approval');
  const approvalRules = own.filter(r => r.discriminator === 'approval-rule');

  // Collect incoming traces from @spec and @decision records pointing at @prd records
  const incomingTraceByPrd = new Map();
  for (const rec of [...specs, ...decisions]) {
    for (const edge of rec.edges ?? []) {
      if (edge.direction && edge.direction !== 'out') continue;
      if (!['cite', 'ground', 'require', 'record-lineage-from'].includes(edge.predicate)) continue;
      const targetId = resolveRef(edge);
      if (targetId && byIdentity.get(targetId)?.discriminator === 'prd') {
        if (!incomingTraceByPrd.has(targetId)) incomingTraceByPrd.set(targetId, new Set());
        incomingTraceByPrd.get(targetId).add(rec.identity);
      }
    }
  }

  // Seal lookup when an @approval-rule covers 'prd' (or 'definition')
  const prdRuleActive = approvalRules.some(rule => {
    const words = listItems(sectionField(rule, 'demand.words')).map(scalarText);
    const kinds = listItems(sectionField(rule, 'demand.kinds')).map(scalarText);
    return words.includes('prd') || kinds.includes('definition');
  });
  const approvedPrds = new Map();
  for (const app of approvals) {
    if (scalarText(sectionField(app, 'seal.action')) !== 'approve') continue;
    const recId = scalarText(sectionField(app, 'seal.record'));
    const recDigest = scalarText(sectionField(app, 'seal.record-digest'));
    if (recId) {
      if (!approvedPrds.has(recId)) approvedPrds.set(recId, []);
      approvedPrds.get(recId).push(recDigest);
    }
  }

  const supersedeGraph = new Map();
  for (const p of allRecords.filter(r => r.discriminator === 'prd')) {
    const targets = [];
    for (const edge of p.edges ?? []) {
      if (edge.predicate !== 'supersede' || (edge.direction && edge.direction !== 'out')) continue;
      const resolved = resolveRef(edge);
      if (resolved && byIdentity.get(resolved)?.discriminator === 'prd') targets.push(resolved);
    }
    supersedeGraph.set(p.identity, [...new Set(targets)]);
  }

  for (const prd of prds) {
    const problem = scalarText(sectionField(prd, 'meaning.problem')) ?? '';
    const goalsRaw = listItems(sectionField(prd, 'scope.goals')).map(scalarText);
    const nonGoalsRaw = listItems(sectionField(prd, 'scope.non-goals')).map(scalarText);
    const reqsRaw = listItems(sectionField(prd, 'scope.requirements')).map(scalarText);
    const status = scalarText(sectionField(prd, 'governance.status')) ?? 'draft';
    const source = scalarText(sectionField(prd, 'governance.source'));
    const bodyDigest = scalarText(sectionField(prd, 'governance.body-digest'));

    if (!problem.trim()) {
      report('PRD_PROBLEM_EMPTY', prd, `@prd ${prd.name}: meaning.problem must be non-empty`);
    }

    for (const [fieldName, entries] of [
      ['scope.goals', goalsRaw],
      ['scope.non-goals', nonGoalsRaw],
      ['scope.requirements', reqsRaw],
    ]) {
      if (entries.some(entry => typeof entry !== 'string' || !entry.trim())) {
        report('PRD_BLANK_ENTRY', prd, `@prd ${prd.name}: ${fieldName} must not contain blank strings`);
      }
    }

    const goals = goalsRaw.filter(g => typeof g === 'string' && g.trim().length > 0);
    const reqs = reqsRaw.filter(r => typeof r === 'string' && r.trim().length > 0);

    const seenClauseIds = new Set();
    for (const req of reqs) {
      const m = CLAUSE_PREFIX_RE.exec(req.trim());
      if (m) {
        const clauseId = m[1].toUpperCase();
        if (seenClauseIds.has(clauseId)) {
          report('PRD_REQUIREMENT_DUPLICATE_ID', prd, `@prd ${prd.name}: duplicate requirement clause identifier '${clauseId}'`);
        }
        seenClauseIds.add(clauseId);
      }
    }

    if (source !== null && !isValidPrdSource(source)) {
      report(
        'PRD_SOURCE_INVALID',
        prd,
        `@prd ${prd.name}: governance.source ${JSON.stringify(source)} must be a credential-free, traversal-free path or URL`,
      );
    }

    if (bodyDigest !== null) {
      if (!HEX_64_RE.test(bodyDigest)) {
        report('PRD_BODY_DIGEST_FORMAT', prd, `@prd ${prd.name}: governance.body-digest must be 64 lowercase hex characters`);
      }
      if (source === null) {
        report('PRD_DIGEST_WITHOUT_SOURCE', prd, `@prd ${prd.name}: governance.body-digest requires governance.source to be set`);
      }
    }

    if (ENFORCED_STATUSES.has(status)) {
      if (goals.length === 0) {
        report('PRD_GOALS_EMPTY', prd, `@prd ${prd.name} (${status}): scope.goals must list at least one measurable goal`);
      }
      if (reqs.length === 0) {
        report('PRD_REQUIREMENTS_EMPTY', prd, `@prd ${prd.name} (${status}): scope.requirements must list at least one requirement clause`);
      }

      // Collect outgoing + incoming traced @spec and @decision records
      const tracedIds = new Set(incomingTraceByPrd.get(prd.identity) ?? []);
      for (const edge of prd.edges ?? []) {
        if (edge.direction && edge.direction !== 'out') continue;
        if (!['cite', 'ground', 'require'].includes(edge.predicate)) continue;
        const targetId = resolveRef(edge);
        const targetRec = targetId ? byIdentity.get(targetId) : null;
        if (targetRec && ['spec', 'decision'].includes(targetRec.discriminator)) {
          tracedIds.add(targetRec.identity);
        }
      }

      if (tracedIds.size === 0) {
        report(
          'PRD_UNTRACED_COVERAGE',
          prd,
          `@prd ${prd.name} (${status}) has no resolved traceability relationship to or from an admitted @spec or @decision`,
        );
      } else {
        const tracedRecords = [...tracedIds].map(id => byIdentity.get(id)).filter(Boolean);
        const activeTraces = tracedRecords.filter(r => scalarText(sectionField(r, 'work.status')) !== 'withdrawn');
        if (activeTraces.length === 0) {
          report(
            'PRD_TRACE_WITHDRAWN',
            prd,
            `@prd ${prd.name} (${status}) traces only to withdrawn @spec/@decision records`,
          );
        }
      }

      if (prdRuleActive) {
        const digests = approvedPrds.get(prd.identity) ?? [];
        const validSeal =
          digests.length > 0 && (typeof prd.digest !== 'string' || prd.digest.length !== 64 || digests.includes(prd.digest));
        if (!validSeal) {
          report('PRD_UNSEALED', prd, `@prd ${prd.name} (${status}) requires a matching @approval seal under the workspace's approval rules`);
        }
      }
    }
  }

  for (const cyclicId of detectCycles(supersedeGraph)) {
    const prd = byIdentity.get(cyclicId);
    if (prd && (prd.provenance ?? 'workspace') === 'workspace') {
      report('PRD_SUPERSEDE_CYCLE', prd, `@prd ${prd.name} participates in a supersede cycle`);
    }
  }

  findings.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    format: FORMAT,
    revision: snapshot?.revision ?? null,
    ok: findings.length === 0,
    counts: {
      prds: prds.length,
      specs: specs.length,
      decisions: decisions.length,
      findings: findings.length,
    },
    findings,
  };
}

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

export function runWorkspacePrdCheck(rawCommand, root = process.cwd()) {
  const command = rawCommand[0] === '--ia' ? rawCommand.slice(1) : rawCommand;
  if (!command.length) {
    throw new Error('usage: node check-prds.mjs <the command words that run ia>, from the workspace root');
  }
  if (!existsSync(join(root, '.ia', 'src'))) {
    throw new Error(`${root} is not an IA workspace root (missing .ia/src)`);
  }
  readAdmission(command, root);
  return checkPrds(readRecords(command, root));
}

function samePath(a, b) {
  const [x, y] = [realpathSync.native(a), realpathSync.native(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const report = runWorkspacePrdCheck(process.argv.slice(2), process.cwd());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`check-prds: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
