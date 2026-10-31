#!/usr/bin/env node
// Codex host smoke: real, opt-in loading of every plugin in .agents/plugins/marketplace.json by the Codex CLI given.
//
// Proves, with a fresh temporary CODEX_HOME:
// - tools/validate.py passes, and its per-plugin skill inventory equals each plugin's skills folder;
// - `codex plugin marketplace add <repo>` registers the catalogue and `codex plugin list --available` lists exactly its
//   plugins; `codex plugin add` installs each one inside the temporary home, and the installed CODEX.md and every
//   SKILL.md are byte-identical to plugins/<name>/;
// - a directly spawned stdio `codex app-server` (initialize, plugin/list, plugin/read, and skills/list from a separate
//   consumer directory) reports every plugin installed and enabled, every skill folder loaded from the installed cache
//   (Codex ignores disable-model-invocation), zero MCP servers and apps for every plugin, and zero hooks;
// - the installed core holds hooks/hooks.json, and its empty hook list shows its Codex manifest's `"hooks": {"hooks": {}}`
//   switched the Claude hooks off (decision public-core-hooks); no other installed copy has a hooks/ folder.
// Does not prove: any model turn or end-to-end skill workflow; a Git install from GitHub (the catalogue is added from
// this checkout); that a router skill triggers on the prompts meant for it; desktop UI installation; hook or agent
// behaviour in Codex. It uses no credentials, global install, trust grant or user config: Codex children get only OS
// variables, and the temporary directory is removed afterwards.
//
// Contracts: the OpenAI plugin packaging guide (https://developers.openai.com/plugins/build/plugins) for the catalogue
// and manifests, and `codex app-server generate-json-schema --experimental` for the initialize, plugin/list,
// plugin/read and skills/list request and response shapes. Neither is an official manifest JSON Schema check.
//
// Run from the repository root (Node >=22.22 <23, no dependencies; Python as $PYTHON, else `python` on PATH):
//   node tools/smoke-codex.mjs --codex <path-to-codex-executable> [--report <path>.json]
// Pass the executable itself, not a .cmd shim. The report carries no machine paths: the temporary home, the repository
// and the user's home read <codex-home>, <repo> and <home>. Re-run it after any manifest, skill, CODEX.md or Codex change.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The plugins that ship Claude Code hooks (decision public-core-hooks); their Codex manifests keep them off, except
// where CODEX_HOOK_FILES names a qualified file (none does).
const HOOKS_PLUGINS = new Set(['ia']);
const CODEX_HOOKS_OFF = { hooks: {} };
const CODEX_HOOK_FILES = {};
// What the repository's sensitive-bytes scanner refuses as a machine path; the report must carry none.
const MACHINE_PATH = /[a-z]:[\\/]+users[\\/]+|\/[a-z]\/users\/|\/users\/[a-z0-9._-]+\/|\/home\/[a-z0-9._-]+\/|appdata[\\/]/i;

