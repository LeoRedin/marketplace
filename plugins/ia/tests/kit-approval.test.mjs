// Qualification and unit tests for inventarch/ia-approval-kit (approval-system 0.1.0).
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
import {
  APPROVALS_DIR,
  CanonicalError,
  buildStatement,
  canonicalize,
  checkSeal,
  decodeBase64url,
  encodeBase64url,
  generateSigningKey,
  isFailing,
  keyEntryText,
  keyIdOf,
  nameSafeKeyTag,
  passes,
  scalarIsCanonical,
  sealRecord,
  signStatement,
  verifyStatement,
} from '../config/kits/ia-approval/scripts/check-seal.mjs';

const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const KIT = join(PLUGIN, 'config', 'kits', 'ia-approval');
const SOURCE_KIT = join(REPO_ROOT, 'kits', 'ia-approval');
const KIT_ID = 'inventarch/ia-approval-kit';
const SYSTEM = 'approval-system';
const REPO_CLI = join(REPO_ROOT, 'node_modules', '@inventarch', 'cli', 'dist', 'main.js');
const CLI = process.env.IA_CORE_TEST_CLI ?? (existsSync(REPO_CLI) ? REPO_CLI : null);
const SKIP_CLI = !CLI && 'install @inventarch/cli or set IA_CORE_TEST_CLI';

const ROLES = ['documentation', 'asset'];
const WORDS = ['approval', 'approval-rule', 'approver', 'docket'];

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

function makeRecord(identity, system, kind, facet, name, digest, sourcePath, fields) {
  return { identity, system, kind, facet, name, digest, sourcePath, fields };
}

function makeView(revision, list) {
  return { revision, records: new Map(list.map(r => [r.identity, r])) };
}

function defaultFacts({ targetCommits = ['1'.repeat(40)], entered = new Map(), headBlobs = new Map(), targetBlobs = new Map(), commitTimes = new Map() } = {}) {
  const positions = new Map(targetCommits.map((c, i) => [c, i]));
  return {
    headBlobOf: path => headBlobs.get(path) ?? null,
    targetBlobOf: path => targetBlobs.get(path) ?? null,
    targetPositionOf: commit => positions.get(commit) ?? null,
    isAncestorOfTarget: commit => positions.has(commit),
    targetEntryOfBlob: blob => entered.get(blob) ?? null,
    targetCommitTime: pos => commitTimes.get(pos) ?? new Date('2026-11-01T00:00:00Z'),
  };
}

function baseRecords() {
  const ws = makeRecord(
    'workspace-system/definition/workspace/org-kb',
    'workspace-system',
    'definition',
    'workspace',
    'org-kb',
    'a'.repeat(64),
    '.ia/src/workspace.ia',
    { 'composition.sources': ['.ia/src @authored'] },
  );
  const sysWork = makeRecord('floor/definition/system/work-system', 'floor', 'definition', 'system', 'work-system', 'b'.repeat(64), '.ia/floor/work.ia', {
    version: '3.2.0',
    'discriminators.spec': 'contract',
    'discriminators.decision': 'definition',
  });
  const sysApproval = makeRecord('approval-system/definition/system/approval-system', 'approval-system', 'definition', 'system', 'approval-system', 'c'.repeat(64), '.ia/dist/approval.ia', {
    version: '0.1.0',
    'discriminators.approver': 'definition',
    'discriminators.approval-rule': 'governance',
    'discriminators.docket': 'definition',
    'discriminators.approval': 'definition',
  });
  return [ws, sysWork, sysApproval];
}

function approverRec(name, account, display, keyEntries, workspaces = ['workspace-system/definition/workspace/org-kb'], extra = {}) {
  return makeRecord(
    `approval-system/definition/approver/${name}`,
    'approval-system',
    'definition',
    'approver',
    name,
    createDigest(`${name}:${account}:${keyEntries.join(',')}:${JSON.stringify(extra)}`),
    '.ia/src/approvers.ia',
    {
      'person.account': account,
      'person.display': display,
      'authority.workspaces': workspaces,
      'keys.entries': keyEntries,
      ...extra,
    },
  );
}

function createDigest(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').repeat(8);
}

function approvalCorpusRecord(seal) {
  const s = seal.statement;
  const name = `${s.record.split('/').pop()}-${s.recordDigest.slice(0, 12)}-${nameSafeKeyTag(s.keyId)}`;
  return makeRecord(
    `approval-system/definition/approval/${name}`,
    'approval-system',
    'definition',
    'approval',
    name,
    createDigest(seal.source),
    seal.path,
    {
      'seal.action': s.action,
      'seal.organisation': s.organisation,
      'seal.workspace': s.workspace,
      'seal.record': s.record,
      'seal.record-digest': s.recordDigest,
      'seal.depends-on': s.dependsOn.map(r => `${r.identity} ${r.digest}`),
      'seal.rules': s.rules.map(r => `${r.identity} ${r.digest}`),
      'seal.revision': s.revision,
      'seal.language-version': s.language,
      'seal.system-versions': s.systems.map(sys => `${sys.system} ${sys.version}`),
      'seal.base-commit': s.baseCommit,
      'seal.signer': s.signer,
      'seal.key-id': s.keyId,
      'seal.key-kind': s.keyKind,
      'seal.via': s.via,
      'seal.request': s.request,
      'seal.signed-at': s.signedAt,
      'seal.algorithm': 'ed25519',
      'seal.signature': seal.signature,
    },
  );
}

