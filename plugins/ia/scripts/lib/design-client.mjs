import { readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, dirname, join } from 'node:path';
// Draft thin client. Only this module knows the remote wire format.
export const INPUT_LIMIT = 80_000;
export const RESPONSE_LIMIT = 100_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+){0,2}$/;
const STATES = new Set(['queued', 'running', 'waiting-approval', 'succeeded', 'failed', 'cancelled', 'needs-recovery']);
const OFFERINGS = new Map([['inventarch/ux-kit','inventarch/design'], ['inventarch/ui-kit','inventarch/ui-design'], ['inventarch/design-kit','inventarch/design-system'], ['inventarch/brand-kit','inventarch/brand-design']]);
const KINDS = new Set(['tokens', 'specification', 'audit']);

export class DesignClientError extends Error {
  constructor(code) { super(code); this.name = 'DesignClientError'; this.code = code; }
}
const fail = code => { throw new DesignClientError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required, optional = []) => object(value) && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
const id = value => typeof value === 'string' && ID.test(value) && !value.split('/').some(part => part === '.' || part === '..' || part === '');
const pin = value => keys(value, ['id', 'version', 'digest']) && id(value.id) && typeof value.version === 'string' && VERSION.test(value.version) && typeof value.digest === 'string' && DIGEST.test(value.digest);
const same = (a, b) => pin(a) && pin(b) && a.id === b.id && a.version === b.version && a.digest === b.digest;
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8000;
const list = (value, max, predicate) => Array.isArray(value) && value.length <= max && value.every(predicate);
const finite = Number.isFinite;