let executable;
let reportPath;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--codex') executable = process.argv[++i];
  else if (arg === '--report') reportPath = resolve(process.argv[++i]);
  else throw new Error(`unknown option: ${arg}`);
}
assert(executable, '--codex <executable> is required');
assert(!/\.(?:cmd|bat|ps1)$/i.test(executable), '--codex needs the executable itself, not a shell shim');
// Codex children get OS runtime variables only. Do not inherit API keys or the user's config/auth.
const osEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|LANG)$/i.test(key)));
// The repository's own tools (validator, git) run as the developer would, with the inherited environment: stripped of
// LOCALAPPDATA, the Windows python.exe alias installs a fresh runtime under the current directory instead of running.
const python = process.env.PYTHON || 'python';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function run(file, args, env = process.env) {
  const result = spawnSync(file, args, { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${file} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
function isInside(root, path) {
  const rel = relative(realpathSync(root), realpathSync(path));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

// The repository's own contract first: never smoke a catalogue its validator refuses.
let validated, catalog;
try {
  validated = JSON.parse(run(python, ['tools/validate.py'], { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }));
  assert.equal(validated.status, 'passed', 'tools/validate.py did not pass');
  catalog = json(join(ROOT, '.agents/plugins/marketplace.json'));
} catch (error) { console.error(`Codex smoke refused before host loading: ${error.message}`); process.exit(1); }
assert.deepEqual(catalog.plugins.map(p => p.name).sort(), Object.keys(validated.skills).sort(), 'Codex catalog and validator name different plugins');
const inventory = catalog.plugins.map(entry => {
  assert.equal(entry.source?.source, 'local', `${entry.name}: not a local source`);
  const root = resolve(ROOT, entry.source.path);
  assert(isInside(ROOT, root), `${entry.name}: source escapes the repository`);
  const manifest = json(join(root, '.codex-plugin/plugin.json'));
  assert.equal(manifest.name, entry.name, `${entry.name}: Codex manifest identity`);
  const skillsRoot = resolve(root, manifest.skills);
  assert(isInside(root, skillsRoot), `${entry.name}: skills path escapes the plugin`);
  const skills = [...validated.skills[entry.name]].sort();
  const folders = readdirSync(skillsRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  assert.deepEqual(skills, folders, `${entry.name}: validator skills differ from the skills folder`);
  const hooks = HOOKS_PLUGINS.has(entry.name);
  assert.equal(existsSync(join(root, 'hooks')), hooks, `${entry.name}: source hooks/ folder ${hooks ? 'missing' : 'not admitted'}`);
  if (hooks) {
    assert(statSync(join(root, 'hooks/hooks.json')).isFile(), `${entry.name}: source hooks/hooks.json missing`);
    if (CODEX_HOOK_FILES[entry.name]) assert.equal(manifest.hooks, CODEX_HOOK_FILES[entry.name], `${entry.name}: Codex manifest must name its delivery hooks`);
    else assert.deepEqual(manifest.hooks, CODEX_HOOKS_OFF, `${entry.name}: Codex manifest must keep its hooks off`);
  }
  return { name: entry.name, root, skillsRoot, version: manifest.version, manifestHooks: manifest.hooks ?? null, manifestInterface: manifest.interface ?? null, skills, hooks };
});
const head = run('git', ['-C', ROOT, 'rev-parse', 'HEAD']).trim();
// --no-optional-locks: reading the status must not refresh (write) the index.
const changed = run('git', ['-C', ROOT, '--no-optional-locks', 'status', '--porcelain']).split('\n').filter(Boolean);

const scratch = mkdtempSync(join(tmpdir(), 'inventarch-smoke-'));
const home = join(scratch, 'codex-home');
const cwd = join(scratch, 'consumer');
mkdirSync(home); mkdirSync(cwd);
const env = { ...osEnv, CODEX_HOME: home, RUST_LOG: 'error' };
// Machine paths in host output become placeholders; the most specific root wins, in any separator or \\?\ form.
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const placeholders = [[home, '<codex-home>'], [cwd, '<consumer>'], [scratch, '<scratch>'], [ROOT, '<repo>'], [homedir(), '<home>']]
  .flatMap(([path, label]) => [...new Set([path, realpathSync.native(path)])].map(p => [p, label]))
  .sort((a, b) => b[0].length - a[0].length)
  .map(([path, label]) => [new RegExp(String.raw`(?:\\\\\?\\)?` + path.split(/[\\/]+/).map(escape).join(String.raw`[\\/]+`) + String.raw`(?![\w.~-])`, 'gi'), label]);
const scrub = text => placeholders.reduce((s, [pattern, label]) => s.replace(pattern, label), text)
  .replace(/(<(?:codex-home|consumer|scratch|repo|home)>)([^\s"']*)/g, (m, label, rest) => label + rest.replace(/\\/g, '/'));
const redact = value => typeof value === 'string' ? scrub(value) : Array.isArray(value) ? value.map(redact)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)])) : value;
function command(args, json = true) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return json ? JSON.parse(result.stdout) : result.stdout.trim();
}
function appServer() {
  const child = spawn(executable, ['app-server', '--stdio'], { cwd, env, windowsHide: true });
  const pending = new Map();
  let serial = 0, stderr = '';
  const rejectAll = error => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  };
  child.on('error', rejectAll);
  child.on('exit', code => rejectAll(new Error(`app-server exited ${code}: ${stderr.slice(-2000)}`)));
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { rejectAll(new Error('non-JSON app-server response')); return; }
    if (message.method && message.id !== undefined) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Smoke test refuses all server requests, including approvals.' } }) + '\n');
      rejectAll(new Error(`unexpected server request: ${message.method}`));
      return;
    }
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    if (message.error) p.reject(new Error(JSON.stringify(message.error)));
    else p.resolve(message.result);
  });
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`app-server timeout: ${method}`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    initialized() { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n'); },
    async close() {
      rejectAll(new Error('test finished'));
      lines.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close');
      const timer = setTimeout(() => child.kill(), 2000);
      child.stdin.end();
      await closed;
      clearTimeout(timer);
    },
  };
}

