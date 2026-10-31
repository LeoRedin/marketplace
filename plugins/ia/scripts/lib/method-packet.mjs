import { SHAPES, PHASES } from './workspace.mjs';
import { canonicalMethod, isDigest, methodDigest, methodError, safeMethodPath } from './method-json.mjs';

const fail = (message, code = 'IA-CORE-COMPOSITION-MISSING') => { throw methodError(message, code); };
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const field = (record, section, key) => record.sections?.find(row => row.name === section)?.fields?.find(row => row.key === key)?.value;

// This assembler accepts only a verified retained closure from its caller.
// Production entry points must load by digest, never accept a graph from JSON.
// Host authority and workspace boundary decisions stay with the host; this
// packet carries no authorization assertion and is not a start grant.
export function assembleMethodPacket({ closure, subject, capability: identity, profile: selectedProfile = null, pinRevision = null, selector = null }) {
  const { manifest, graph } = closure;
  if (manifest?.format !== 'inventarch.method-closure/1' || !isDigest(manifest.closureSha256)) fail('A complete verified closure is required', 'IA-CORE-CLOSURE-UNSUPPORTED');
  if (!subject || typeof subject.identity !== 'string' || !subject.identity.startsWith('workspace-system/definition/workspace/') || !isDigest(subject.revision)) fail('An admitted consumer native workspace is required');
  if (pinRevision !== null && (!Number.isSafeInteger(pinRevision) || pinRevision < 1)) fail('Invalid pin revision');
  const capability = manifest.capabilities.find(row => row.identity === identity);
  if (!capability) fail(`Capability is not retained: ${identity}`);
  const records = new Map(graph.records.map(record => [record.identity, record]));
  const get = id => {
    const record = records.get(id);
    if (!record || !isDigest(record.digest) || !safeMethodPath(record.source?.path)
      || !manifest.files.some(file => file.path === record.source.path)) fail(`Required retained record is unavailable: ${id}`);
    return record;
  };
  const reference = id => {
    const record = get(id);
    return { identity: id, sourcePath: record.source.path, digest: record.digest };
  };
  const nativeReference = value => {
    if (!value || !['ref', 'identity'].includes(value.kind)) fail('Malformed composition reference');
    const matches = graph.records.filter(record => value.kind === 'identity'
      ? record.identity === (value.identity ?? value.text)
      : record.discriminator === value.discriminator && record.name === value.name);
    if (matches.length !== 1) fail('Required composition reference is missing or ambiguous');
    return matches[0].identity;
  };
  const capRecord = get(identity);
  const profiles = graph.records.filter(record => record.discriminator === 'agent-profile' && (field(record, 'composition', 'capabilities')?.items ?? []).some(value => nativeReference(value) === identity)).map(record => record.identity).sort(order);
  if (selectedProfile && !profiles.includes(selectedProfile)) fail(`Profile does not compose capability: ${selectedProfile}`);
  if (!selectedProfile && profiles.length > 1) fail('Select one composing agent profile', 'IA-CORE-PROFILE-AMBIGUOUS');
  const profile = selectedProfile ?? profiles[0] ?? null;
  const references = [reference(capRecord.identity)];
  if (profile) {
    const record = get(profile);
    references.push(reference(profile));
    const mandate = field(record, 'composition', 'mandate');
    if (mandate) references.push(reference(nativeReference(mandate)));
  }
  if (!Array.isArray(subject.systems) || !subject.systems.some(row => row.identity === capability.authoringSystem)) fail('Consumer composition does not use the capability authoring system');
  for (const system of manifest.systems ?? []) {
    const selected = subject.systems.find(row => row.identity === system.identity);
    if (selected && selected.revision !== system.revision) fail(`Consumer system differs from retained method: ${system.identity}`);
  }
  if (selector !== null) {
    validateSelector(selector);
    if (selector.methodRevision !== graph.revision) fail('Position belongs to another method revision');
    const own = capability.playbooks.flatMap(id => (get(id).cells ?? []).map(cell => `${id}#${cell.phase}/${cell.primitive}`));
    if (selector.addresses.some(address => !own.includes(address))) fail('Position selected a foreign or missing cell');
    if (selector.mode !== 'position' && capability.mode !== 'inspection-only' && canonicalMethod([...new Set(own)].sort(order)) !== canonicalMethod(selector.addresses)) fail('Whole-procedure selection is incomplete');
    if (selector.mode === 'position' && capability.mode !== 'inspection-only' && own.length && !selector.addresses.length) fail('Position selection is empty');
  }
  const instructions = [], requiredChecks = [];
  if (capability.mode === 'executable') {
    for (const id of capability.playbooks) {
      const record = get(id);
      if (!record.cells?.length) fail(`Required playbook has no cells: ${id}`);
      references.push(reference(id));
      for (const cell of record.cells) {
        const text = cell.body ?? cell.text;
        if (typeof text !== 'string' || !text.length || typeof cell.phase !== 'string' || typeof cell.primitive !== 'string') fail(`Required playbook cell is unreadable: ${id}`);
        const address = `${id}#${cell.phase}/${cell.primitive}`;
        if (selector === null || selector.addresses.includes(address)) instructions.push({ ...reference(id), address, text });
      }
    }
    for (const id of capability.checks) {
      const check = manifest.checks.find(row => row.record === id);
      if (!check) fail(`Required check has no retained runner: ${id}`, 'IA-CORE-CHECK-UNAVAILABLE');
      requiredChecks.push({ id: check.id, ...reference(id) });
    }
    if (!instructions.length && !requiredChecks.length) fail('Executable capability has empty composition');
  } else if (capability.mode !== 'inspection-only') fail('Unknown capability execution mode', 'IA-CORE-CLOSURE-UNSUPPORTED');
  const packet = {
    format: 'inventarch.method-packet/2', pinRevision, closureSha256: manifest.closureSha256,
    capability: identity, profile, selector,
    subject: { nativeWorkspaceIdentity: subject.identity, revision: subject.revision },
    instructions, references: [...new Map(references.map(row => [row.identity, row])).values()].sort((a, b) => order(a.identity, b.identity)),
    requiredChecks: requiredChecks.sort((a, b) => order(a.identity, b.identity)),
    executionState: capability.mode === 'inspection-only' ? 'inspection-only' : 'authority-required',
    limits: { packetBytes: 4 * 1024 * 1024, authorization: 'consumer-boundary-and-current-host-authority-required' },
  };
  const result = { ...packet, packetSha256: methodDigest(packet) };
  if (Buffer.byteLength(canonicalMethod(result)) > packet.limits.packetBytes) fail('Packet resource limit exceeded', 'IA-CORE-CLOSURE-UNSUPPORTED');
  return result;
}

