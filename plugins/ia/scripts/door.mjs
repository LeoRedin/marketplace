#!/usr/bin/env node
// The IA door launcher (decision public-door-mcp): the plugin's .mcp.json runs
// `node "${CLAUDE_PLUGIN_ROOT}/scripts/door.mjs"`, and this starts
// `npx -y @inventarch/mcp-door@<pin>` with stdin, stdout and stderr passed
// through untouched, so the MCP stream is the door's own. The pin is the
// plugin's IA pin (lib/cli.mjs PINNED, which tools/consistency.py holds to
// sources.lock.json's released CLI). Never a shell: on Windows npx is a .cmd
// shim that Node starts only through cmd.exe, so there, as lib/cli.mjs does,
// the launcher runs npm's npx-cli.js (next to the running node) with this
// node, and refuses when it is not there; elsewhere it prefers the same
// script and falls back to npx on PATH. IA_CORE_NPX_CLI names another
// npx-cli.js (tests). IA_KITS_DIR passes through (the .mcp.json sets it to the
// bundled kits; without it the launcher sets the same), with the rest of the
// environment. The launcher exits with the door's exit code, forwards SIGINT
// and SIGTERM to it, and exits 1 if the door cannot start.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { npxCli, PINNED } from './lib/cli.mjs';

export const DOOR_PACKAGE = '@inventarch/mcp-door';
const PLUGIN = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');

// The child to spawn: { command, args, options }, or { error } when it cannot start.
export function doorCommand({ platform = process.platform, version = PINNED, env = process.env, plugin = PLUGIN, execPath = process.execPath, npxScript } = {}) {
  const tail = ['-y', `${DOOR_PACKAGE}@${version}`];
  const childEnv = { ...env, IA_KITS_DIR: env.IA_KITS_DIR || `${plugin}/config/kits` };
  const options = { stdio: 'inherit', env: childEnv, windowsHide: true };
  const script = npxScript !== undefined ? npxScript : (env.IA_CORE_NPX_CLI || npxCli(execPath));
  if (script) return { command: execPath, args: [script, ...tail], options };
  if (platform === 'win32') return { error: `npm's npx-cli.js is not next to ${execPath}, and npx on Windows is a .cmd shim this launcher never runs through a shell; install npm beside node or set IA_CORE_NPX_CLI` };
  return { command: 'npx', args: tail, options };
}

function main() {
  const door = doorCommand();
  if (door.error) {
    process.stderr.write(`ia door: ${door.error}\n`);
    process.exit(1);
  }
  const child = spawn(door.command, door.args, door.options);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { try { child.kill(signal); } catch { /* already gone */ } });
  child.on('error', error => {
    process.stderr.write(`ia door: could not start ${door.command} ${door.args.join(' ')}: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) main();