let host, report;
try {
  const cliVersion = command(['--version'], false);
  command(['plugin', 'marketplace', 'add', ROOT, '--json']);
  const available = command(['plugin', 'list', '--marketplace', catalog.name, '--available', '--json']);
  assert.deepEqual(available.available.map(p => p.name).sort(), inventory.map(p => p.name).sort());
  const installs = new Map();
  for (const plugin of inventory) {
    const install = command(['plugin', 'add', `${plugin.name}@${catalog.name}`, '--json']);
    const installed = install.installedPath;
    assert(isInside(home, installed), 'installation escaped isolated home');
    assert.equal(install.version, plugin.version, `${plugin.name}: installed version differs from the Codex manifest`);
    assert.equal(digest(join(installed, 'CODEX.md')), digest(join(plugin.root, 'CODEX.md')), `${plugin.name}: installed CODEX.md differs`);
    // Only the hook-shipping plugins carry hooks/hooks.json into the cache, so their empty hook lists below are the manifests' doing.
    if (plugin.hooks) {
      assert(existsSync(join(installed, 'hooks/hooks.json')), `${plugin.name}: installed copy lacks hooks/hooks.json, so zero hooks would prove nothing`);
      assert.equal(digest(join(installed, 'hooks/hooks.json')), digest(join(plugin.root, 'hooks/hooks.json')), `${plugin.name}: installed hooks.json differs`);
    } else assert(!existsSync(join(installed, 'hooks')), `${plugin.name}: installed copy has a hooks/ folder`);
    installs.set(plugin.name, install);
  }
  host = appServer();
  await host.request('initialize', { clientInfo: { name: 'inventarch-smoke', version: '1.0.0' }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } });
  host.initialized();
  const listed = await host.request('plugin/list', { cwds: [ROOT], marketplaceKinds: ['local'] });
  const marketplace = listed.marketplaces.find(m => m.name === catalog.name);
  assert(marketplace, 'marketplace missing from app-server');
  assert.equal(realpathSync(marketplace.path), realpathSync(join(ROOT, '.agents/plugins/marketplace.json')));
  const loaded = await host.request('skills/list', { cwds: [cwd], forceReload: true });
  assert(loaded.data.length > 0, 'no skill inventory from host');
  for (const data of loaded.data) assert.deepEqual(data.errors, [], 'host skill parser errors');
  const skills = loaded.data.flatMap(d => d.skills);
  const plugins = [];
  for (const plugin of inventory) {
    const detail = (await host.request('plugin/read', { marketplacePath: marketplace.path, pluginName: plugin.name })).plugin;
    assert(detail.summary.installed && detail.summary.enabled, `${plugin.name}: plugin is not active`);
    if (CODEX_HOOK_FILES[plugin.name]) {
      // plugin/read lists one entry per handler (codex-cli 0.162.0-alpha.17.2).
      const handlers = Object.values(json(join(plugin.root, CODEX_HOOK_FILES[plugin.name])).hooks).flat().flatMap(group => group.hooks).length;
      assert.equal(detail.hooks.length, handlers, `${plugin.name}: Codex lists ${detail.hooks.length} hooks; the delivery file has ${handlers} handlers`);
      assert(!JSON.stringify(detail.hooks).includes('hook.mjs'), `${plugin.name}: ledger hooks leaked into Codex`);
    } else assert.deepEqual(detail.hooks, [], `${plugin.name}: Claude hooks leaked into Codex`);
    assert.deepEqual(detail.mcpServers, [], `${plugin.name}: MCP servers reported`);
    assert.deepEqual(detail.apps, [], `${plugin.name}: apps reported`);
    const expected = plugin.skills.map(s => `${plugin.name}:${s}`).sort();
    assert.deepEqual(detail.skills.map(s => s.name).sort(), expected);
    const active = skills.filter(s => s.pluginId === `${plugin.name}@${catalog.name}`);
    assert.deepEqual(active.map(s => s.name).sort(), expected);
    const installed = installs.get(plugin.name).installedPath;
    for (const skill of active) {
      assert(skill.enabled && isInside(installed, skill.path), 'skill did not load from installed cache');
      const name = skill.name.slice(plugin.name.length + 1);
      assert.equal(digest(skill.path), digest(join(plugin.skillsRoot, name, 'SKILL.md')), `${skill.name}: installed SKILL.md differs`);
    }
    // Exactly what the host returned for the plugin's interface (null when absent), and whether it carries the manifest's fields.
    const hostInterface = detail.summary.interface ?? null;
    const listedInterface = marketplace.plugins?.find(p => p.name === plugin.name)?.interface ?? null;
    const interfaceMatchesManifest = hostInterface && plugin.manifestInterface ? Object.entries(plugin.manifestInterface).every(([k, v]) => hostInterface[k] === v) : null;
    // The catalogue's Codex manifest rule rests on Codex reading the interface block (decision public-codex-manifest-interface).
    assert.equal(interfaceMatchesManifest, true, `${plugin.name}: Codex did not return the manifest's interface fields`);
    plugins.push({
      name: plugin.name, version: plugin.version, installedPath: `<codex-home>/${relative(realpathSync(home), realpathSync(installed)).split(sep).join('/')}`,
      manifestSha256: digest(join(plugin.root, '.codex-plugin/plugin.json')), hostGuideSha256: digest(join(plugin.root, 'CODEX.md')),
      loadedSkillCount: active.length, skillNames: expected, hostInterface, listedInterface, interfaceMatchesManifest,
      manifestHooks: plugin.manifestHooks, installedHooksJson: existsSync(join(installed, 'hooks/hooks.json')),
      hooks: detail.hooks.length, mcpServers: detail.mcpServers.length, apps: detail.apps.length, installedCacheVerified: true,
    });
  }
  const totalLoadedSkills = plugins.reduce((n, p) => n + p.loadedSkillCount, 0);
  assert.equal(totalLoadedSkills, Object.values(validated.skills).flat().length, 'host loaded a different number of skills than the validator lists');
  report = redact({
    status: 'passed', checkedAt: new Date().toISOString(), cliVersion, cliSha256: existsSync(executable) ? digest(executable) : null, nodeVersion: process.version,
    repository: { head, dirty: changed.length > 0, changedEntries: changed.length }, validator: { command: 'python tools/validate.py', status: validated.status },
    marketplace: catalog.name, marketplaceInterface: marketplace.interface ?? null, plugins, totalLoadedSkills,
    isolation: 'Temporary CODEX_HOME; OS-only child environment; removed after run',
    verification: ['tools/validate.py passes and lists every skill folder', 'CLI marketplace discovery', 'CLI isolated installation', 'app-server plugin/list', 'app-server plugin/read', 'app-server skills/list from a separate consumer directory', 'installed skill and host-guide bytes match source', 'zero MCP servers, apps and hooks', 'the core hooks.json installed yet reported as zero hooks; no hooks/ folder elsewhere'],
    limitations: ['No model turn or end-to-end domain workflow', 'No Git install from GitHub', 'No router-trigger check', 'No desktop UI installation', 'No native registration of Claude agents or hooks'],
  });
  assert(!MACHINE_PATH.test(JSON.stringify(report)), 'report would carry a machine path');
} catch (error) { console.error(`Codex smoke failed: ${error.message}`); process.exitCode = 1; }
finally {
  if (host) await host.close();
  assert(isInside(tmpdir(), scratch), 'refusing cleanup outside temporary directory');
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
if (report && !process.exitCode) {
  if (reportPath) { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
}