function origin(value, allowLoopback) {
  if (typeof value !== 'string' || value.length > 2048) fail('invalid-origin');
  let url;
  try { url = new URL(value); } catch { fail('invalid-origin'); }
  if (url.origin !== value || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('invalid-origin');
  if (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail('invalid-origin');
  return url.origin;
}
function config(env, input) {
  const bindingPath = env.INVENTARCH_DESIGN_BINDING;
  if (!bindingPath) {
    if (['discover', 'catalog'].includes(input.operation)) return null;
    fail('hosted-unconfigured');
  }
  if (typeof bindingPath !== 'string' || !isAbsolute(bindingPath)) fail('invalid-binding');
  let binding;
  try {
    const resolved = realpathSync(bindingPath);
    // The operator selects this file. Repository content cannot supply trust.
    for (let dir = dirname(resolved); ; dir = dirname(dir)) {
      if (existsSync(join(dir, '.git'))) fail('invalid-binding');
      if (dirname(dir) === dir) break;
    }
    if (!statSync(resolved).isFile() || statSync(resolved).size > 8192) fail('invalid-binding');
    binding = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch { fail('invalid-binding'); }
  if (!keys(binding, ['format', 'apiOrigin', 'workspace']) || binding.format !== 'inventarch-design-binding/1' || !(binding.workspace === null || id(binding.workspace))) fail('invalid-binding');
  const base = origin(binding.apiOrigin, env.INVENTARCH_ALLOW_INSECURE_LOOPBACK === '1');
  if (env.INVENTARCH_API_ORIGIN !== undefined && env.INVENTARCH_API_ORIGIN !== base) fail('untrusted-origin');
  if (!['discover', 'catalog', 'workspace'].includes(input.operation) && binding.workspace === null) fail('workspace-binding-required');
  if (input.workspace !== undefined && input.workspace !== binding.workspace) fail('workspace-binding-mismatch');
  if (input.operation === 'workspace' && binding.workspace !== null) input.workspace = binding.workspace;
  const token = env.INVENTARCH_ACCESS_TOKEN;
  if (typeof token !== 'string' || token.length < 16 || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) fail('missing-token');
  return { base, token };
}
function expected(value) {
  if (!pin(value?.expectedKit) || !pin(value?.expectedAgent)) fail('invalid-pins');
  if (OFFERINGS.get(value.expectedKit.id) !== value.expectedAgent.id) fail('invalid-pins');
}
function validateRequest(value) {
  if (!object(value) || typeof value.operation !== 'string') fail('invalid-input');
  const shape = {
    catalog: [['operation'], []],
    discover: [['operation'], ['expectedKit', 'expectedAgent', 'kit']],
    workspace: [['operation', 'expectedKit', 'expectedAgent'], ['workspace']],
    agents: [['operation', 'workspace', 'expectedKit', 'expectedAgent'], []],
    start: [['operation', 'workspace', 'expectedKit', 'expectedAgent', 'idempotencyKey', 'kind', 'brief'], []],
    status: [['operation', 'workspace', 'run', 'expectedKind', 'expectedKit', 'expectedAgent'], []],
    cancel: [['operation', 'workspace', 'run', 'expectedKind', 'expectedKit', 'expectedAgent'], []],
  }[value.operation];
  if (!shape || !keys(value, ...shape)) fail('invalid-input');
  if (value.operation === 'catalog') return value;
  if (value.operation === 'discover') {
    if (Object.hasOwn(value, 'kit') && !OFFERINGS.has(value.kit)) fail('invalid-pins');
    if (value.kit && value.expectedKit && value.kit !== value.expectedKit.id) fail('invalid-pins');
    if (Object.hasOwn(value, 'expectedKit') !== Object.hasOwn(value, 'expectedAgent')) fail('invalid-pins');
    if (value.expectedKit) expected(value);
  } else expected(value);
  if (Object.hasOwn(value, 'workspace') && !id(value.workspace)) fail('invalid-workspace');
  if (Object.hasOwn(value, 'run') && !id(value.run)) fail('invalid-run');
  if (Object.hasOwn(value, 'expectedKind') && !KINDS.has(value.expectedKind)) fail('invalid-input');
  if (value.operation === 'start' && (!id(value.idempotencyKey) || !KINDS.has(value.kind) || !text(value.brief) || value.brief.length > 16_000)) fail('invalid-input');
  return value;
}

async function readBounded(response) {
  if (!response.body) fail('invalid-response');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT) { await reader.cancel().catch(() => {}); fail('response-too-large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); } catch { fail('invalid-response'); }
}
async function request(base, token, path, method, data, fetchImpl, timeoutMs) {
  const body = data === undefined ? undefined : JSON.stringify(data);
  if (body && Buffer.byteLength(body) > INPUT_LIMIT) fail('input-too-large');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}${path}`, { method, redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      fail(status === 400 ? 'request-refused' : status === 401 || status === 403 ? 'access-refused' : status === 404 ? 'not-found' : status === 409 ? 'conflict' : status === 429 ? 'rate-limited' : status >= 500 ? 'service-unavailable' : 'service-refused');
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail('invalid-response');
    return await readBounded(response);
  } catch (error) {
    if (error instanceof DesignClientError) throw error;
    fail(controller.signal.aborted ? 'timeout' : 'transport-refused');
  } finally { clearTimeout(timer); }
}

function discovery(value, pins) {
  if (!keys(value, ['format', 'kit', 'agent', 'capabilities', 'renderer', 'runtime']) || value.format !== 'inventarch-design-discovery/1' || !pin(value.kit) || !pin(value.agent) || OFFERINGS.get(value.kit.id) !== value.agent.id || !keys(value.renderer, ['id', 'version', 'inputSchema']) || value.renderer.id !== 'design' || value.renderer.version !== '1' || value.renderer.inputSchema !== 'inventarch.design-result@1' || !keys(value.runtime, ['configured']) || typeof value.runtime.configured !== 'boolean' || !list(value.capabilities, 3, v => KINDS.has(v)) || value.capabilities.length !== 3 || new Set(value.capabilities).size !== 3) fail('invalid-discovery');
  if (pins.kit && value.kit.id !== pins.kit) fail('provenance-mismatch');
  if (pins.expectedKit && (!same(value.kit, pins.expectedKit) || !same(value.agent, pins.expectedAgent))) fail('provenance-mismatch');
  return value;
}
function workspace(value, input) {
  if (!keys(value, ['workspace', 'kind', 'kit', 'agent', 'adopted']) || !id(value.workspace) || !['personal', 'employee-private'].includes(value.kind) || value.adopted !== true || !same(value.kit, input.expectedKit) || !same(value.agent, input.expectedAgent) || (input.workspace && value.workspace !== input.workspace)) fail('provenance-mismatch');
  return value;
}
function agents(value, input) {
  if (!keys(value, ['agents']) || !list(value.agents, 128, item => keys(item, ['agent', 'discoverable', 'installed', 'authorized', 'compatible', 'ready', 'executable']) && pin(item.agent) && item.discoverable === true && ['installed', 'authorized', 'ready', 'executable'].every(k => typeof item[k] === 'boolean') && (item.compatible === null || typeof item.compatible === 'boolean'))) fail('invalid-agents');
  const match = value.agents.find(item => same(item.agent, input.expectedAgent));
  if (!match || !match.installed || !match.authorized || !match.compatible || !match.ready || !match.executable) fail('agent-unavailable');
  return { agent: match };
}
function token(value) {
  if (!keys(value, ['$type', '$value'])) return false;
  const v = value.$value;
  if (value.$type === 'color') return keys(v, ['colorSpace', 'components'], ['alpha']) && v.colorSpace === 'srgb' && Array.isArray(v.components) && v.components.length === 3 && v.components.every(n => finite(n) && n >= 0 && n <= 1) && (!Object.hasOwn(v, 'alpha') || finite(v.alpha) && v.alpha >= 0 && v.alpha <= 1);
  if (value.$type === 'dimension') return keys(v, ['value', 'unit']) && finite(v.value) && ['px', 'rem'].includes(v.unit);
  if (value.$type === 'number') return finite(v);
  if (value.$type === 'fontFamily') return typeof v === 'string' ? v.length > 0 && v.length <= 200 : list(v, 10, s => typeof s === 'string' && s.length > 0 && s.length <= 200) && v.length > 0;
  return false;
}
function result(value, input, run) {
  if (!object(value) || !KINDS.has(value.kind) || value.format !== 'inventarch-design-result/1' || !text(value.summary) || !list(value.limitations, 20, text) || !keys(value.provenance, ['workspace', 'run', 'kit', 'agent']) || value.provenance.workspace !== input.workspace || value.provenance.run !== run || !same(value.provenance.kit, input.expectedKit) || !same(value.provenance.agent, input.expectedAgent)) fail('invalid-result');
  const common = ['format', 'kind', 'summary', 'limitations', 'provenance'];
  if (value.kind === 'tokens') {
    if (!keys(value, [...common, 'tokens']) || !object(value.tokens) || Object.keys(value.tokens).length < 1 || Object.keys(value.tokens).length > 128 || !Object.entries(value.tokens).every(([name, v]) => /^[a-z][a-z0-9-]{0,79}$/.test(name) && token(v))) fail('invalid-result');
  } else if (value.kind === 'specification') {
    if (!keys(value, [...common, 'specification']) || !keys(value.specification, ['title', 'sections']) || !text(value.specification.title) || !list(value.specification.sections, 30, s => keys(s, ['heading', 'body']) && text(s.heading) && text(s.body)) || value.specification.sections.length < 1) fail('invalid-result');
  } else if (!keys(value, [...common, 'audit']) || !keys(value.audit, ['findings']) || !list(value.audit.findings, 50, f => keys(f, ['severity', 'evidence', 'recommendation']) && ['critical', 'major', 'minor'].includes(f.severity) && text(f.evidence) && text(f.recommendation))) fail('invalid-result');
  return value;
}
function runView(value, input, requestedRun) {
  if (!keys(value, ['id', 'workspace', 'status', 'result', 'renderer']) || !id(value.id) || value.workspace !== input.workspace || requestedRun && value.id !== requestedRun || !STATES.has(value.status)) fail('provenance-mismatch');
  if (!keys(value.renderer, ['id', 'version', 'inputSchema']) || value.renderer.id !== 'design' || value.renderer.version !== '1' || value.renderer.inputSchema !== 'inventarch.design-result@1') fail('provenance-mismatch');
  if (value.status === 'succeeded') {
    if (typeof value.result !== 'string' || Buffer.byteLength(value.result) > 65_536) fail('invalid-result');
    let parsed;
    try { parsed = JSON.parse(value.result); } catch { fail('invalid-result'); }
    const validated = result(parsed, input, value.id);
    if (validated.kind !== (input.expectedKind ?? input.kind)) fail('invalid-result');
    return { id: value.id, workspace: value.workspace, status: value.status, renderer: value.renderer, result: validated };
  }
  if (value.result !== null) fail('invalid-result');
  return { id: value.id, workspace: value.workspace, status: value.status, renderer: value.renderer, result: null };
}

export async function executeDesign(input, { env = process.env, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  input = { ...validateRequest(input) };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('invalid-timeout');
  const configured = config(env, input);
  if (!configured) return { route: 'native', reason: 'hosted-unconfigured' };
  const { base, token } = configured;
  const call = (path, method = 'GET', data) => request(base, token, path, method, data, fetchImpl, timeoutMs);
  if (input.operation === 'catalog') {
    const value = await call('/v1/design/kits');
    if (!keys(value, ['format', 'offerings']) || value.format !== 'inventarch-design-catalog/1' || !list(value.offerings, 4, object) || value.offerings.length !== 4) fail('invalid-discovery');
    const offerings = value.offerings.map(item => discovery(item, {}));
    if (new Set(offerings.map(item => item.kit.id)).size !== 4) fail('invalid-discovery');
    return { format: value.format, offerings };
  }
  if (input.operation === 'discover') return discovery(await call('/v1/design' + (input.kit || (input.expectedKit && input.expectedKit.id !== 'inventarch/ux-kit') ? `?kit=${encodeURIComponent(input.kit ?? input.expectedKit.id)}` : '')), input);
  if (input.operation === 'workspace') return workspace(await call('/v1/design/workspaces', 'POST', { kit: input.expectedKit, agent: input.expectedAgent, ...(input.workspace ? { workspace: input.workspace } : {}) }), input);
  if (input.operation === 'agents') return agents(await call(`/v1/agents?workspace=${encodeURIComponent(input.workspace)}`), input);
  if (input.operation === 'start') return runView(await call('/v1/agent-runs', 'POST', { workspace: input.workspace, idempotencyKey: input.idempotencyKey, command: JSON.stringify({ kind: input.kind, brief: input.brief }), agent: input.expectedAgent }), input);
  if (input.operation === 'status') return runView(await call(`/v1/agent-runs/${encodeURIComponent(input.run)}`), input, input.run);
  return runView(await call(`/v1/agent-runs/${encodeURIComponent(input.run)}/cancel`, 'POST'), input, input.run);
}
