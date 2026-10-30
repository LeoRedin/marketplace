import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDesign, RESPONSE_LIMIT } from '../scripts/lib/design-client.mjs';

const digest = n => `sha256:${n.repeat(64)}`;
const kit = { id: 'inventarch/ux-kit', version: '0.1.0', digest: digest('a') };
const agent = { id: 'inventarch/design', version: '0.1.0', digest: digest('b') };
const renderer = { id: 'design', version: '1', inputSchema: 'inventarch.design-result@1' };
const pins = { expectedKit: kit, expectedAgent: agent };
const temp = mkdtempSync(join(tmpdir(), 'design-client-'));
after(() => rmSync(temp, { recursive: true, force: true }));
let bindingCount = 0;
const env = (origin, workspace = 'ws-1') => {
  const path = join(temp, `binding-${bindingCount++}.json`);
  writeFileSync(path, JSON.stringify({ format: 'inventarch-design-binding/1', apiOrigin: origin, workspace }));
  return { INVENTARCH_DESIGN_BINDING: path, INVENTARCH_API_ORIGIN: origin, INVENTARCH_ACCESS_TOKEN: 'a'.repeat(32), INVENTARCH_ALLOW_INSECURE_LOOPBACK: '1' };
};
const script = fileURLToPath(new URL('../scripts/design.mjs', import.meta.url));
const cli = (input, childEnv) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...childEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', reject);
  child.on('close', status => resolve({ status, stdout, stderr }));
  child.stdin.end(JSON.stringify(input));
});
const run = { id: 'run-1', workspace: 'ws-1', status: 'queued', result: null, renderer };
const success = { ...run, status: 'succeeded', result: JSON.stringify({ format: 'inventarch-design-result/1', kind: 'tokens', summary: 'Colors observed.', limitations: [], tokens: { primary: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.2, 0.3, 0.4] } } }, provenance: { workspace: 'ws-1', run: 'run-1', kit, agent } }) };
const discovery = { format: 'inventarch-design-discovery/1', kit, agent, capabilities: ['tokens', 'specification', 'audit'], renderer, runtime: { configured: true } };

async function fixture(handler, work) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: body && JSON.parse(body) });
    try { await handler(req, res, calls); } catch { res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await work(origin, calls); } finally { await new Promise(resolve => server.close(resolve)); }
}
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const execute = (input, origin, extra = {}) => executeDesign(input, { env: env(origin), ...extra });

test('catalog selects all four paired offerings and reuses one workspace', async () => {
  const pairs = [['ux', 'design'], ['ui', 'ui-design'], ['design', 'design-system'], ['brand', 'brand-design']];
  const offerings = pairs.map(([name, role]) => ({ ...discovery, kit: { ...kit, id: `inventarch/${name}-kit` }, agent: { ...agent, id: `inventarch/${role}` } }));
  await fixture((req, res, calls) => {
    if (req.url === '/v1/design/kits') return json(res, { format: 'inventarch-design-catalog/1', offerings });
    if (req.url.startsWith('/v1/design?kit=')) return json(res, offerings.find(item => item.kit.id === new URL(req.url, 'http://localhost').searchParams.get('kit')));
    const body = calls.at(-1).body;
    return json(res, { workspace: 'ws-1', kind: 'personal', kit: body.kit, agent: body.agent, adopted: true });
  }, async (origin, calls) => {
    assert.equal((await execute({ operation: 'catalog' }, origin)).offerings.length, 4);
    for (const item of offerings) {
      assert.deepEqual(await execute({ operation: 'discover', kit: item.kit.id }, origin), item);
      assert.equal((await execute({ operation: 'workspace', workspace: 'ws-1', expectedKit: item.kit, expectedAgent: item.agent }, origin)).workspace, 'ws-1');
    }
    const before = calls.length;
    await assert.rejects(execute({ operation: 'workspace', workspace: 'ws-1', expectedKit: offerings[0].kit, expectedAgent: offerings[1].agent }, origin), { code: 'invalid-pins' });
    assert.equal(calls.length, before);
  });
});

