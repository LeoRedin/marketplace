// The session-start account offer and governance probe (decisions
// public-account-offer and public-governance-probe). Both read local files and
// the environment only: no network, no token, nothing written.
//
// The account offer runs at session startup only (a resume or a clear never
// repeats it), so it appears once per session. It is suppressed by
// "accountOffer": false in <IA home>/config.json, by IA_NO_ACCOUNT_OFFER=1, and
// by a non-empty CI. An account counts as present when a design binding is set
// in the environment (INVENTARCH_DESIGN_BINDING) or the host already lists an
// inventarch MCP server in its documented local configuration: Claude Code's
// <config dir>/.claude.json (user and per-project servers) or the
// repository's .mcp.json, or Codex's <CODEX_HOME>/config.toml.
//
// The governance probe: a repository with .ia/governance.json is governed;
// when the InventArch governance plugin is not installed for Claude Code, the
// session says so once, at startup, and never pretends it is ungoverned.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { iaHome } from './home.mjs';

export const MCP_URL = 'https://api.inventarch.dev/mcp';
export const GOVERNANCE_PLUGIN = 'inventarch-governance';

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const readText = path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

const claudeDir = (env, home) => env.CLAUDE_CONFIG_DIR || join(home, '.claude');
const claudeJson = (env, home) => (env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json'));
const codexHome = (env, home) => env.CODEX_HOME || join(home, '.codex');

// An MCP server entry that is InventArch's: named inventarch, or pointing at the InventArch MCP URL.
const isInventarch = (name, server) => name.toLowerCase() === 'inventarch' || (typeof server?.url === 'string' && server.url.replace(/\/+$/, '').toLowerCase() === MCP_URL);
const listsInventarch = servers => Boolean(servers && typeof servers === 'object' && Object.entries(servers).some(([name, server]) => isInventarch(name, server)));
const sameFolder = (a, b) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function offerDisabled(env = process.env) {
  if (env.IA_NO_ACCOUNT_OFFER === '1' || (env.CI ?? '') !== '') return true;
  let home;
  try { home = iaHome(env); } catch { return false; }
  return readJson(join(home, 'config.json'))?.accountOffer === false;
}

// Where an account was found, or null.
export function accountFound({ env = process.env, home = homedir(), cwd = process.cwd(), repo = null } = {}) {
  if (env.INVENTARCH_DESIGN_BINDING) return 'INVENTARCH_DESIGN_BINDING';
  const user = readJson(claudeJson(env, home));
  if (listsInventarch(user?.mcpServers)) return 'claude user mcpServers';
  for (const [folder, project] of Object.entries(user?.projects ?? {})) {
    if ((sameFolder(folder, cwd) || (repo && sameFolder(folder, repo))) && listsInventarch(project?.mcpServers)) return 'claude project mcpServers';
  }
  for (const root of [repo, cwd].filter(Boolean)) if (listsInventarch(readJson(join(root, '.mcp.json'))?.mcpServers)) return '.mcp.json';
  if (/^\s*\[mcp_servers\.(?:"inventarch"|inventarch)\]\s*$/m.test(readText(join(codexHome(env, home), 'config.toml')))) return 'codex config.toml';
  return null;
}

// The one-line offer, or null when it does not apply.
export function accountOffer({ env = process.env, source, home = homedir(), cwd = process.cwd(), repo = null } = {}) {
  if (source !== 'startup' || offerDisabled(env) || accountFound({ env, home, cwd, repo })) return null;
  return `InventArch: no account is connected. To use the subscription kits, add the InventArch MCP server to your host (Claude Code: claude mcp add --transport http inventarch ${MCP_URL}); the host signs you in. To stop this offer, set "accountOffer": false in ~/.ia/config.json or IA_NO_ACCOUNT_OFFER=1.`;
}

// Is the governance plugin installed for Claude Code (any scope)?
export function governanceInstalled({ env = process.env, home = homedir() } = {}) {
  const installed = readJson(join(claudeDir(env, home), 'plugins', 'installed_plugins.json'));
  return Object.keys(installed?.plugins ?? {}).some(key => key.split('@')[0] === GOVERNANCE_PLUGIN);
}

// The governance notice for a workspace root, or null.
export function governanceNotice({ env = process.env, source, home = homedir(), root } = {}) {
  if (source !== 'startup' || !root || !existsSync(join(root, '.ia', 'governance.json')) || governanceInstalled({ env, home })) return null;
  return 'InventArch: this repository is governed (.ia/governance.json), and the InventArch governance plugin is not installed. Governed work needs that plugin, available with an InventArch subscription; until it is installed, say so before changing anything here and do not treat the repository as ungoverned.';
}
