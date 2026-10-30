import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { executeMethodProcess } from './method-process.mjs';

// Match the ordinary checker's former maxBuffer bound. Logs are local execution
// evidence, not a qualification seal or proof of complete suite coverage.
export const CHECK_OUTPUT_LIMIT = 64 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), { code: 'IA-CORE-CHECK-OUTPUT' }); };

function directoryPath(path) {
  if (!isAbsolute(path)) fail('Check output parent must be absolute');
  const absolute = resolve(path);
  for (let at = absolute; ; at = dirname(at)) {
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('Aliased, missing or non-directory check output parent');
    if (at === dirname(at)) break;
  }
  if (realpathSync(absolute) !== absolute) fail('Aliased check output parent');
  return absolute;
}

export function readRetainedCheckStream(directory, artifact, tailLength = 4000) {
  directoryPath(directory);
  if (!['stdout.bin', 'stderr.bin'].includes(artifact.name) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > CHECK_OUTPUT_LIMIT) fail('Invalid check output artifact');
  const path = join(directory, artifact.name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== artifact.bytes || realpathSync(path) !== path) fail('Aliased or changed check output artifact');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256'), decoder = new StringDecoder('utf8');
  let bytes = 0, textLength = 0, tail = '';
  const retain = text => { textLength += text.length; tail = (tail + text).slice(-tailLength); };
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== artifact.bytes) fail('Check output artifact changed while opening');
    const buffer = Buffer.alloc(64 * 1024);
    // Read at most the expected length plus one; concurrent growth cannot make
    // the evidence read unbounded, and every retained byte is rehashed.
    while (bytes <= artifact.bytes) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, artifact.bytes + 1 - bytes), null);
      if (!count) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
      retain(decoder.write(buffer.subarray(0, count)));
    }
    retain(decoder.end());
    const after = fstatSync(fd);
    if (bytes !== artifact.bytes || after.size !== bytes || after.nlink !== 1 || hash.digest('hex') !== artifact.sha256) fail('Check output artifact changed after execution');
  } finally { closeSync(fd); }
  directoryPath(directory);
  const after = lstatSync(path);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== bytes) fail('Check output artifact was replaced');
  return { tail, evidence: { path, bytes, sha256: artifact.sha256, tailTruncated: textLength > tailLength } };
}

export async function runOrdinaryCheck({ argv, cwd, timeoutSeconds, env }) {
  // Select the canonical OS temp directory, as the qualified checker does:
  // normal system aliases such as macOS /var do not alter the selected parent.
  // Validate that canonical parent and every fresh artifact path. mkdtemp creates
  // a private unique directory (0700 on POSIX); streams open wx/0600. No caller-
  // selected output file or directory flag is accepted.
  const directory = mkdtempSync(join(directoryPath(realpathSync(tmpdir())), 'ia-check-'));
  directoryPath(directory);
  const result = await executeMethodProcess({ argv, cwd, directory, timeoutSeconds, env, outputLimit: CHECK_OUTPUT_LIMIT });
  const stdout = readRetainedCheckStream(directory, result.artifacts.find(a => a.name === 'stdout.bin'), 4000);
  const stderr = readRetainedCheckStream(directory, result.artifacts.find(a => a.name === 'stderr.bin'), 2000);
  const complete = Number.isInteger(result.exitCode) && result.signal === null && !result.timedOut && !result.outputLimitExceeded && !result.terminationFailed;
  const { artifacts: _artifacts, ...outcome } = result;
  return { ...outcome, stdout: stdout.tail, stderr: stderr.tail,
    output: { format: 'inventarch.check-output/1', directory, complete, stdout: stdout.evidence, stderr: stderr.evidence, limitBytesPerStream: CHECK_OUTPUT_LIMIT },
    qualification: 'execution-evidence-only' };
}
