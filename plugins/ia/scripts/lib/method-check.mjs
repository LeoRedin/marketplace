import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { loadMethodClosure, loadQualifiedMethodClosure } from './method-closure.mjs';
import { attestRuntime } from './closure-runtime.mjs';
import { resolveConsumerSubject } from './closure-native.mjs';
import { assembleMethodPacket } from './method-packet.mjs';
import { readMethodPin } from './method-pin.mjs';
import { canonicalMethod, methodDigest, methodError } from './method-json.mjs';
import { executorProfile, executorSubjectsChanged, prepareExecutor } from './closure-executors.mjs';
import { childEnv } from './hygiene.mjs';
import { executeMethodProcess } from './method-process.mjs';
import { copyWorkspace } from './scratch.mjs';
import { snapshotInventory } from './method-subject.mjs';

const fail = message => { throw methodError(message, 'IA-CORE-CHECK-UNAVAILABLE'); };

// Execute only retained, reviewed profiles against a captured native subject.
// No shell, mutable kit selection or caller-controlled executable is admitted.
export async function runMethodCheck({ input, activityKey, pinRoot, workspaceRoot, cli, storeRoot, artifactRoot, processGroup = 'isolated' }) {
  if (!input || Object.keys(input).some(key => !['pinRevision', 'closureSha256', 'checkId', 'arguments', 'subjectRevision'].includes(key))) fail('Unknown method check input');
  const pin = readMethodPin(pinRoot);
  if (!pin || pin.revision !== input.pinRevision) fail('Method check requires the current pinned revision');
  if (pin.workspace.repositoryRoot && pin.workspace.repositoryRoot !== realpathSync(workspaceRoot)) fail('Method pin belongs to a different repository');
  const activity = pin.keys[activityKey];
  if (!activity || pin.kits[activity.kit].closureSha256 !== input.closureSha256) fail('Check does not match the pinned activity closure');
  const closure = await loadQualifiedMethodClosure(input.closureSha256, { storeRoot, cli });
  const runtime = await attestRuntime(cli);
  if (canonicalMethod(runtime.identity) !== canonicalMethod(closure.manifest.runtimeIdentity)) fail('Selected runtime differs from retained qualification');
  const before = await resolveConsumerSubject({ root: workspaceRoot, workspaceIdentity: pin.workspace.identity, importNative: runtime.importNative });
  if (before.revision !== input.subjectRevision || before.revision !== pin.workspace.revision) fail('Consumer subject changed; resolve a new pinned revision');
  const packet = assembleMethodPacket({ closure, subject: before, capability: activity.capability, profile: activity.profile, pinRevision: pin.revision });
  if (packet.executionState === 'inspection-only' || !packet.requiredChecks.some(row => row.id === input.checkId)) fail('Check is not required by the selected executable capability');
  const check = closure.manifest.checks.find(row => row.id === input.checkId);
  const parent = artifactRoot === undefined ? realpathSync(tmpdir()) : resolve(artifactRoot);
  for (let at = parent; ; at = dirname(at)) {
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('Aliased or non-directory artifact parent');
    if (at === dirname(at)) break;
  }
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'method-check-'));
  const profile = check.executable === 'node' ? executorProfile(check.profile) : null;
  const limit = profile?.outputLimitBytes ?? 16 * 1024 * 1024;
  if (!Number.isInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) fail('Invalid reviewed output limit');
  const started = Date.now();
  const executionRoot = join(directory, 'subject');
  mkdirSync(executionRoot);
  copyWorkspace(workspaceRoot, executionRoot);
  const captured = await resolveConsumerSubject({ root: executionRoot, workspaceIdentity: pin.workspace.identity, importNative: runtime.importNative });
  if (captured.revision !== before.revision) fail('Consumer changed during execution snapshot capture');
  const snapshot = snapshotInventory(executionRoot);
  writeFileSync(join(directory, 'subject-inventory.json'), canonicalMethod(snapshot.files) + '\n', { flag: 'wx', mode: 0o600 });
  const execution = prepareExecutor({ check, closure, workspaceRoot: executionRoot, inputRoot: workspaceRoot, cli, arguments: input.arguments, directory });
  const result = await executeMethodProcess({ ...execution, directory, processGroup, timeoutSeconds: check.timeoutSeconds, outputLimit: limit,
    env: childEnv(process.env, { IA_CLI_PATH: cli.argv[1], IA_METHOD_CLI: cli.argv[1], IA_CORE_NO_NPX: '1', IA_CLI_NO_NPX: '1', IA_METHOD_NO_NPX: '1' }) });
  const after = await resolveConsumerSubject({ root: workspaceRoot, workspaceIdentity: pin.workspace.identity, importNative: runtime.importNative });
  loadMethodClosure(input.closureSha256, { storeRoot });
  let pinChanged = true;
  try { pinChanged = canonicalMethod(readMethodPin(pinRoot)) !== canonicalMethod(pin); } catch { /* Retain execution evidence, but never current success. */ }
  const { artifacts, ...outcome } = result;
  const inputsChanged = executorSubjectsChanged(workspaceRoot, execution.subjects, directory);
  const executionSnapshotChanged = snapshotInventory(executionRoot).sha256 !== snapshot.sha256;
  const body = {
    format: 'inventarch.method-check/1', closureSha256: input.closureSha256, pinRevision: pin.revision,
    check: { id: check.id, identity: check.record }, argvSha256: methodDigest(execution.argv), scriptHelperDigests: execution.scriptHelperDigests,
    subjectInputs: execution.subjects, inputsChanged,
    executionSnapshot: { revision: captured.revision, filesSha256: snapshot.sha256, fileCount: snapshot.files.length, artifact: 'subject-inventory.json' }, executionSnapshotChanged,
    native: runtime.identity, subject: { nativeWorkspaceIdentity: before.identity, before: before.revision, after: after.revision },
    ...outcome, pinChanged, subjectChanged: before.revision !== after.revision || inputsChanged || executionSnapshotChanged,
    outputArtifactSha256: methodDigest(artifacts), artifacts,
    durationMs: Date.now() - started,
    limits: { timeoutSeconds: check.timeoutSeconds, stdoutBytes: limit, stderrBytes: limit, shell: false, processTreeTermination: true, subjectFileBytes: profile?.inputLimitBytes ?? 16 * 1024 * 1024 },
    qualification: 'execution-evidence-only',
  };
  return { receipt: { ...body, receiptSha256: methodDigest(body) }, artifactDirectory: directory };
}
