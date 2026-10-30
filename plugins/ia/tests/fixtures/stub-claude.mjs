// A stand-in for the claude host, for the trigger-eval runner's tests.
// --version answers a fixed version. Otherwise it reads the prompt from stdin
// and prints stream-json: an init event listing STUB_SKILL (unless STUB_UNLISTED
// is set), a Skill call when the prompt contains TRIGGER and the plugin dir's
// behavior.txt does not say "never", then a result event.
// STUB_MANIFEST names a file that must already exist, or the stub fails;
// STUB_FORBID names a directory the session's cwd must not be inside (exit 8);
// STUB_ERROR=1 ends with an is_error result; STUB_MAXTURNS=1 ends with an error_max_turns result;
// behavior.txt lines of the form "sleep: <text>" make the stub sleep 5 s on prompts containing <text>;
// behavior.txt lines of the form "skip: <text>" make the stub ignore prompts containing <text>.
// STUB_FAIL=1 exits 1 with no output; STUB_EXIT_WITH_RESULT=1 exits 1 after the result.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('stub-claude 1.2.3\n'); process.exit(0); }
if (process.env.STUB_MANIFEST && !existsSync(process.env.STUB_MANIFEST)) { process.stderr.write('no manifest before the first session\n'); process.exit(9); }
if (process.env.STUB_FORBID) { const cwd = resolve(process.cwd()), forbid = resolve(process.env.STUB_FORBID); if (cwd === forbid || cwd.startsWith(forbid + sep)) { process.stderr.write('session ran inside the workspace\n'); process.exit(8); } }
if (process.env.STUB_FAIL) process.exit(1);
const prompt = readFileSync(0, 'utf8');
const dir = args[args.indexOf('--plugin-dir') + 1];
const behavior = dir && existsSync(join(dir, 'behavior.txt')) ? readFileSync(join(dir, 'behavior.txt'), 'utf8') : '';
for (const l of behavior.split(String.fromCharCode(10))) if (l.startsWith('sleep:') && prompt.includes(l.slice(6).trim())) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
const skill = process.env.STUB_SKILL ?? 'p:s';
const events = [{ type: 'system', subtype: 'init', skills: process.env.STUB_UNLISTED ? [] : [skill] }];
if (prompt.includes('TRIGGER') && !behavior.includes('never') && !behavior.split('\n').some((l) => l.startsWith('skip:') && prompt.includes(l.slice(5).trim()))) events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });
events.push(process.env.STUB_ERROR ? { type: 'result', subtype: 'error_during_execution', is_error: true } : process.env.STUB_MAXTURNS ? { type: 'result', subtype: 'error_max_turns', is_error: true } : { type: 'result', subtype: 'success', is_error: false });
process.stdout.write(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
if (process.env.STUB_EXIT_WITH_RESULT) process.exit(1);