test('catalog refuses duplicate offerings and selected-kit substitution', async () => {
  await fixture((req, res) => json(res, req.url === '/v1/design/kits' ? { format: 'inventarch-design-catalog/1', offerings: Array(4).fill(discovery) } : discovery), async origin => {
    await assert.rejects(execute({ operation: 'catalog' }, origin), { code: 'invalid-discovery' });
    await assert.rejects(execute({ operation: 'discover', kit: 'inventarch/brand-kit' }, origin), { code: 'provenance-mismatch' });
  });
});

test('authorized HTTP journey validates pins, selection and final structured result', async () => {
  await fixture((req, res) => {
    if (req.url === '/v1/design') json(res, discovery);
    else if (req.url === '/v1/design/workspaces') json(res, { workspace: 'ws-1', kind: 'personal', kit, agent, adopted: true });
    else if (req.url === '/v1/agents?workspace=ws-1') json(res, { agents: [{ agent, discoverable: true, installed: true, authorized: true, compatible: true, ready: true, executable: true }] });
    else if (req.url === '/v1/agent-runs' && req.method === 'POST') json(res, run, 202);
    else if (req.url === '/v1/agent-runs/run-1' && req.method === 'GET') json(res, success);
    else if (req.url === '/v1/agent-runs/run-1/cancel') json(res, { ...run, status: 'cancelled' }, 202);
  }, async (origin, calls) => {
    assert.equal((await execute({ operation: 'discover', ...pins }, origin)).runtime.configured, true);
    assert.equal((await execute({ operation: 'workspace', ...pins }, origin)).workspace, 'ws-1');
    assert.equal((await execute({ operation: 'agents', workspace: 'ws-1', ...pins }, origin)).agent.executable, true);
    assert.equal((await execute({ operation: 'start', workspace: 'ws-1', idempotencyKey: 'key-1', kind: 'tokens', brief: 'Existing brand colors', ...pins }, origin)).status, 'queued');
    assert.equal((await execute({ operation: 'status', workspace: 'ws-1', run: 'run-1', expectedKind: 'tokens', ...pins }, origin)).result.tokens.primary.$value.components[0], 0.2);
    assert.equal((await execute({ operation: 'cancel', workspace: 'ws-1', run: 'run-1', expectedKind: 'tokens', ...pins }, origin)).status, 'cancelled');
    assert(calls.every(call => call.authorization === `Bearer ${'a'.repeat(32)}`));
    assert.deepEqual(calls[1].body, { kit, agent, workspace: 'ws-1' });
    assert.deepEqual(calls[3].body, { workspace: 'ws-1', idempotencyKey: 'key-1', command: JSON.stringify({ kind: 'tokens', brief: 'Existing brand colors' }), agent });
  });
});

test('bad input and missing configuration are refused before the network', async () => {
  let count = 0;
  const fetchImpl = async () => { count++; throw new Error('unexpected'); };
  const options = { env: env('https://api.example.test'), fetchImpl };
  for (const input of [null, { operation: 'unknown' }, { operation: 'start', workspace: '../secret', idempotencyKey: 'x', kind: 'tokens', brief: 'x', ...pins }, { operation: 'start', workspace: 'ws-1', idempotencyKey: '', kind: 'tokens', brief: 'x', ...pins }, { operation: 'status', workspace: 'ws-1', run: 'run-1', expectedKind: 'tokens', expectedKit: kit, expectedAgent: { ...agent, digest: 'bad' } }, { operation: 'status', workspace: 'ws-1', run: 'run-1', ...pins }]) await assert.rejects(executeDesign(input, options));
  assert.deepEqual(await executeDesign({ operation: 'discover' }, { env: {}, fetchImpl }), { route: 'native', reason: 'hosted-unconfigured' });
  for (const bad of ['http://example.test', 'https://api.example.test/path', 'https://user:pass@api.example.test', 'https://api.example.test/']) await assert.rejects(executeDesign({ operation: 'discover' }, { env: env(bad), fetchImpl }), { code: 'invalid-origin' });
  assert.equal(count, 0);
});

