// Qualification and unit tests for inventarch/ia-product-base-kit (product-base-system 0.1.0).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adopt, findKit, sourcesDigest } from '../scripts/lib/kit.mjs';
import { kitRecordNames } from '../scripts/lib/records.mjs';
import { expandFolder } from '../scripts/lib/releases.mjs';
import { FORMAT, checkPrds, isValidPrdSource } from '../config/kits/ia-product-base/scripts/check-prds.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const KIT = join(PLUGIN, 'config', 'kits', 'ia-product-base');
const SOURCE_KIT = join(REPO_ROOT, 'kits', 'ia-product-base');
const KIT_ID = 'inventarch/ia-product-base-kit';
const SYSTEM = 'product-base-system';
const REPO_CLI = join(REPO_ROOT, 'node_modules', '@inventarch', 'cli', 'dist', 'main.js');
const CLI = process.env.IA_CORE_TEST_CLI ?? (existsSync(REPO_CLI) ? REPO_CLI : null);
const SKIP_CLI = !CLI && 'install @inventarch/cli or set IA_CORE_TEST_CLI';

const ROLES = ['documentation', 'asset'];

const walk = dir =>
  readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

function parseRecords(kitDir = KIT) {
  const srcRoot = join(kitDir, '.ia', 'src');
  const records = [];
  for (const file of walk(srcRoot).filter(f => f.endsWith('.ia')).sort()) {
    const rel = relative(srcRoot, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith('#! ia 1.0\n'), `${rel}: native header`);
    for (const block of text.split(/^(?=@)/m).filter(b => b.startsWith('@'))) {
      const lines = block.trimEnd().split('\n');
      const [, word, name] = /^@([a-z-]+)\s+([a-z0-9-]+)$/.exec(lines[0]) ?? [];
      assert.ok(word && name, `${rel}: malformed header ${lines[0]}`);
      records.push({ file: rel, word, name, body: lines.slice(1) });
    }
  }
  return records;
}

