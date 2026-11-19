import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { findKit } from './kit.mjs';
import { attestRuntime } from './closure-runtime.mjs';
import { resolveConsumerSubject } from './closure-native.mjs';
import { createMethodClosure, loadQualifiedMethodClosure } from './method-closure.mjs';
import { assembleMethodPacket } from './method-packet.mjs';
import { selectMethodPosition } from './method-position.mjs';
import { readMethodPin, previewMethodRebind, writeMethodPin } from './method-pin.mjs';
import { canonicalMethod, methodError } from './method-json.mjs';
import { identityOf } from './records.mjs';

const fail = (message, code = 'IA-CORE-CLOSURE-UNSUPPORTED') => { throw methodError(message, code); };
function qualification(path) {
  if (!path) return {};
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('Qualification must be a bounded regular JSON file');
  const contract = JSON.parse(readFileSync(path, 'utf8'));
  if (contract.format !== 'inventarch.method-qualification/1' || Object.keys(contract).some(key => !['format', 'workspaceContracts', 'capabilityContracts', 'executionContracts'].includes(key))) fail('Unsupported qualification contract');
  return contract;
}

export async function resolveQualifiedMethod({ binding, activityKey, workspaceRoot, cli, pinRoot, options = {}, storeRoot }) {
  if (!workspaceRoot) fail('Complete method packets require a consumer native workspace');
  const previous = pinRoot ? readMethodPin(pinRoot, { allowLegacy: Boolean(options.rebind) }) : null;
  if (previous?.format === 4 && options.seat && options.seat !== previous.workspace.identity) fail('A task cannot silently change its selected native composition', 'IA-CORE-PIN-CONFLICT');
  const runtime = await attestRuntime(cli);
  const subject = await resolveConsumerSubject({ root: workspaceRoot, workspaceIdentity: options.seat ?? (previous?.format === 4 ? previous.workspace.identity : undefined), importNative: runtime.importNative });
  const repositoryRoot = realpathSync(workspaceRoot);
  if (previous?.format === 4 && previous.workspace.repositoryRoot && previous.workspace.repositoryRoot !== repositoryRoot) fail('Pin belongs to a different repository', 'IA-CORE-PIN-CONFLICT');
  if (previous && previous.format !== 4 && !options.rebind) fail('Legacy pin needs explicit rebind');
  if (previous && previous.format !== 4) {
    const legacyKeys = previous.format === 1 ? [`${previous.intent?.entry}.${previous.intent?.activity}`] : Object.keys(previous.keys ?? {});
    if (legacyKeys.some(key => key !== activityKey)) fail('Legacy pin contains other activities; migrate all of them together before rebinding this task', 'IA-CORE-REBIND-REQUIRED');
  }
  const old = previous?.format === 4 ? previous : null;
  const key = old?.keys[activityKey];
  const capability = identityOf('capability', binding.capability), profile = binding.profile ? identityOf('agent-profile', binding.profile) : null;
  if (key && !options.rebind && (key.kit !== binding.kit || key.capability !== capability || key.profile !== profile)) fail('Binding changed; preview and explicitly rebind', 'IA-CORE-REBIND-REQUIRED');
  if (options.rebind && options['no-pin']) fail('Rebind must persist a new pin revision');
  let selector;
  const validate = async closure => {
    if (canonicalMethod(closure.manifest.runtimeIdentity) !== canonicalMethod(runtime.identity)) fail('Retained method runtime differs from selected runtime');
    selector = await selectMethodPosition({ closure, capability, activityKey, shape: options.shape, phase: options.phase, cli, importNative: runtime.importNative, workspaceIdentity: subject.identity });
    assembleMethodPacket({ closure, subject, capability, profile, selector });
    for (const [otherKey, row] of Object.entries(old?.keys ?? {})) {
      if (options.rebind && otherKey !== activityKey && row.kit === binding.kit) assembleMethodPacket({ closure, subject, capability: row.capability, profile: row.profile });
    }
  };
  let closure;
  if (old?.kits[binding.kit] && !options.rebind) {
    closure = await loadQualifiedMethodClosure(old.kits[binding.kit].closureSha256, { storeRoot, cli });
    await validate(closure);
  } else {
    const contract = qualification(options.qualification);
    closure = await createMethodClosure({ kit: findKit(binding.kit), cli, storeRoot,
      workspaceContracts: contract.workspaceContracts, capabilityContracts: contract.capabilityContracts,
      executionContracts: contract.executionContracts, validateBeforePublish: validate });
    await validate(closure);
  }
  const preview = options.rebind ? previewMethodRebind(old, binding.kit, closure.manifest.closureSha256) : null;
  // Rebind preview is explicit: it never mutates the pin. A subsequent rebind
  // resolves again and CAS still checks the current revision.
  if (options['preview-rebind']) return { format: 'inventarch.method-rebind-preview/1', preview };
  let pin = old;
  if (pinRoot && !options['no-pin']) {
    const kits = { ...(old?.kits ?? {}), [binding.kit]: { ...closure.manifest.kit, closureSha256: closure.manifest.closureSha256 } };
    const keys = { ...(old?.keys ?? {}), [activityKey]: { kit: binding.kit, capability, profile } };
    const state = { workspace: { identity: subject.identity, revision: subject.revision, repositoryRoot }, kits, keys, task: options.task ?? previous?.task ?? null };
    pin = writeMethodPin(pinRoot, state, previous?.revision ?? null, { allowLegacyRebind: Boolean(options.rebind) });
  }
  return assembleMethodPacket({ closure, subject, capability, profile, selector, pinRevision: pin?.revision ?? null });
}