test('redirect, auth refusal, timeout and streamed response bound have fixed errors', async () => {
  await fixture((req, res) => req.url === '/v1/design' ? res.writeHead(302, { location: '/other' }).end() : json(res, discovery), async (origin, calls) => {
    await assert.rejects(execute({ operation: 'discover' }, origin), { code: 'transport-refused' });
    assert.deepEqual(calls.map(call => call.path), ['/v1/design']);
  });
  await fixture((req, res) => json(res, { secret: 'must-not-print' }, 403), async origin => {
    await assert.rejects(execute({ operation: 'discover' }, origin), { code: 'access-refused' });
  });
  await fixture((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.write('{"secret":"must-not-print"'); }, async origin => {
    await assert.rejects(execute({ operation: 'discover' }, origin, { timeoutMs: 100 }), { code: 'access-refused' });
  });
  await fixture(async () => { await new Promise(resolve => setTimeout(resolve, 100)); }, async origin => {
    await assert.rejects(execute({ operation: 'discover' }, origin, { timeoutMs: 10 }), { code: 'timeout' });
  });
  await fixture((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(' '.repeat(RESPONSE_LIMIT + 1)); }, async origin => {
    await assert.rejects(execute({ operation: 'discover' }, origin), { code: 'response-too-large' });
  });
});

test('discovery, workspace, agent and run provenance refusals', async () => {
  const cases = [
    [{ operation: 'discover', ...pins }, { ...discovery, kit: { ...kit, digest: digest('c') } }, 'provenance-mismatch'],
    [{ operation: 'workspace', ...pins }, { workspace: 'ws-1', kind: 'team', kit, agent, adopted: true }, 'provenance-mismatch'],
    [{ operation: 'agents', workspace: 'ws-1', ...pins }, { agents: [{ agent, discoverable: true, installed: true, authorized: true, compatible: true, ready: true, executable: false }] }, 'agent-unavailable'],
    [{ operation: 'status', workspace: 'ws-1', run: 'run-1', expectedKind: 'tokens', ...pins }, { ...run, workspace: 'ws-2' }, 'provenance-mismatch'],
    [{ operation: 'status', workspace: 'ws-1', run: 'run-1', expectedKind: 'tokens', ...pins }, { ...success, result: JSON.stringify({ ...JSON.parse(success.result), provenance: { ...JSON.parse(success.result).provenance, run: 'other' } }) }, 'invalid-result'],
    [{ operation: 'status', workspace: 'ws-1', run: 'run-1', expectedKind: 'tokens', ...pins }, { ...success, result: JSON.stringify({ ...JSON.parse(success.result), tokens: { primary: { $type: 'color', $value: { colorSpace: 'srgb', components: [2, 0, 0] } } } }) }, 'invalid-result'],
  ];
  for (const [input, response, code] of cases) await fixture((req, res) => json(res, response), async origin => { await assert.rejects(execute(input, origin), { code }); });
});

test('CLI redacts actual remote 403 and malformed 200 responses', async () => {
  for (const [status, body, code] of [[403, 'remote-secret-body', 'access-refused'], [200, '{remote-secret-body', 'invalid-response']]) {
    await fixture((req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); }, async (origin, calls) => {
      const childEnv = env(origin);
      const child = await cli({ operation: 'discover' }, childEnv);
      assert.equal(child.status, 1);
      const value = JSON.parse(child.stdout);
      assert.equal(value.error.code, code);
      assert.equal(typeof value.error.message, 'string');
      assert.equal(child.stderr, '');
      assert.equal(calls.length, 1);
      assert(!child.stdout.includes(body));
      assert(!child.stdout.includes(childEnv.INVENTARCH_ACCESS_TOKEN));
    });
  }
});