function sectionField(record, section, key) {
  let inSection = false;
  for (const line of record.body) {
    if (/^  [a-z-]+$/.test(line)) inSection = line.trim() === section;
    else if (inSection) {
      const m = new RegExp(`^    ${key} (.*)$`).exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

const unquote = v => (typeof v === 'string' && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

function checksProblems(records, checks) {
  const problems = [];
  if (checks.format !== 1) problems.push('checks.json: format must be 1');
  const declared = Object.fromEntries(records.filter(r => r.word === 'check').map(r => [r.name, unquote(sectionField(r, 'check', 'scope'))]));
  for (const [name, spec] of Object.entries(checks.checks ?? {})) {
    if (!(name in declared)) {
      problems.push(`${name}: not a @check record`);
      continue;
    }
    if (name === `${SYSTEM}-coverage`) problems.push(`${name}: coverage check is evaluated by IA`);
    if (!Array.isArray(spec.argv) || !spec.argv.length || !spec.argv.every(a => typeof a === 'string' && a.length)) {
      problems.push(`${name}: argv`);
      continue;
    }
    if (!['workspace', 'kit', 'plugin'].includes(spec.cwd ?? 'workspace')) problems.push(`${name}: cwd`);
    const command = spec.argv.map(a => ({ '${NODE}': 'node', '${IA}': 'ia' })[a] ?? a).join(' ');
    if (command !== declared[name]) problems.push(`${name}: argv ${command} differs from check.scope ${declared[name]}`);
  }
  const gates = Object.keys(declared).filter(n => n !== `${SYSTEM}-coverage`).sort();
  if (JSON.stringify(Object.keys(checks.checks ?? {}).sort()) !== JSON.stringify(gates)) {
    problems.push(`checks.json must name exactly ${gates.join(', ')}`);
  }
  for (const gate of gates) {
    if (!declared[gate]) problems.push(`${gate}: empty check.scope`);
  }
  return problems;
}

function assetProblems(root = KIT) {
  const descriptor = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8'));
  const problems = [];
  for (const asset of descriptor.assets) {
    const full = join(root, asset.path);
    if (!ROLES.includes(asset.role)) problems.push(`${asset.path}: invalid role ${asset.role}`);
    if (!existsSync(full)) {
      problems.push(`${asset.path}: missing`);
      continue;
    }
    if (asset.path.endsWith('.md') && asset.role !== 'documentation') problems.push(`${asset.path}: expected documentation role`);
    if (!asset.path.endsWith('.md') && asset.role !== 'asset') problems.push(`${asset.path}: expected asset role`);
  }
  const shipped = ['assets', 'scripts']
    .filter(d => existsSync(join(root, d)))
    .flatMap(d => walk(join(root, d)))
    .map(f => relative(root, f).replace(/\\/g, '/'));
  for (const rel of shipped) {
    if (!descriptor.assets.some(a => a.path === rel)) problems.push(`${rel}: shipped but not listed in release.json`);
  }
  if (existsSync(join(root, 'checks.json')) && !descriptor.assets.some(a => a.path === 'checks.json')) {
    problems.push('checks.json: missing from release.json assets');
  }
  return problems;
}

function releaseProblems(root = KIT) {
  const descriptor = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8'));
  const index = JSON.parse(readFileSync(join(root, 'releases.json'), 'utf8'));
  const problems = [];
  if (index.format !== 2) problems.push('releases.json: expected format 2');
  if (index.kit !== descriptor.id) problems.push(`releases.json kit ${index.kit} !== ${descriptor.id}`);
  const expanded = expandFolder(root);
  const recorded = expanded.releases.find(r => r.version === descriptor.version);
  if (!recorded) {
    problems.push(`releases.json records no release ${descriptor.version}`);
    return problems;
  }
  if (recorded.sources !== sourcesDigest(root)) problems.push('sources digest mismatch');
  if (JSON.stringify(recorded.records) !== JSON.stringify(kitRecordNames(root))) problems.push('recorded records mismatch');
  return problems;
}

// Synthetic ia-records builders for unit testing checkPrds
const strVal = text => ({ kind: 'string', text });
const refVal = (discriminator, name) => ({ kind: 'ref', discriminator, name });
const listVal = items => ({ kind: 'list', items });

function synSpec(name, status = 'accepted', citesPrds = []) {
  return {
    identity: `work-system/contract/spec/${name}`,
    discriminator: 'spec',
    name,
    provenance: 'workspace',
    sections: [{ name: 'work', fields: [{ key: 'status', value: strVal(status) }] }],
    edges: citesPrds.map(p => ({ predicate: 'cite', direction: 'out', reference: refVal('prd', p) })),
  };
}

function synDecision(name, status = 'made', citesPrds = []) {
  return {
    identity: `work-system/definition/decision/${name}`,
    discriminator: 'decision',
    name,
    provenance: 'workspace',
    sections: [{ name: 'work', fields: [{ key: 'status', value: strVal(status) }] }],
    edges: citesPrds.map(p => ({ predicate: 'cite', direction: 'out', reference: refVal('prd', p) })),
  };
}

function synPrd(name, opts = {}) {
  const govFields = [{ key: 'status', value: strVal(opts.status ?? 'draft') }];
  if (opts.source !== undefined) govFields.push({ key: 'source', value: strVal(opts.source) });
  if (opts.bodyDigest !== undefined) govFields.push({ key: 'body-digest', value: strVal(opts.bodyDigest) });

  const edges = [];
  for (const s of opts.groundsSpecs ?? []) edges.push({ predicate: 'ground', direction: 'out', reference: refVal('spec', s) });
  for (const d of opts.citesDecisions ?? []) edges.push({ predicate: 'cite', direction: 'out', reference: refVal('decision', d) });
  for (const p of opts.supersedes ?? []) edges.push({ predicate: 'supersede', direction: 'out', reference: refVal('prd', p) });

  return {
    identity: `product-base-system/definition/prd/${name}`,
    discriminator: 'prd',
    name,
    digest: opts.digest ?? 'd'.repeat(64),
    provenance: 'workspace',
    sections: [
      {
        name: 'meaning',
        fields: [
          { key: 'says', value: strVal(`PRD ${name}.`) },
          { key: 'problem', value: strVal(opts.problem ?? 'Users lack deterministic offline audit trails.') },
        ],
      },
      {
        name: 'scope',
        fields: [
          { key: 'goals', value: listVal((opts.goals ?? ['Verify records offline']).map(strVal)) },
          { key: 'non-goals', value: listVal((opts.nonGoals ?? ['Live external sync']).map(strVal)) },
          { key: 'requirements', value: listVal((opts.requirements ?? ['REQ-01: Emit deterministic JSON report']).map(strVal)) },
        ],
      },
      { name: 'governance', fields: govFields },
    ],
    edges,
  };
}

function synApprovalRule(name, words) {
  return {
    identity: `approval-system/governance/approval-rule/${name}`,
    discriminator: 'approval-rule',
    name,
    provenance: 'workspace',
    sections: [{ name: 'demand', fields: [{ key: 'words', value: listVal(words.map(strVal)) }] }],
    edges: [],
  };
}

function synApproval(name, targetIdentity, targetDigest) {
  return {
    identity: `approval-system/definition/approval/${name}`,
    discriminator: 'approval',
    name,
    provenance: 'workspace',
    sections: [
      {
        name: 'seal',
        fields: [
          { key: 'action', value: strVal('approve') },
          { key: 'record', value: strVal(targetIdentity) },
          { key: 'record-digest', value: strVal(targetDigest) },
        ],
      },
    ],
    edges: [],
  };
}

test('REQ-PRODUCT-BASE-01 success: the kit admits offline with steward hygiene, schema and PRD rules', { skip: SKIP_CLI }, t => {
  const records = parseRecords(KIT);
  const byWord = word => records.filter(r => r.word === word).map(r => r.name).sort();
  assert.deepEqual(byWord('schema'), ['prd']);
  assert.ok(records.some(r => r.word === 'agent' && r.name === 'product-base-system-steward'));
  assert.ok(records.some(r => r.word === 'mandate' && r.name === 'product-base-system-stewardship'));
  assert.deepEqual(byWord('law'), ['product-prd-source-and-supersession-hygiene', 'product-ratified-prd-completeness-and-traceability']);
  assert.deepEqual(byWord('convention'), ['product-guide-prd', 'product-prd-body-pinning', 'product-prd-decomposition-boundary']);

  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-product-base-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const copy = join(base, 'kit');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  cpSync(SOURCE_KIT, copy, { recursive: true });

  const restore = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', copy, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(restore.status, 0, restore.stdout + restore.stderr);

  const validate = spawnSync(process.execPath, [CLI, 'validate', '--root', copy, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  const parsed = JSON.parse(validate.stdout);
  assert.equal(parsed.status, 'admitted');
  assert.equal(parsed.counts.errors, 0);
});

test('REQ-PRODUCT-BASE-01 failure: an unknown evaluator is refused', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-product-base-bad-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const copy = join(base, 'kit');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  cpSync(SOURCE_KIT, copy, { recursive: true });
  const comp = join(copy, '.ia', 'src', 'systems', SYSTEM, 'records', 'compliance.ia');
  writeFileSync(
    comp,
    readFileSync(comp, 'utf8').replace('    runs COMP-CHECK\n    scope "ia validate --json"', '    runs UNKNOWN-EVAL\n    scope "ia validate --json"'),
  );

  const restore = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', copy, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(restore.status, 0);
  assert.match(restore.stdout + restore.stderr, /IA-COMP-CHECK-UNKNOWN/);
});

test('REQ-PRODUCT-BASE-02 success: checks, assets and format 2 release metadata match', () => {
  const records = parseRecords(KIT);
  const checks = JSON.parse(readFileSync(join(KIT, 'checks.json'), 'utf8'));
  assert.deepEqual(checksProblems(records, checks), []);
  assert.deepEqual(assetProblems(KIT), []);
  assert.deepEqual(releaseProblems(KIT), []);
});

test('REQ-PRODUCT-BASE-02 failure: drifted checks, assets and releases are refused', t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-product-base-drift-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const copyChecks = join(base, 'checks');
  cpSync(KIT, copyChecks, { recursive: true });
  const comp = join(copyChecks, '.ia', 'src', 'systems', SYSTEM, 'records', 'compliance.ia');
  writeFileSync(comp, readFileSync(comp, 'utf8').replace('scope "ia validate --json"', 'scope ""'));
  assert.ok(checksProblems(parseRecords(copyChecks), JSON.parse(readFileSync(join(copyChecks, 'checks.json'), 'utf8'))).length > 0);

  const copyAssets = join(base, 'assets');
  cpSync(KIT, copyAssets, { recursive: true });
  rmSync(join(copyAssets, 'assets', 'product-vocabulary.md'));
  assert.ok(assetProblems(copyAssets).some(p => p.includes('missing')));

  const copyRelease = join(base, 'release');
  cpSync(KIT, copyRelease, { recursive: true });
  writeFileSync(join(copyRelease, 'assets', 'product-vocabulary.md'), '# drifted\n');
  assert.ok(releaseProblems(copyRelease).some(p => p.includes('sources digest mismatch')));
});

test('REQ-PRODUCT-BASE-03 success: consented relationships to spec, decision, plan, docket and approval validate', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-product-consent-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-product-base'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  adopt(ws, findKit('ia-approval'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system approval-system, @system product-base-system]'));

  writeFileSync(
    join(ws, '.ia', 'src', 'product.ia'),
    `#! ia 1.0

@prd audit-v1
  meaning
    says "Initial audit PRD."
    problem "No baseline audit record."
  scope
    goals ["Record audit events"]
    non-goals ["External SIEM"]
    requirements ["AUD-01: Emit audit events"]
  governance
    status superseded

@decision audit-retention
  meaning
    says "Retain audit events for 90 days."
  work
    title "Audit retention"
    status made
  decision
    question "How long are audit events retained?"
    options ["30 days", "90 days"]
    decider "Product Lead"
    choice "90 days"
    rationale "Balances compliance and storage."

@spec audit-spec
  meaning
    says "Technical specification for audit events."
  work
    title "Audit specification"
    status accepted
  relationships
    cites @prd audit-v2

@plan audit-rollout
  meaning
    says "Rollout plan for audit v2."
  work
    title "Audit rollout"
    status open

@docket intake-audit
  meaning
    says "Intake docket for audit v2."
    answers "How did audit-v2 arrive?"
  docket
    producer "desk"
    pieces ["product-base-system/definition/prd/audit-v2 none wiki https%3A%2F%2Fexample.org%2Fprd ${'0'.repeat(64)} -"]

@approval seal-audit-v2
  meaning
    says "Placeholder schema-valid seal."
    answers "Which approval record cites audit-v2?"
  seal
    action approve
    organisation "workspace-system/definition/workspace/acme"
    workspace "workspace-system/definition/workspace/acme-product"
    record "product-base-system/definition/prd/audit-v2"
    record-digest "${'a'.repeat(64)}"
    depends-on []
    rules []
    revision "${'b'.repeat(64)}"
    language-version "3.2.0"
    system-versions ["product-base-system 0.1.0"]
    base-commit "${'c'.repeat(40)}"
    signer "acct-lead"
    key-id "kid-1"
    key-kind service-held
    via desk
    request "req-1"
    signed-at "2026-11-18T00:00:00Z"
    algorithm ed25519
    signature "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

@prd audit-v2
  meaning
    says "Second-generation audit PRD."
    title "Audit v2"
    problem "Operators need tamper-evident audit exports."
  scope
    goals ["Provide offline verifiable exports"]
    non-goals ["Real-time streaming"]
    requirements ["AUD-01: Export canonical JSON", "AUD-02: Verify SHA-256 digests"]
  governance
    status ratified
    owner "Platform Product"
    source "docs/prd/audit-v2.md"
    body-digest "${'e'.repeat(64)}"
  relationships
    supersedes @prd audit-v1
    grounds @spec audit-spec
    grounds @plan audit-rollout
    requires @decision audit-retention
    cites @docket intake-audit
    cites @approval seal-audit-v2
`,
  );

  const val = spawnSync(process.execPath, [CLI, 'validate', '--root', ws, '--json'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(val.status, 0, val.stdout + val.stderr);
  assert.equal(JSON.parse(val.stdout).counts.errors, 0);
});

test('REQ-PRODUCT-BASE-03 failure: unconsented edges, cardinality breaches and invalid statuses are refused', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-product-consent-bad-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // 1. Invalid governance.status and multiple supersede targets
  const copyCard = join(base, 'card');
  cpSync(SOURCE_KIT, copyCard, { recursive: true });
  writeFileSync(
    join(copyCard, '.ia', 'src', 'bad-prd.ia'),
    `#! ia 1.0

@prd old-1
  meaning
    says "Old 1."
    problem "P1"
  scope
    goals []
    non-goals []
    requirements []
  governance
    status superseded

@prd old-2
  meaning
    says "Old 2."
    problem "P2"
  scope
    goals []
    non-goals []
    requirements []
  governance
    status superseded

@prd bad-prd
  meaning
    says "Supersedes two PRDs with bad status."
    problem "P3"
  scope
    goals []
    non-goals []
    requirements []
  governance
    status unknown-status
  relationships
    supersedes @prd old-1
    supersedes @prd old-2
`,
  );
  const resCard = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', copyCard, '--json'], {
    env: { ...process.env, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  const valCard =
    resCard.status === 0
      ? spawnSync(process.execPath, [CLI, 'validate', '--root', copyCard, '--json'], {
          env: { ...process.env, IA_NO_HANDOFF: '1' },
          encoding: 'utf8',
          windowsHide: true,
        })
      : { stdout: '', stderr: '' };
  const combinedCard = resCard.stdout + resCard.stderr + valCard.stdout + valCard.stderr;
  assert.match(combinedCard, /IA-COMP-FIELD-VALUE/);
  assert.match(combinedCard, /IA-COMP-EDGE-CARDINALITY/);

  // 2. Splicing out ground consent refuses @prd grounding @spec
  const copyEdge = join(base, 'edge');
  cpSync(SOURCE_KIT, copyEdge, { recursive: true });
  const sysPath = join(copyEdge, '.ia', 'src', 'systems', SYSTEM, 'system.ia');
  writeFileSync(sysPath, readFileSync(sysPath, 'utf8').replace('    ground spec, plan, milestone, task using prd\n', ''));
  writeFileSync(
    join(copyEdge, '.ia', 'src', 'unconsented.ia'),
    `#! ia 1.0

@spec s1
  meaning
    says "Spec."
  work
    title "Spec"
    status draft

@prd p1
  meaning
    says "PRD."
    problem "Problem."
  scope
    goals ["G1"]
    non-goals []
    requirements ["R1"]
  governance
    status draft
  relationships
    grounds @spec s1
`,
  );
  const resEdge = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', copyEdge, '--json'], {
    env: { ...process.env, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  const valEdge =
    resEdge.status === 0
      ? spawnSync(process.execPath, [CLI, 'validate', '--root', copyEdge, '--json'], {
          env: { ...process.env, IA_NO_HANDOFF: '1' },
          encoding: 'utf8',
          windowsHide: true,
        })
      : { stdout: '', stderr: '' };
  assert.match(resEdge.stdout + resEdge.stderr + valEdge.stdout + valEdge.stderr, /IA-(?:LANG|GRAPH)-EDGE-UNCONSENTED/);
});

test('REQ-PRODUCT-BASE-04 success: compliant draft, ratified and active PRDs pass check-prds', () => {
  assert.equal(isValidPrdSource('docs/prd/billing.md'), true);
  assert.equal(isValidPrdSource('https://wiki.example.org/pages/123'), true);
  assert.equal(isValidPrdSource('https://user:secret@wiki.example.org/pages/123'), false);
  assert.equal(isValidPrdSource('../outside/prd.md'), false);

  const ratDigest = '9'.repeat(64);
  const actDigest = '8'.repeat(64);
  const report = checkPrds({
    revision: 'rev-prd-ok',
    records: [
      synSpec('billing-spec', 'accepted'),
      synDecision('pricing-dec', 'made', ['active-prd']),
      // Draft PRD needs neither goals/requirements nor @spec trace yet
      synPrd('draft-prd', { status: 'draft', goals: [], nonGoals: [], requirements: [] }),
      // Ratified PRD traced via outgoing ground -> @spec, with valid source + 64-hex digest + seal
      synPrd('ratified-prd', {
        status: 'ratified',
        digest: ratDigest,
        source: 'docs/prd/ratified.md',
        bodyDigest: 'f'.repeat(64),
        groundsSpecs: ['billing-spec'],
      }),
      // Active PRD traced via incoming @decision cite -> @prd + seal
      synPrd('active-prd', {
        status: 'active',
        digest: actDigest,
        requirements: ['BIL-01: Invoice export', 'BIL-02: Tax rounding'],
      }),
      synApprovalRule('prd-seal-rule', ['prd']),
      synApproval('seal-rat', 'product-base-system/definition/prd/ratified-prd', ratDigest),
      synApproval('seal-act', 'product-base-system/definition/prd/active-prd', actDigest),
    ],
  });

  assert.equal(report.format, FORMAT);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.findings.length, 0);
});

test('REQ-PRODUCT-BASE-04 failure: check-prds refuses incomplete, untraced, cyclic and unsealed PRDs', () => {
  const report = checkPrds({
    revision: 'rev-prd-bad',
    records: [
      synSpec('withdrawn-spec', 'withdrawn'),
      // Empty problem, blank entries, empty goals/reqs on ratified, untraced, credentialed source, bad digest
      synPrd('ratified-empty', {
        status: 'ratified',
        problem: '   ',
        goals: [],
        nonGoals: ['  '],
        requirements: [],
        source: 'https://user:token@wiki.example.org/prd',
        bodyDigest: 'not-64-hex',
      }),
      // Duplicate clause IDs, orphan digest without source, traces ONLY to withdrawn spec, unsealed under prd rule, supersede cycle
      synPrd('active-bad', {
        status: 'active',
        requirements: ['SET-01: First clause', 'set-01: Duplicate clause'],
        bodyDigest: 'a'.repeat(64),
        groundsSpecs: ['withdrawn-spec'],
        supersedes: ['cyc-prd'],
      }),
      synPrd('cyc-prd', {
        status: 'superseded',
        supersedes: ['active-bad'],
      }),
      synApprovalRule('prd-rule', ['prd']),
    ],
  });

  assert.equal(report.ok, false);
  const codes = new Set(report.findings.map(f => f.code));
  for (const expected of [
    'PRD_PROBLEM_EMPTY',
    'PRD_BLANK_ENTRY',
    'PRD_GOALS_EMPTY',
    'PRD_REQUIREMENTS_EMPTY',
    'PRD_UNTRACED_COVERAGE',
    'PRD_SOURCE_INVALID',
    'PRD_BODY_DIGEST_FORMAT',
    'PRD_REQUIREMENT_DUPLICATE_ID',
    'PRD_DIGEST_WITHOUT_SOURCE',
    'PRD_TRACE_WITHDRAWN',
    'PRD_UNSEALED',
    'PRD_SUPERSEDE_CYCLE',
  ]) {
    assert.ok(codes.has(expected), `expected finding ${expected}, got ${[...codes].join(', ')}`);
  }
});

test('REQ-PRODUCT-BASE-05 success: check.mjs runs product-check-validate and check-prds to exit 0', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-product-runner-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-product-base'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system product-base-system]'));

  writeFileSync(
    join(ws, '.ia', 'src', 'product.ia'),
    `#! ia 1.0

@spec checkout-spec
  meaning
    says "Checkout specification."
  work
    title "Checkout spec"
    status accepted

@prd checkout-prd
  meaning
    says "Checkout flow requirements."
    problem "Cart abandonment rises when totals appear late."
  scope
    goals ["Show itemized totals upfront"]
    non-goals ["Subscription billing"]
    requirements ["CHK-01: Render line-item totals before payment step"]
  governance
    status ratified
    source "docs/prd/checkout.md"
  relationships
    grounds @spec checkout-spec
`,
  );

  for (const checkName of ['product-check-validate', 'check-prds']) {
    const ran = spawnSync(
      process.execPath,
      [join(PLUGIN, 'scripts', 'check.mjs'), checkName, '--kit', KIT_ID, '--root', ws, '--cli', CLI],
      { env, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(ran.status, 0, `${checkName}: ${ran.stdout}\n${ran.stderr}`);
    assert.equal(JSON.parse(ran.stdout).exitCode, 0);
  }
});

test('REQ-PRODUCT-BASE-05 failure: check.mjs exits 3 when check-prds detects violations', { skip: SKIP_CLI }, t => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-product-runner-fail-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-product-base'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  writeFileSync(wsFile, readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system product-base-system]'));

  writeFileSync(
    join(ws, '.ia', 'src', 'product.ia'),
    `#! ia 1.0

@prd incomplete-ratified-prd
  meaning
    says "Prematurely ratified PRD."
    problem "Some problem."
  scope
    goals []
    non-goals []
    requirements []
  governance
    status ratified
`,
  );

  const ran = spawnSync(
    process.execPath,
    [join(PLUGIN, 'scripts', 'check.mjs'), 'check-prds', '--kit', KIT_ID, '--root', ws, '--cli', CLI],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(ran.status, 3, ran.stdout + ran.stderr);
  const body = JSON.parse(JSON.parse(ran.stdout).stdout);
  assert.equal(body.ok, false);
  assert.ok(body.findings.some(f => f.code === 'PRD_GOALS_EMPTY'));
  assert.ok(body.findings.some(f => f.code === 'PRD_REQUIREMENTS_EMPTY'));
  assert.ok(body.findings.some(f => f.code === 'PRD_UNTRACED_COVERAGE'));
});