test('kit files carry LF line endings, Apache-2.0 license and zero private or tenant material', () => {
  const deny = /private-|\b(?!ia-approval-kit\b)ia-[a-z]+(?:-[a-z]+)*-kit\b|inventarch\/(?!ia-approval-kit\b|language\b|cli\b|marketplace\.git\b)|inventarch-(?!approval\b)[a-z]|Proprietary|UNLICENSED|PR #\d+/i;
  for (const root of [KIT, SOURCE_KIT]) {
    const descriptor = JSON.parse(readFileSync(join(root, '.ia', 'release.json'), 'utf8'));
    assert.equal(descriptor.id, KIT_ID);
    assert.equal(descriptor.license, 'Apache-2.0');
    for (const file of walk(root).filter(f => !relative(root, f).replace(/\\/g, '/').startsWith('releases'))) {
      const bytes = readFileSync(file);
      assert.equal(bytes.includes(0x0d), false, `${relative(root, file)}: CR byte found`);
      const lines = bytes.toString('utf8').split('\n');
      for (const [i, line] of lines.entries()) {
        assert.doesNotMatch(line, deny, `${relative(root, file)}:${i + 1}`);
      }
    }
  }
});

test('REQ-APPROVAL-01 success: the kit admits offline with steward hygiene and four word schemas', { skip: SKIP_CLI }, t => {
  const records = parseRecords(KIT);
  assert.ok(records.some(r => r.word === 'system' && r.name === SYSTEM));
  assert.ok(records.some(r => r.word === 'agent' && r.name === `${SYSTEM}-steward`));
  assert.ok(records.some(r => r.word === 'mandate' && r.name === `${SYSTEM}-stewardship`));
  for (const word of WORDS) {
    assert.ok(records.some(r => r.word === 'schema' && r.name === word), `missing @schema ${word}`);
    assert.ok(records.some(r => r.word === 'convention' && r.name === `approval-guide-${word}`), `missing authoring guide convention for ${word}`);
  }

  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-approval-req01-ok-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const ws = join(scratch, 'ws');
  const home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  cpSync(join(KIT, '.ia'), join(ws, '.ia'), { recursive: true });
  cpSync(join(KIT, 'assets'), join(ws, 'assets'), { recursive: true });
  cpSync(join(KIT, 'scripts'), join(ws, 'scripts'), { recursive: true });
  cpSync(join(KIT, 'checks.json'), join(ws, 'checks.json'));

  const restore = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', ws, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(restore.status, 0, restore.stdout + restore.stderr);
  assert.equal(JSON.parse(restore.stdout).applied?.status, 'installed');

  const validate = spawnSync(process.execPath, [CLI, 'validate', '--root', ws, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  const verdict = JSON.parse(validate.stdout);
  assert.equal(verdict.status, 'admitted');
  assert.equal(verdict.counts.errors, 0);
});

test('REQ-APPROVAL-01 failure: an unknown evaluator is refused', { skip: SKIP_CLI }, t => {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-approval-req01-fail-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const ws = join(scratch, 'ws');
  const home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  cpSync(join(KIT, '.ia'), join(ws, '.ia'), { recursive: true });
  const compPath = join(ws, '.ia', 'src', 'systems', SYSTEM, 'records', 'compliance.ia');
  writeFileSync(compPath, readFileSync(compPath, 'utf8').replace('runs COMP-CHECK\n    scope "ia validate --json"', 'runs UNKNOWN-EVAL\n    scope "ia validate --json"'));

  const restore = spawnSync(process.execPath, [CLI, 'restore', '--apply', '--yes', '--root', ws, '--json'], {
    env: { ...process.env, IA_HOME: home, IA_NO_HANDOFF: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(restore.status, 0);
  assert.match(restore.stdout + restore.stderr, /IA-COMP-CHECK-UNKNOWN/);
});

test('REQ-APPROVAL-02 success: checks, assets and format 2 release metadata match', () => {
  const records = parseRecords(KIT);
  const checks = JSON.parse(readFileSync(join(KIT, 'checks.json'), 'utf8'));
  assert.deepEqual(checksProblems(records, checks), []);
  assert.deepEqual(assetProblems(KIT), []);
  assert.deepEqual(releaseProblems(KIT), []);
});

test('REQ-APPROVAL-02 failure: drifted checks, assets and releases are refused', t => {
  const copy = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-approval-req02-fail-')));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(KIT, copy, { recursive: true });

  const compPath = join(copy, '.ia', 'src', 'systems', SYSTEM, 'records', 'compliance.ia');
  const originalComp = readFileSync(compPath, 'utf8');
  writeFileSync(compPath, originalComp.replace('scope "ia validate --json"', 'scope ""'));
  assert.ok(checksProblems(parseRecords(copy), JSON.parse(readFileSync(join(copy, 'checks.json'), 'utf8'))).length > 0);
  writeFileSync(compPath, originalComp);

  writeFileSync(join(copy, 'assets', 'unlisted.md'), '# stray\n');
  assert.match(assetProblems(copy).join('\n'), /unlisted\.md: shipped but not listed/);
  rmSync(join(copy, 'assets', 'unlisted.md'));

  const relPath = join(copy, '.ia', 'release.json');
  const desc = JSON.parse(readFileSync(relPath, 'utf8'));
  writeFileSync(relPath, JSON.stringify({ ...desc, assets: [...desc.assets, { path: 'assets/missing.md', role: 'documentation' }] }, null, 2) + '\n');
  assert.match(assetProblems(copy).join('\n'), /assets\/missing\.md: missing/);
  writeFileSync(relPath, JSON.stringify(desc, null, 2) + '\n');

  writeFileSync(compPath, `${originalComp}\n`);
  assert.match(releaseProblems(copy).join('\n'), /sources digest mismatch/);
});

test('REQ-APPROVAL-03 success: valid Ed25519 JCS seals and multi-signer quorum pass', () => {
  // RFC 8785 JCS sorting & formatting
  assert.equal(canonicalize({ b: [2, true, null], a: 'ok' }), '{"a":"ok","b":[2,true,null]}');
  assert.throws(() => canonicalize('\uD800'), CanonicalError);
  assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), CanonicalError);

  const { key: keyA } = generateSigningKey();
  const { key: keyB } = generateSigningKey();
  assert.equal(keyA.keyId, keyIdOf(keyA.rawPublicKey));
  assert.equal(decodeBase64url(`${encodeBase64url(keyA.rawPublicKey)}=`), null, 'padded base64url refused');

  const approverA = approverRec('lead', 'acct-lead', 'Operator A', [keyEntryText({ keyId: keyA.keyId, algorithm: 'ed25519', publicKey: keyA.rawPublicKey, status: 'active', fromCommit: null })]);
  const approverB = approverRec('peer', 'acct-peer', 'Operator B', [keyEntryText({ keyId: keyB.keyId, algorithm: 'ed25519', publicKey: keyB.rawPublicKey, status: 'active', fromCommit: null })]);

  const ruleSingle = makeRecord('approval-system/governance/approval-rule/spec-single', 'approval-system', 'governance', 'approval-rule', 'spec-single', '11'.repeat(32), '.ia/src/rules.ia', {
    'demand.words': ['decision'],
    'demand.quorum': '1',
    'demand.via': ['desk'],
    'demand.key-kind': 'service-held',
    'demand.staleness': 'unchanged-inputs',
    'demand.merge': 'person',
  });
  const ruleQuorum2 = makeRecord('approval-system/governance/approval-rule/spec-quorum2', 'approval-system', 'governance', 'approval-rule', 'spec-quorum2', '22'.repeat(32), '.ia/src/rules.ia', {
    'demand.words': ['spec'],
    'demand.quorum': '2',
    'demand.via': ['desk', 'slack'],
    'demand.key-kind': 'service-held',
    'demand.staleness': 'unchanged-inputs',
    'demand.merge': 'person',
  });

  const target = makeView('0'.repeat(64), [...baseRecords(), approverA, approverB, ruleSingle, ruleQuorum2]);

  const dec = makeRecord('work-system/definition/decision/arch-choice', 'work-system', 'definition', 'decision', 'arch-choice', '33'.repeat(32), '.ia/src/decisions.ia', {});
  const spec = makeRecord('work-system/contract/spec/core-spec', 'work-system', 'contract', 'spec', 'core-spec', '44'.repeat(32), '.ia/src/specs.ia', {});

  const toolchain = {
    language: '3.2.0',
    systems: [
      { system: 'approval-system', version: '0.1.0' },
      { system: 'work-system', version: '3.2.0' },
    ],
  };

  const sealSingle = sealRecord({
    action: 'approve',
    organisation: 'workspace-system/definition/workspace/org-kb',
    workspace: 'workspace-system/definition/workspace/org-kb',
    record: { identity: dec.identity, name: dec.name },
    recordDigest: dec.digest,
    dependsOn: [],
    rules: [{ identity: ruleSingle.identity, digest: ruleSingle.digest }],
    revision: '9'.repeat(64),
    toolchain,
    baseCommit: '1'.repeat(40),
    signer: { account: 'acct-lead', display: 'Operator A' },
    key: keyA,
    keyKind: 'service-held',
    via: 'desk',
    request: 'req-01',
    signedAt: new Date('2026-11-18T00:00:00Z'),
  });

  const sealQ1 = sealRecord({
    action: 'approve',
    organisation: 'workspace-system/definition/workspace/org-kb',
    workspace: 'workspace-system/definition/workspace/org-kb',
    record: { identity: spec.identity, name: spec.name },
    recordDigest: spec.digest,
    dependsOn: [],
    rules: [{ identity: ruleQuorum2.identity, digest: ruleQuorum2.digest }],
    revision: '9'.repeat(64),
    toolchain,
    baseCommit: '1'.repeat(40),
    signer: { account: 'acct-lead', display: 'Operator A' },
    key: keyA,
    keyKind: 'service-held',
    via: 'desk',
    request: 'req-02',
    signedAt: new Date('2026-11-18T00:01:00Z'),
  });

  const sealQ2 = sealRecord({
    action: 'approve',
    organisation: 'workspace-system/definition/workspace/org-kb',
    workspace: 'workspace-system/definition/workspace/org-kb',
    record: { identity: spec.identity, name: spec.name },
    recordDigest: spec.digest,
    dependsOn: [],
    rules: [{ identity: ruleQuorum2.identity, digest: ruleQuorum2.digest }],
    revision: '9'.repeat(64),
    toolchain,
    baseCommit: '1'.repeat(40),
    signer: { account: 'acct-peer', display: 'Operator B' },
    key: keyB,
    keyKind: 'person-held',
    via: 'slack',
    request: 'req-03',
    signedAt: new Date('2026-11-18T00:02:00Z'),
  });

  const head = makeView('9'.repeat(64), [
    ...target.records.values(),
    dec,
    spec,
    approvalCorpusRecord(sealSingle),
    approvalCorpusRecord(sealQ1),
    approvalCorpusRecord(sealQ2),
  ]);

  const report = checkSeal({
    target,
    head,
    language: '3.2.0',
    lineEndingsPinned: true,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });

  assert.equal(passes(report), true, JSON.stringify(report.findings));
  assert.deepEqual(report.records, [
    { identity: dec.identity, change: 'added', verdict: 'ratified' },
    { identity: spec.identity, change: 'added', verdict: 'ratified' },
  ]);
  assert.equal(report.needsPersonMerge, true);
});

test('REQ-APPROVAL-03 failure: bad signatures, non-canonical scalars, wrong signers and unmet quorum fail', () => {
  const { key: keyA1 } = generateSigningKey();
  const { key: keyA2 } = generateSigningKey();
  const { key: keyUnknown } = generateSigningKey();
  const { key: keyRetired } = generateSigningKey();

  // Non-canonical Ed25519 scalar S >= L rejected explicitly
  const maxScalarSig = new Uint8Array(64).fill(0xff);
  assert.equal(scalarIsCanonical(maxScalarSig), false);
  const sampleStatement = buildStatement({
    action: 'approve',
    organisation: 'workspace-system/definition/workspace/org-kb',
    workspace: 'workspace-system/definition/workspace/org-kb',
    record: 'work-system/contract/spec/x',
    recordDigest: '44'.repeat(32),
    dependsOn: [],
    rules: [],
    revision: '9'.repeat(64),
    language: '3.2.0',
    systems: [],
    baseCommit: '1'.repeat(40),
    signer: 'acct-lead',
    keyId: keyA1.keyId,
    keyKind: 'service-held',
    via: 'desk',
    request: 'req-s',
    signedAt: '2026-11-18T00:00:00Z',
  });
  assert.equal(verifyStatement(sampleStatement, encodeBase64url(maxScalarSig), keyA1.rawPublicKey), false);
  const validSig = signStatement(sampleStatement, keyA1);
  assert.equal(verifyStatement({ ...sampleStatement, request: 'tampered' }, validSig, keyA1.rawPublicKey), false);

  // Two keys under the SAME approver account cannot satisfy quorum 2; unknown, disallowed and retired keys fail
  const approverA = approverRec('lead', 'acct-lead', 'Operator A', [
    keyEntryText({ keyId: keyA1.keyId, algorithm: 'ed25519', publicKey: keyA1.rawPublicKey, status: 'active', fromCommit: null }),
    keyEntryText({ keyId: keyA2.keyId, algorithm: 'ed25519', publicKey: keyA2.rawPublicKey, status: 'active', fromCommit: null }),
    keyEntryText({ keyId: keyRetired.keyId, algorithm: 'ed25519', publicKey: keyRetired.rawPublicKey, status: 'retired', fromCommit: '1'.repeat(40) }),
  ]);
  const ruleQuorum2 = makeRecord('approval-system/governance/approval-rule/strict-q2', 'approval-system', 'governance', 'approval-rule', 'strict-q2', '22'.repeat(32), '.ia/src/rules.ia', {
    'demand.words': ['spec'],
    'demand.quorum': '2',
    'demand.via': ['desk'],
    'demand.key-kind': 'person-held',
    'demand.staleness': 'unchanged-inputs',
    'demand.merge': 'person',
  });
  const target = makeView('0'.repeat(64), [...baseRecords(), approverA, ruleQuorum2]);
  const spec = makeRecord('work-system/contract/spec/core-spec', 'work-system', 'contract', 'spec', 'core-spec', '44'.repeat(32), '.ia/src/specs.ia', {});
  const toolchain = {
    language: '3.2.0',
    systems: [
      { system: 'approval-system', version: '0.1.0' },
      { system: 'work-system', version: '3.2.0' },
    ],
  };

  const makeSeal = (key, signer, keyKind, via) =>
    sealRecord({
      action: 'approve',
      organisation: 'workspace-system/definition/workspace/org-kb',
      workspace: 'workspace-system/definition/workspace/org-kb',
      record: { identity: spec.identity, name: spec.name },
      recordDigest: spec.digest,
      dependsOn: [],
      rules: [{ identity: ruleQuorum2.identity, digest: ruleQuorum2.digest }],
      revision: '9'.repeat(64),
      toolchain,
      baseCommit: '1'.repeat(40),
      signer: { account: signer, display: 'Operator' },
      key,
      keyKind,
      via,
      request: `req-${key.keyId.slice(0, 6)}`,
      signedAt: new Date('2026-11-18T00:00:00Z'),
    });

  // Same account signing twice + unknown signer + retired key + weak keyKind ('service-held' vs required 'person-held')
  const sealSame1 = makeSeal(keyA1, 'acct-lead', 'person-held', 'desk');
  const sealSame2 = makeSeal(keyA2, 'acct-lead', 'person-held', 'desk');
  const sealUnknown = makeSeal(keyUnknown, 'acct-outsider', 'person-held', 'desk');
  const sealRet = makeSeal(keyRetired, 'acct-lead', 'person-held', 'desk');
  const sealDisallowedVia = makeSeal(keyA1, 'acct-lead', 'service-held', 'slack');
  // Rebuild sealDisallowedVia at distinct path by altering signedAt? No, same recordDigest + keyId shares filename, so test disallowed separately.

  const head = makeView('9'.repeat(64), [
    ...target.records.values(),
    spec,
    approvalCorpusRecord(sealSame1),
    approvalCorpusRecord(sealSame2),
    approvalCorpusRecord(sealUnknown),
    approvalCorpusRecord(sealRet),
  ]);

  const report = checkSeal({
    target,
    head,
    language: '3.2.0',
    lineEndingsPinned: true,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });

  assert.equal(passes(report), false);
  const codes = new Set(report.findings.map(f => f.name));
  assert.ok(codes.has('signer-unknown'), 'unknown signer flagged');
  assert.ok(codes.has('key-retired'), 'retired key flagged');
  assert.ok(codes.has('unratified'), 'same account with two keys only counts as 1 distinct approver');

  // Disallowed via/key-kind check
  const headDisallowed = makeView('9'.repeat(64), [...target.records.values(), spec, approvalCorpusRecord(sealDisallowedVia)]);
  const disallowedReport = checkSeal({
    target,
    head: headDisallowed,
    language: '3.2.0',
    lineEndingsPinned: true,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });
  assert.ok(disallowedReport.findings.some(f => f.name === 'signer-not-allowed'));
});

test('REQ-APPROVAL-04 success: intact record digest, dependsOn and current-revision pass', () => {
  const { key } = generateSigningKey();
  const approver = approverRec('lead', 'acct-lead', 'Operator A', [
    keyEntryText({ keyId: key.keyId, algorithm: 'ed25519', publicKey: key.rawPublicKey, status: 'active', fromCommit: null }),
  ]);
  const ruleCurrent = makeRecord('approval-system/governance/approval-rule/rev-strict', 'approval-system', 'governance', 'approval-rule', 'rev-strict', '55'.repeat(32), '.ia/src/rules.ia', {
    'demand.words': ['spec'],
    'demand.quorum': '1',
    'demand.staleness': 'current-revision',
    'demand.merge': 'person',
  });
  const depDecision = makeRecord('work-system/definition/decision/dep-01', 'work-system', 'definition', 'decision', 'dep-01', '66'.repeat(32), '.ia/src/decisions.ia', {});
  const target = makeView('0'.repeat(64), [...baseRecords(), approver, ruleCurrent, depDecision]);

  const spec = makeRecord('work-system/contract/spec/bound-spec', 'work-system', 'contract', 'spec', 'bound-spec', '77'.repeat(32), '.ia/src/specs.ia', {});
  const headRevision = '88'.repeat(32);
  const seal = sealRecord({
    action: 'approve',
    organisation: 'workspace-system/definition/workspace/org-kb',
    workspace: 'workspace-system/definition/workspace/org-kb',
    record: { identity: spec.identity, name: spec.name },
    recordDigest: spec.digest,
    dependsOn: [{ identity: depDecision.identity, digest: depDecision.digest }],
    rules: [{ identity: ruleCurrent.identity, digest: ruleCurrent.digest }],
    revision: headRevision,
    toolchain: {
      language: '3.2.0',
      systems: [
        { system: 'approval-system', version: '0.1.0' },
        { system: 'work-system', version: '3.2.0' },
      ],
    },
    baseCommit: '1'.repeat(40),
    signer: { account: 'acct-lead', display: 'Operator A' },
    key,
    keyKind: 'service-held',
    via: 'desk',
    request: 'req-rev',
    signedAt: new Date('2026-11-18T00:00:00Z'),
  });

  const head = makeView(headRevision, [...target.records.values(), spec, approvalCorpusRecord(seal)]);
  const report = checkSeal({
    target,
    head,
    language: '3.2.0',
    lineEndingsPinned: true,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });
  assert.equal(passes(report), true, JSON.stringify(report.findings));
  assert.equal(report.records[0]?.verdict, 'ratified');
});

test('REQ-APPROVAL-04 failure: tampered digests, changed dependsOn, unapproved rules and stale revisions fail', () => {
  const { key } = generateSigningKey();
  const approver = approverRec('lead', 'acct-lead', 'Operator A', [
    keyEntryText({ keyId: key.keyId, algorithm: 'ed25519', publicKey: key.rawPublicKey, status: 'active', fromCommit: null }),
  ]);
  const ruleCurrent = makeRecord('approval-system/governance/approval-rule/rev-strict', 'approval-system', 'governance', 'approval-rule', 'rev-strict', '55'.repeat(32), '.ia/src/rules.ia', {
    'demand.words': ['spec'],
    'demand.quorum': '1',
    'demand.staleness': 'current-revision',
    'demand.merge': 'person',
  });
  const extraRule = makeRecord('approval-system/governance/approval-rule/path-rule', 'approval-system', 'governance', 'approval-rule', 'path-rule', '56'.repeat(32), '.ia/src/rules.ia', {
    'demand.paths': ['.ia/src/specs.ia'],
    'demand.quorum': '1',
    'demand.staleness': 'unchanged-inputs',
    'demand.merge': 'person',
  });
  const depDecision = makeRecord('work-system/definition/decision/dep-01', 'work-system', 'definition', 'decision', 'dep-01', '66'.repeat(32), '.ia/src/decisions.ia', {});
  const target = makeView('0'.repeat(64), [...baseRecords(), approver, ruleCurrent, extraRule, depDecision]);

  const specSigned = makeRecord('work-system/contract/spec/bound-spec', 'work-system', 'contract', 'spec', 'bound-spec', '77'.repeat(32), '.ia/src/specs.ia', {});
  const signedRevision = '88'.repeat(32);
  // Seal omits extraRule!
  const seal = sealRecord({
    action: 'approve',
    organisation: 'workspace-system/definition/workspace/org-kb',
    workspace: 'workspace-system/definition/workspace/org-kb',
    record: { identity: specSigned.identity, name: specSigned.name },
    recordDigest: specSigned.digest,
    dependsOn: [{ identity: depDecision.identity, digest: depDecision.digest }],
    rules: [{ identity: ruleCurrent.identity, digest: ruleCurrent.digest }],
    revision: signedRevision,
    toolchain: {
      language: '3.2.0',
      systems: [
        { system: 'approval-system', version: '0.1.0' },
        { system: 'work-system', version: '3.2.0' },
      ],
    },
    baseCommit: '1'.repeat(40),
    signer: { account: 'acct-lead', display: 'Operator A' },
    key,
    keyKind: 'service-held',
    via: 'desk',
    request: 'req-tamper',
    signedAt: new Date('2026-11-18T00:00:00Z'),
  });

  // Case A: tampered record digest after signing
  const specTampered = { ...specSigned, digest: '78'.repeat(32) };
  const repTampered = checkSeal({
    target,
    head: makeView(signedRevision, [...target.records.values(), specTampered, approvalCorpusRecord(seal)]),
    language: '3.2.0',
    lineEndingsPinned: true,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });
  assert.ok(repTampered.findings.some(f => f.name === 'seal-wrong-record'));

  // Case B: changed one-hop dependency digest -> stale
  const depEdited = { ...depDecision, digest: '67'.repeat(32) };
  const repDepStale = checkSeal({
    target,
    head: makeView(signedRevision, [...baseRecords(), approver, ruleCurrent, extraRule, depEdited, specSigned, approvalCorpusRecord(seal)]),
    language: '3.2.0',
    lineEndingsPinned: true,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });
  assert.ok(repDepStale.findings.some(f => f.name === 'stale'));
  assert.ok(repDepStale.findings.some(f => f.name === 'unratified' && f.detail.includes(extraRule.identity)), 'unapproved extraRule reported');

  // Case C: stale corpus revision under current-revision rule, and unpinned line endings
  const repStaleRev = checkSeal({
    target: makeView('0'.repeat(64), [...baseRecords(), approver, ruleCurrent, depDecision]),
    head: makeView('99'.repeat(32), [...baseRecords(), approver, ruleCurrent, depDecision, specSigned, approvalCorpusRecord(seal)]),
    language: '3.2.0',
    lineEndingsPinned: true,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });
  assert.equal(repStaleRev.records[0]?.verdict, 'stale');

  const repUnpinnedLf = checkSeal({
    target: makeView('0'.repeat(64), [...baseRecords(), approver, ruleCurrent, depDecision]),
    head: makeView(signedRevision, [...baseRecords(), approver, ruleCurrent, depDecision, specSigned, approvalCorpusRecord(seal)]),
    language: '3.2.0',
    lineEndingsPinned: false,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });
  assert.ok(repUnpinnedLf.findings.some(f => f.name === 'line-endings-unpinned-revision'));
});

test('REQ-APPROVAL-05 success: target-branch authority, valid dockets and check.mjs runner pass', { skip: SKIP_CLI }, t => {
  // 1. Valid producer docket matching a pattern already on target branch requires no unrecognised-piece seal
  const pattern = makeRecord('work-system/contract/spec/pattern-01', 'work-system', 'contract', 'spec', 'pattern-01', 'aa'.repeat(32), '.ia/src/patterns.ia', {});
  const unrecRule = makeRecord('approval-system/governance/approval-rule/unrec-only', 'approval-system', 'governance', 'approval-rule', 'unrec-only', 'bb'.repeat(32), '.ia/src/rules.ia', {
    'demand.pieces': 'unrecognised',
    'demand.quorum': '1',
  });
  const target = makeView('0'.repeat(64), [...baseRecords(), pattern, unrecRule]);
  const piece = makeRecord('work-system/definition/decision/intake-01', 'work-system', 'definition', 'decision', 'intake-01', 'cc'.repeat(32), '.ia/src/decisions.ia', {});
  const docket = makeRecord('approval-system/definition/docket/run-01', 'approval-system', 'definition', 'docket', 'run-01', 'dd'.repeat(32), '.ia/src/dockets.ia', {
    'docket.producer': 'intake-runner 1.0.0',
    'docket.pieces': [`${piece.identity} matched transcript notes%20v1.md ${'ee'.repeat(32)} ${pattern.identity}`],
  });
  const prReport = checkSeal({
    target,
    head: makeView('1'.repeat(64), [...target.records.values(), piece, docket]),
    language: '3.2.0',
    lineEndingsPinned: true,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });
  assert.equal(passes(prReport), true, JSON.stringify(prReport.findings));

  // 2. Real CLI + scripts/check.mjs check-seal execution on an admitted workspace with a valid signed @approval
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-approval-runner-ok-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  const init = spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(init.status, 0, init.stdout + init.stderr);

  const kitObj = findKit('ia-approval');
  adopt(ws, kitObj, { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });

  // Compose approval-system in workspace.ia and author an approver, rule, decision and valid seal
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  const wsText = readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system approval-system]');
  writeFileSync(wsFile, wsText);
  writeFileSync(join(ws, '.gitattributes'), '* text eol=lf\n');

  const { key } = generateSigningKey();
  const wsIdMatch = /^@workspace\s+([a-z0-9-]+)/m.exec(wsText);
  const wsId = `workspace-system/definition/workspace/${wsIdMatch[1]}`;

  writeFileSync(
    join(ws, '.ia', 'src', 'governance.ia'),
    `#! ia 1.0

@approver lead-approver
  meaning
    says "Primary workspace approver."
    answers "Who ratifies decisions in this workspace?"
  person
    account "acct-lead"
    display "Operator A"
  authority
    workspaces ["${wsId}"]
    anchor founding
  keys
    entries ["${keyEntryText({ keyId: key.keyId, algorithm: 'ed25519', publicKey: key.rawPublicKey, status: 'active', fromCommit: null })}"]

@approval-rule decision-seal
  meaning
    says "Decisions require one desk seal."
    answers "Which records require a seal?"
  demand
    words [decision]
    quorum 1
    via [desk]
    key-kind service-held
    staleness unchanged-inputs
    merge person

@decision sample-decision
  meaning
    says "Adopt offline Ed25519 seals."
  work
    title "Sample decision"
    status made
  decision
    question "How are decisions ratified?"
    decider "Operator A"
    choice "Offline Ed25519 seals"
    rationale "Verifiable without network or private keys in CI."
`,
  );

  // Capture once in a temp copy to read exact compiled digests for sample-decision and decision-seal
  const capCopy = join(base, 'cap');
  cpSync(ws, capCopy, { recursive: true });
  const capRun = spawnSync(process.execPath, [CLI, 'capture', '--root', capCopy, '--json'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(capRun.status, 0, capRun.stdout + capRun.stderr);
  const snap = JSON.parse(readFileSync(join(capCopy, '.ia', 'work', 'snapshot', 'current.json'), 'utf8'));
  const decSnap = snap.records.find(r => r.name === 'sample-decision');
  const ruleSnap = snap.records.find(r => r.name === 'decision-seal');

  const seal = sealRecord({
    action: 'approve',
    organisation: wsId,
    workspace: wsId,
    record: { identity: decSnap.identity, name: decSnap.name },
    recordDigest: decSnap.digest,
    dependsOn: [],
    rules: [{ identity: ruleSnap.identity, digest: ruleSnap.digest }],
    revision: snap.authoredRevision,
    toolchain: {
      language: '3.2.0',
      systems: [
        { system: 'approval-system', version: '0.1.0' },
        { system: 'work-system', version: '3.2.0' },
      ],
    },
    baseCommit: '1'.repeat(40),
    signer: { account: 'acct-lead', display: 'Operator A' },
    key,
    keyKind: 'service-held',
    via: 'desk',
    request: 'req-live-01',
    signedAt: new Date('2026-11-18T00:00:00Z'),
  });
  mkdirSync(join(ws, APPROVALS_DIR), { recursive: true });
  writeFileSync(join(ws, seal.path), seal.source);

  const checkRun = spawnSync(
    process.execPath,
    [join(PLUGIN, 'scripts', 'check.mjs'), 'check-seal', '--kit', KIT_ID, '--root', ws, '--cli', CLI],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(checkRun.status, 0, checkRun.stdout + checkRun.stderr);
  const parsed = JSON.parse(checkRun.stdout);
  assert.equal(parsed.exitCode, 0);
});

test('REQ-APPROVAL-05 failure: head-only authority, bad dockets and broken workspace seals fail', { skip: SKIP_CLI }, t => {
  // 1. Unratified head-only approver, planted head pattern, desk-matched docket, self-vouching docket, automatic-merge root rule
  const { key: headOnlyKey } = generateSigningKey();
  const unrecRule = makeRecord('approval-system/governance/approval-rule/unrec-only', 'approval-system', 'governance', 'approval-rule', 'unrec-only', 'bb'.repeat(32), '.ia/src/rules.ia', {
    'demand.pieces': 'unrecognised',
    'demand.quorum': '1',
  });
  const target = makeView('0'.repeat(64), [...baseRecords(), unrecRule]);

  const headApprover = approverRec('head-attacker', 'acct-head', 'Unratified', [
    keyEntryText({ keyId: headOnlyKey.keyId, algorithm: 'ed25519', publicKey: headOnlyKey.rawPublicKey, status: 'active', fromCommit: null }),
  ], ['workspace-system/definition/workspace/org-kb'], { 'authority.anchor': 'founding' });
  const plantedPattern = makeRecord('work-system/contract/spec/planted', 'work-system', 'contract', 'spec', 'planted', 'ab'.repeat(32), '.ia/src/patterns.ia', {});
  const piece = makeRecord('work-system/definition/decision/intake-02', 'work-system', 'definition', 'decision', 'intake-02', 'cd'.repeat(32), '.ia/src/decisions.ia', {});
  const plantedDocket = makeRecord('approval-system/definition/docket/planted-docket', 'approval-system', 'definition', 'docket', 'planted-docket', 'de'.repeat(32), '.ia/src/dockets.ia', {
    'docket.producer': 'intake-runner 1.0.0',
    'docket.pieces': [`${piece.identity} matched transcript doc.md ${'ef'.repeat(32)} ${plantedPattern.identity}`],
  });
  const deskDocket = makeRecord('approval-system/definition/docket/desk-bad', 'approval-system', 'definition', 'docket', 'desk-bad', 'df'.repeat(32), '.ia/src/dockets.ia', {
    'docket.producer': 'desk 1.0',
    'docket.pieces': [`${piece.identity} matched chat turn-1 ${'f0'.repeat(32)} ${plantedPattern.identity}`],
  });
  const selfDocket = makeRecord('approval-system/definition/docket/self-bad', 'approval-system', 'definition', 'docket', 'self-bad', 'e0'.repeat(32), '.ia/src/dockets.ia', {
    'docket.producer': 'intake-runner 1.0.0',
    'docket.pieces': [`approval-system/definition/docket/self-bad none chat turn-2 ${'f1'.repeat(32)} -`],
  });
  const headSeal = sealRecord({
    action: 'approve',
    organisation: 'workspace-system/definition/workspace/org-kb',
    workspace: 'workspace-system/definition/workspace/org-kb',
    record: { identity: piece.identity, name: piece.name },
    recordDigest: piece.digest,
    dependsOn: [],
    rules: [{ identity: unrecRule.identity, digest: unrecRule.digest }],
    revision: '2'.repeat(64),
    toolchain: { language: '3.2.0', systems: [{ system: 'approval-system', version: '0.1.0' }, { system: 'work-system', version: '3.2.0' }] },
    baseCommit: '1'.repeat(40),
    signer: { account: 'acct-head', display: 'Unratified' },
    key: headOnlyKey,
    keyKind: 'service-held',
    via: 'desk',
    request: 'req-self-grant',
    signedAt: new Date('2026-11-18T00:00:00Z'),
  });

  const prReport = checkSeal({
    target,
    head: makeView('2'.repeat(64), [
      ...target.records.values(),
      headApprover,
      plantedPattern,
      piece,
      plantedDocket,
      deskDocket,
      selfDocket,
      approvalCorpusRecord(headSeal),
    ]),
    language: '3.2.0',
    lineEndingsPinned: true,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });
  const names = new Set(prReport.findings.map(f => f.name));
  assert.ok(names.has('signer-unknown'), 'head-only approver is not trusted');
  assert.ok(names.has('unratified'), 'planted pattern does not exempt piece');
  assert.ok(names.has('desk-docket-matched'), 'desk producer claiming matched refused');
  assert.ok(names.has('docket-self-vouching'), 'self-vouching docket refused');

  // Automatic-merge rule change refused with root-needs-person
  const { key: rootKey } = generateSigningKey();
  const targetWithRoster = makeView('0'.repeat(64), [
    ...baseRecords(),
    approverRec('lead', 'acct-lead', 'Operator A', [keyEntryText({ keyId: rootKey.keyId, algorithm: 'ed25519', publicKey: rootKey.rawPublicKey, status: 'active', fromCommit: null })]),
  ]);
  const autoRule = makeRecord('approval-system/governance/approval-rule/auto-bad', 'approval-system', 'governance', 'approval-rule', 'auto-bad', '91'.repeat(32), '.ia/src/rules.ia', {
    'demand.words': ['approver'],
    'demand.quorum': '1',
    'demand.merge': 'automatic',
  });
  const rootRep = checkSeal({
    target: targetWithRoster,
    head: makeView('3'.repeat(64), [...targetWithRoster.records.values(), autoRule]),
    language: '3.2.0',
    lineEndingsPinned: true,
    now: new Date('2026-11-18T01:00:00Z'),
    facts: defaultFacts(),
  });
  assert.ok(rootRep.findings.some(f => f.name === 'root-needs-person' && isFailing(f)));

  // 2. scripts/check.mjs check-seal exits 3 when a sealed record in the workspace is tampered after signing
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ia-approval-runner-fail-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ws = join(base, 'ws');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, IA_HOME: home, IA_CLI_PATH: CLI, IA_NO_HANDOFF: '1' };

  spawnSync(process.execPath, [CLI, 'init', ws, '--host', 'none', '--apply', '--yes', '--json'], { env, encoding: 'utf8', windowsHide: true });
  adopt(ws, findKit('ia-approval'), { cli: { argv: [process.execPath, CLI], version: '3.8.0' }, env });
  const wsFile = join(ws, '.ia', 'src', 'workspace.ia');
  const wsText = readFileSync(wsFile, 'utf8').replace(/systems \[([^\]]+)\]/, 'systems [$1, @system approval-system]');
  writeFileSync(wsFile, wsText);
  const wsId = `workspace-system/definition/workspace/${/^@workspace\s+([a-z0-9-]+)/m.exec(wsText)[1]}`;

  writeFileSync(
    join(ws, '.ia', 'src', 'records.ia'),
    `#! ia 1.0

@approver lead-approver
  meaning
    says "Primary approver."
    answers "Who ratifies?"
  person
    account "acct-lead"
    display "Operator A"
  authority
    workspaces ["${wsId}"]
  keys
    entries ["${keyEntryText({ keyId: rootKey.keyId, algorithm: 'ed25519', publicKey: rootKey.rawPublicKey, status: 'active', fromCommit: null })}"]

@decision tampered-decision
  meaning
    says "Edited after signing."
  work
    title "Edited decision"
    status made
  decision
    question "Edited?"
    decider "Operator A"
    choice "Edited"
    rationale "Trigger digest mismatch."
`,
  );

  // Seal with wrong (stale/tampered) recordDigest
  const bogusSeal = sealRecord({
    action: 'approve',
    organisation: wsId,
    workspace: wsId,
    record: { identity: 'work-system/definition/decision/tampered-decision', name: 'tampered-decision' },
    recordDigest: 'ff'.repeat(32),
    dependsOn: [],
    rules: [],
    revision: '00'.repeat(32),
    toolchain: { language: '3.2.0', systems: [] },
    baseCommit: '1'.repeat(40),
    signer: { account: 'acct-lead', display: 'Operator A' },
    key: rootKey,
    keyKind: 'service-held',
    via: 'desk',
    request: 'req-bad',
    signedAt: new Date('2026-11-18T00:00:00Z'),
  });
  mkdirSync(join(ws, APPROVALS_DIR), { recursive: true });
  writeFileSync(join(ws, bogusSeal.path), bogusSeal.source);

  const checkRun = spawnSync(
    process.execPath,
    [join(PLUGIN, 'scripts', 'check.mjs'), 'check-seal', '--kit', KIT_ID, '--root', ws, '--cli', CLI],
    { env, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(checkRun.status, 3, checkRun.stdout + checkRun.stderr);
});