test('client enforces request size, result variants and strict successful schema', async () => {
  const script = fileURLToPath(new URL('../scripts/design.mjs', import.meta.url));
  const tooLarge = spawnSync(process.execPath, [script], { input: ' '.repeat(80_001), encoding: 'utf8' });
  assert.equal(tooLarge.status, 2);
  assert.equal(JSON.parse(tooLarge.stdout).error.code, 'input-too-large');
  const base = JSON.parse(success.result);
  const variants = [
    { ...base, kind: 'specification', specification: { title: 'Form', sections: [{ heading: 'Validation', body: 'Errors appear after submit.' }] } },
    { ...base, kind: 'audit', audit: { findings: [{ severity: 'major', evidence: 'No label', recommendation: 'Add a persistent label' }] } },
  ];
  for (const variant of variants) {
    delete variant.tokens;
    await fixture((req, res) => json(res, { ...success, result: JSON.stringify(variant) }), async origin => {
      assert.equal((await execute({ operation: 'status', workspace: 'ws-1', run: 'run-1', expectedKind: variant.kind, ...pins }, origin)).result.kind, variant.kind);
    });
  }
  await fixture((req, res) => json(res, { ...success, result: JSON.stringify({ ...base, unexpected: true }) }), async origin => {
    await assert.rejects(execute({ operation: 'status', workspace: 'ws-1', run: 'run-1', expectedKind: 'tokens', ...pins }, origin), { code: 'invalid-result' });
  });
});

test('queued tokens request refuses a later valid audit result', async () => {
  let polls = 0;
  const audit = JSON.parse(success.result);
  delete audit.tokens;
  audit.kind = 'audit';
  audit.audit = { findings: [] };
  await fixture((req, res) => {
    if (req.url === '/v1/agent-runs' && req.method === 'POST') json(res, run, 202);
    else if (req.url === '/v1/agent-runs/run-1') json(res, ++polls === 1 ? run : { ...success, result: JSON.stringify(audit) });
  }, async origin => {
    assert.equal((await execute({ operation: 'start', workspace: 'ws-1', idempotencyKey: 'key-1', kind: 'tokens', brief: 'Use supplied colors', ...pins }, origin)).status, 'queued');
    const status = { operation: 'status', workspace: 'ws-1', run: 'run-1', expectedKind: 'tokens', ...pins };
    assert.equal((await execute(status, origin)).status, 'queued');
    await assert.rejects(execute(status, origin), { code: 'invalid-result' });
  });
});


test('operator binding gates bearer destinations and workspace selection before network', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected network'); };
  const arbitraryEnv = { INVENTARCH_API_ORIGIN: 'https://untrusted.example', INVENTARCH_ACCESS_TOKEN: 'a'.repeat(32) };
  for (const operation of ['discover', 'catalog']) assert.deepEqual(await executeDesign({ operation }, { env: arbitraryEnv, fetchImpl }), { route: 'native', reason: 'hosted-unconfigured' });
  await assert.rejects(executeDesign({ operation: 'workspace', ...pins }, { env: arbitraryEnv, fetchImpl }), { code: 'hosted-unconfigured' });
  const trusted = env('https://approved.example');
  await assert.rejects(executeDesign({ operation: 'discover' }, { env: { ...trusted, INVENTARCH_API_ORIGIN: 'https://untrusted.example' }, fetchImpl }), { code: 'untrusted-origin' });
  await assert.rejects(executeDesign({ operation: 'workspace', workspace: 'ws-2', ...pins }, { env: trusted, fetchImpl }), { code: 'workspace-binding-mismatch' });
  await assert.rejects(executeDesign({ operation: 'discover' }, { env: { ...trusted, INVENTARCH_DESIGN_BINDING: 'relative.json' }, fetchImpl }), { code: 'invalid-binding' });
  const loopback = env('http://127.0.0.1:1');
  delete loopback.INVENTARCH_ALLOW_INSECURE_LOOPBACK;
  await assert.rejects(executeDesign({ operation: 'discover' }, { env: loopback, fetchImpl }), { code: 'invalid-origin' });
  await assert.rejects(executeDesign({ operation: 'status', workspace: 'ws-1', run: 'run-1', expectedKind: 'tokens', ...pins }, { env: env('https://approved.example', null), fetchImpl }), { code: 'workspace-binding-required' });
  for (const field of ['version', 'digest']) for (const invalid of [1, null, ['0.1.0']]) {
    await assert.rejects(executeDesign({ operation: 'workspace', ...pins, expectedKit: { ...kit, [field]: invalid } }, { env: trusted, fetchImpl }), { code: 'invalid-pins' });
  }
  assert.equal(calls, 0);
});