export function verifyMethodPacket(packet) {
  if (packet?.format !== 'inventarch.method-packet/2' || !isDigest(packet.packetSha256)) fail('Unsupported packet', 'IA-CORE-CLOSURE-UNSUPPORTED');
  const keys = ['format', 'pinRevision', 'closureSha256', 'capability', 'profile', 'selector', 'subject', 'instructions', 'references', 'requiredChecks', 'executionState', 'limits', 'packetSha256'];
  if (Object.keys(packet).length !== keys.length || keys.some(key => !Object.hasOwn(packet, key))
    || !isDigest(packet.closureSha256) || typeof packet.capability !== 'string' || !packet.capability.startsWith('agent-composition-system/definition/capability/')
    || (packet.profile !== null && (typeof packet.profile !== 'string' || !packet.profile.startsWith('agent-composition-system/binding/agent-profile/')))
    || (packet.pinRevision !== null && (!Number.isSafeInteger(packet.pinRevision) || packet.pinRevision < 1))
    || typeof packet.subject?.nativeWorkspaceIdentity !== 'string' || !packet.subject.nativeWorkspaceIdentity.startsWith('workspace-system/definition/workspace/') || !isDigest(packet.subject.revision)
    || !['instructions', 'references', 'requiredChecks'].every(key => Array.isArray(packet[key]))
    || packet.limits?.packetBytes !== 4 * 1024 * 1024 || packet.limits.authorization !== 'consumer-boundary-and-current-host-authority-required') fail('Incomplete or unsupported packet contract', 'IA-CORE-CLOSURE-UNSUPPORTED');
  if (packet.selector !== null) validateSelector(packet.selector);
  for (const row of [...packet.instructions, ...packet.references, ...packet.requiredChecks]) {
    if (typeof row?.identity !== 'string' || !row.identity.includes('/') || !isDigest(row.digest) || !safeMethodPath(row.sourcePath)) fail('Packet reference lacks retained provenance');
  }
  if (packet.instructions.some(row => typeof row.text !== 'string' || !row.text || typeof row.address !== 'string')
    || packet.requiredChecks.some(row => typeof row.id !== 'string' || !row.id)
    || (packet.executionState === 'inspection-only' && (packet.instructions.length || packet.requiredChecks.length))) fail('Packet execution composition is invalid');
  if (packet.selector !== null && canonicalMethod([...new Set(packet.instructions.map(row => row.address))].sort(order)) !== canonicalMethod(packet.selector.addresses)) fail('Packet instructions differ from its position selector');
  const { packetSha256, ...body } = packet;
  if (methodDigest(body) !== packetSha256 || Buffer.byteLength(canonicalMethod(packet)) > 4 * 1024 * 1024) fail('Packet integrity or resource failure', 'IA-CORE-CLOSURE-INTEGRITY');
  if (!['inspection-only', 'authority-required'].includes(packet.executionState)) fail('Unsupported execution state', 'IA-CORE-CLOSURE-UNSUPPORTED');
  return packet;
}


function validateSelector(selector) {
  const keys = ['shape', 'phase', 'mode', 'methodRevision', 'addresses'];
  if (!selector || Object.keys(selector).length !== keys.length || keys.some(key => !Object.hasOwn(selector, key)) || !SHAPES.includes(selector.shape) || !PHASES.includes(selector.phase) || !['position', 'whole-procedure', 'empty-position-fallback'].includes(selector.mode) || !isDigest(selector.methodRevision) || !Array.isArray(selector.addresses) || selector.addresses.some(address => typeof address !== 'string') || canonicalMethod([...new Set(selector.addresses)].sort(order)) !== canonicalMethod(selector.addresses)) fail('Invalid method position selector');
}
