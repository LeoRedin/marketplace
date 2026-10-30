import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function processTool() {
  if (process.platform !== 'win32') return null;
  const path = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  for (let part = path; ; part = dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) throw new Error('Aliased process supervisor');
    if (dirname(part) === part) break;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || realpathSync(path) !== path) throw new Error('Invalid process supervisor');
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  const profile = JSON.parse(readFileSync(new URL('../../config/qualified-process-tools.json', import.meta.url), 'utf8'));
  if (profile.format !== 'inventarch.process-tools/1' || !profile.win32.taskkillSha256.includes(sha256)) throw new Error('Unqualified Windows process supervisor bytes');
  return { path, sha256 };
}

// macOS refuses to signal a group whose remaining members are unreaped zombies
// (EPERM), so retry boundedly. Resolves true when a member was signalled, false
// when the group is gone (ESRCH); rejects on any other error or lasting EPERM.
export async function killProcessGroup(pgid, { kill = (pid, signal) => process.kill(pid, signal), stepMs = 10, capMs = 1000 } = {}) {
  for (const deadline = Date.now() + capMs; ; await new Promise(resolve => setTimeout(resolve, stepMs))) {
    try { kill(-pgid, 'SIGKILL'); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code !== 'EPERM' || Date.now() >= deadline) throw error; }
  }
}

// A process group on POSIX, or the Windows process tree, is terminated before
// output handles are closed. These are cooperative limits, not an OS sandbox.
export async function executeMethodProcess({ argv, cwd, directory, timeoutSeconds, env, outputLimit = 16 * 1024 * 1024, processGroup = 'isolated', onTerminationDiagnostic }) {
  if (!['isolated', 'inherited'].includes(processGroup)) throw new Error('Invalid internal process-group mode');
  const taskkill = processTool();
  // Observer only: no receipt fields, raw process output or Error objects escape.
  const diagnostic = value => {
    if (typeof onTerminationDiagnostic !== 'function') return;
    try { onTerminationDiagnostic(Object.freeze(value)); } catch { /* Diagnostics cannot change termination. */ }
  };
  const code = value => typeof value === 'string' && /^[A-Z0-9_-]{1,64}$/.test(value) ? value : null;
  const output = value => Buffer.isBuffer(value) ? Object.freeze({ bytes: value.length, hashedBytes: Math.min(value.length, 65536), sha256: createHash('sha256').update(value.subarray(0, 65536)).digest('hex') }) : null;
  const streams = {};
  let timedOut = false, outputLimitExceeded = false, terminationFailed = false, descendantsTerminated = false, result;
  // An inherited abort kills the caller's whole group, so the caller must lead one.
  if (!taskkill && processGroup === 'inherited') { try { process.kill(-process.pid, 0); } catch { throw new Error('Inherited process-group mode requires the caller to lead its process group'); } }
  try {
    for (const name of ['stdout', 'stderr']) streams[name] = { fd: openSync(join(directory, `${name}.bin`), 'wx', 0o600), hash: createHash('sha256'), bytes: 0 };
    result = await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32' && processGroup === 'isolated', stdio: ['ignore', 'pipe', 'pipe'], env });
      let stopping = false, ioError;
      const kills = [], killGroup = (pgid, onLive) => kills.push(killProcessGroup(pgid).then(live => { if (live && onLive) onLive(); }, () => { terminationFailed = true; }));
      const terminate = () => {
        if (stopping) return;
        stopping = true;
        if (child.pid) {
          if (taskkill) {
            const started = performance.now();
            let phase = 'identity-recheck';
            try {
              if (processTool().sha256 !== taskkill.sha256) throw new Error('Process supervisor changed during execution');
              phase = 'taskkill';
              const killed = spawnSync(taskkill.path, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 65536 });
              terminationFailed = Boolean(killed.error || killed.status !== 0);
              diagnostic({ phase, pid: child.pid, status: Number.isInteger(killed.status) ? killed.status : null, signal: code(killed.signal), errorCode: code(killed.error?.code), durationMs: Math.max(0, Math.round(performance.now() - started)), failed: terminationFailed, stdout: output(killed.stdout), stderr: output(killed.stderr) });
            } catch (error) {
              terminationFailed = true;
              diagnostic({ phase, pid: child.pid, status: null, signal: null, errorCode: code(error?.code), durationMs: Math.max(0, Math.round(performance.now() - started)), failed: true, stdout: null, stderr: null });
            }
          } else {
            killGroup(processGroup === 'inherited' ? process.pid : child.pid);
          }
        }
        child.kill('SIGKILL');
        // Do not hang on a pipe held by an escaped descendant. Report failure.
        child.stdout.destroy(); child.stderr.destroy();
      };
      const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutSeconds * 1000);
      child.on('error', error => { terminate(); clearTimeout(timer); reject(error); });
      for (const name of ['stdout', 'stderr']) child[name].on('error', error => { ioError = error; terminate(); });
      for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
        if (stopping) return;
        const stream = streams[name];
        if (stream.bytes + chunk.length > outputLimit) { outputLimitExceeded = true; terminate(); return; }
        try {
          let offset = 0;
          while (offset < chunk.length) offset += writeSync(stream.fd, chunk, offset, chunk.length - offset);
          stream.hash.update(chunk); stream.bytes += chunk.length;
        } catch (error) { ioError = error; terminate(); }
      });
      // A descendant still alive at root exit is killed; its later output is not captured.
      child.on('exit', () => { if (!taskkill && processGroup === 'isolated' && child.pid) killGroup(child.pid, () => { descendantsTerminated = true; }); });
      child.on('close', (exitCode, signal) => { clearTimeout(timer); Promise.all(kills).then(() => { if (ioError) reject(ioError); else resolve({ exitCode, signal }); }); });
    });
  } finally { for (const stream of Object.values(streams)) closeSync(stream.fd); }
  const artifacts = Object.entries(streams).map(([name, stream]) => ({ name: `${name}.bin`, bytes: stream.bytes, sha256: stream.hash.digest('hex') }));
  return { ...result, timedOut, outputLimitExceeded, terminationFailed, descendantsTerminated, artifacts,
    supervisor: taskkill ? { kind: 'windows-taskkill', sha256: taskkill.sha256 } : { kind: 'node-posix-process-group' } };
}