test('explicit unbound workspace creation requires operator binding update before agents', async () => {
  await fixture((req, res) => json(res, { workspace: 'ws-new', kind: 'personal', kit, agent, adopted: true }), async (origin, calls) => {
    const options = { env: env(origin, null) };
    assert.equal((await executeDesign({ operation: 'workspace', ...pins }, options)).workspace, 'ws-new');
    assert.deepEqual(calls[0].body, { kit, agent });
    await assert.rejects(executeDesign({ operation: 'agents', workspace: 'ws-new', ...pins }, options), { code: 'workspace-binding-required' });
    assert.equal(calls.length, 1);
  });
});

test('service status distinctions use fixed safe codes', async () => {
  for (const [status, code] of [[400, 'request-refused'], [404, 'not-found'], [409, 'conflict'], [429, 'rate-limited'], [500, 'service-unavailable'], [503, 'service-unavailable']]) {
    await fixture((req, res) => json(res, { error: 'remote-secret' }, status), async origin => {
      await assert.rejects(execute({ operation: 'discover' }, origin), { code, message: code });
    });
  }
});

test('unconfigured remote discovery retains explicit native routing signal', async () => {
  await fixture((req, res) => json(res, { ...discovery, runtime: { configured: false } }), async origin => {
    assert.equal((await execute({ operation: 'discover' }, origin)).runtime.configured, false);
  });
});


test('CLI malformed input is a usage error with one safe envelope', () => {
  const child = spawnSync(process.execPath, [script], { input: '{broken-secret', encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.deepEqual(JSON.parse(child.stdout), { error: { code: 'invalid-json', message: 'Input must be valid JSON.' } });
  assert.equal(child.stderr, '');
});

test('valid binding files within repositories and worktrees are refused', async () => {
  for (const markerKind of ['directory', 'file']) {
    const repo = mkdtempSync(join(temp, 'repository-'));
    const marker = join(repo, '.git');
    if (markerKind === 'directory') mkdirSync(marker);
    else writeFileSync(marker, 'gitdir: ../worktree-metadata');
    const bindingPath = join(repo, 'binding.json');
    writeFileSync(bindingPath, JSON.stringify({ format: 'inventarch-design-binding/1', apiOrigin: 'https://approved.example', workspace: 'ws-1' }));
    let calls = 0;
    const options = {
      env: { ...env('https://approved.example'), INVENTARCH_DESIGN_BINDING: bindingPath },
      fetchImpl: async () => {
        calls++;
        return new Response(JSON.stringify(discovery), { headers: { 'content-type': 'application/json' } });
      },
    };
    await assert.rejects(executeDesign({ operation: 'discover' }, options), { code: 'invalid-binding' });
    assert.equal(calls, 0);
  }
});

test('explicit HTTPS operator binding authorizes only its selected origin', async () => {
  const configured = env('https://approved.example');
  delete configured.INVENTARCH_API_ORIGIN;
  let calls = 0;
  const value = await executeDesign({ operation: 'discover' }, { env: configured, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://approved.example/v1/design');
    assert.equal(options.headers.authorization, `Bearer ${configured.INVENTARCH_ACCESS_TOKEN}`);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(discovery), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(value, discovery);
  assert.equal(calls, 1);
});
