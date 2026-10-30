// Kit handlers (contract C2, decision public-kit-handlers): scripts/handlers.mjs
// runs the session, prompt, tool and stop handlers installed kits declare in
// handlers.json, merges their additionalContext with a cap per kit, honours a
// pre block only in a workspace with .ia/governance.json, and is a silent
// no-op when no kit declares a handler. The governance probe asks whether an
// installed kit declares governance handlers.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { governanceNotice } from '../scripts/lib/account.mjs';
import { declaresGovernance, handlerKits, KIT_CONTEXT_CAP, kitHandlers } from '../scripts/lib/handlers.mjs';
import { findKit } from '../scripts/lib/kit.mjs';
import { kitProblems } from '../scripts/lib/kit-ops.mjs';
import { envFor, fakeCli, makeKit, makeRepo, run, sandbox } from './helpers/fixtures.mjs';

// A handler script: echoes what it saw as additionalContext, or answers `answer`.
const ECHO = `import { readFileSync } from 'node:fs';
const hook = JSON.parse(readFileSync(0, 'utf8') || '{}');
const seen = { event: hook.hook_event_name, source: hook.source ?? null, tool: hook.tool_name ?? null, kit: process.env.IA_KIT_ROOT ? 'set' : 'unset', workspace: process.env.IA_WORKSPACE_ROOT || '', home: process.env.IA_HOME ? 'set' : 'unset' };
process.stdout.write(JSON.stringify(process.env.HANDLER_ANSWER ? JSON.parse(process.env.HANDLER_ANSWER) : { additionalContext: 'saw ' + JSON.stringify(seen) }) + '\\n');
`;

// A kit carrying handlers.json and the scripts it names, declared as assets.
function handlerKit(kitsDir, folder, handlers, scripts = { 'scripts/echo.mjs': ECHO }) {
  const { dir } = makeKit(kitsDir, { folder, id: `inventarch/${folder}-kit` });
  for (const [rel, text] of Object.entries(scripts)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  writeFileSync(join(dir, 'handlers.json'), JSON.stringify({ format: 1, ...handlers }, null, 2) + '\n');
  return dir;
}

function setup(t) {
  const dir = sandbox(t, 'ia-core-handlers-');
  const kitsDir = join(dir, 'kits');
  mkdirSync(kitsDir);
  const repo = makeRepo(dir);
  const env = envFor({ cli: fakeCli(dir), kitsDir, temp: join(dir, 'temp'), extra: { IA_HOME: join(dir, 'home') } });
  const hook = (event, input) => run('handlers.mjs', [event], env, { input: JSON.stringify({ cwd: repo, ...input }) });
  return { dir, kitsDir, repo, env, hook };
}

test('kitHandlers reads a well-formed handlers.json and refuses a malformed one', t => {
  const { kitsDir } = setup(t);
  const dir = handlerKit(kitsDir, 'good', {
    session: [{ run: 'scripts/echo.mjs', events: ['compact'] }], prompt: [{ run: 'scripts/echo.mjs', timeout: 5 }],
    tool: [{ run: 'scripts/echo.mjs', phase: 'pre', match: 'Write|Edit' }, { run: 'scripts/echo.mjs', phase: 'post' }], stop: [{ run: 'scripts/echo.mjs' }],
  });
  const read = kitHandlers({ dir });
  assert.deepEqual(read.session, [{ run: 'scripts/echo.mjs', timeout: 20, events: ['compact'] }]);
  assert.deepEqual(read.prompt, [{ run: 'scripts/echo.mjs', timeout: 5 }]);
  assert.deepEqual(read.tool.map(h => [h.phase, h.match, h.timeout]), [['pre', 'Write|Edit', 20], ['post', null, 20]]);
  assert.deepEqual(read.stop, [{ run: 'scripts/echo.mjs', timeout: 20 }]);
  for (const [bad, message] of [
    [{ format: 2 }, /format 1/],
    [{ format: 1, session: [{ run: '../escape.mjs' }] }, /inside the kit/],
    [{ format: 1, session: [{ run: 'scripts/echo.sh' }] }, /\.mjs script/],
    [{ format: 1, tool: [{ run: 'scripts/echo.mjs' }] }, /phase is pre or post/],
    [{ format: 1, prompt: [{ run: 'scripts/echo.mjs', timeout: 60 }] }, /timeout/],
    [{ format: 1, session: [{ run: 'scripts/echo.mjs', events: ['fork'] }] }, /events/],
    [{ format: 1, notify: [] }, /unknown key notify/],
    [{ format: 1, prompt: [{ run: 'scripts/echo.mjs', argv: ['x'] }] }, /unknown key argv/],
  ]) {
    writeFileSync(join(dir, 'handlers.json'), JSON.stringify(bad));
    assert.throws(() => kitHandlers({ dir }), message, JSON.stringify(bad));
  }
});

test('with no kit declaring a handler every event is a silent no-op', t => {
  const { kitsDir, hook } = setup(t);
  makeKit(kitsDir, { folder: 'plain', id: 'inventarch/plain-kit' });
  for (const [event, input] of [['session', { source: 'startup' }], ['prompt', { prompt: 'hi' }], ['pre', { tool_name: 'Write', tool_input: {} }], ['post', { tool_name: 'Write', tool_input: { file_path: 'a.md' } }], ['stop', {}], ['unknown', {}]]) {
    const ran = hook(event, { hook_event_name: event, ...input });
    assert.equal(ran.status, 0, event);
    assert.equal(ran.stdout, '', `${event} prints nothing`);
  }
});

test('a session handler runs for its events only, with the kit, workspace and home in its environment', t => {
  const { kitsDir, repo, hook } = setup(t);
  handlerKit(kitsDir, 'sess', { session: [{ run: 'scripts/echo.mjs', events: ['startup', 'compact'] }] });
  const started = hook('session', { hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(started.json.hookSpecificOutput.hookEventName, 'SessionStart');
  const text = started.json.hookSpecificOutput.additionalContext;
  assert.match(text, /^inventarch\/sess-kit: saw /);
  const seen = JSON.parse(text.slice(text.indexOf('{')));
  assert.deepEqual(seen, { event: 'SessionStart', source: 'compact', tool: null, kit: 'set', workspace: repo, home: 'set' });
  assert.equal(hook('session', { hook_event_name: 'SessionStart', source: 'resume' }).stdout, '', 'resume is not one of its events');
});

test('prompt and stop handlers add context; a stop already continuing adds none', t => {
  const { kitsDir, hook } = setup(t);
  handlerKit(kitsDir, 'turns', { prompt: [{ run: 'scripts/echo.mjs' }], stop: [{ run: 'scripts/echo.mjs' }] });
  assert.equal(hook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x' }).json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(hook('stop', { hook_event_name: 'Stop', stop_hook_active: false }).json.hookSpecificOutput.hookEventName, 'Stop');
  assert.equal(hook('stop', { hook_event_name: 'Stop', stop_hook_active: true }).stdout, '');
});

test('every kit\'s context is merged, each capped at its own limit', t => {
  const { kitsDir, env, repo } = setup(t);
  const long = `process.stdout.write(JSON.stringify({ additionalContext: 'x'.repeat(${KIT_CONTEXT_CAP * 2}) }));`;
  handlerKit(kitsDir, 'aaa', { prompt: [{ run: 'scripts/long.mjs' }] }, { 'scripts/long.mjs': long });
  handlerKit(kitsDir, 'bbb', { prompt: [{ run: 'scripts/echo.mjs' }] });
  const ran = run('handlers.mjs', ['prompt'], env, { input: JSON.stringify({ cwd: repo, hook_event_name: 'UserPromptSubmit' }) });
  const [first, second] = ran.json.hookSpecificOutput.additionalContext.split('\n\n');
  assert.equal(first.length, KIT_CONTEXT_CAP);
  assert.match(first, /^inventarch\/aaa-kit: x+ \[truncated\]$/);
  assert.match(second, /^inventarch\/bbb-kit: saw /);
});

test('a pre handler blocks only in a workspace opted in through .ia/governance.json, and only for its tools', t => {
  const { kitsDir, env, repo, hook } = setup(t);
  handlerKit(kitsDir, 'gate', { tool: [{ run: 'scripts/echo.mjs', phase: 'pre', match: 'Write|Edit' }] });
  const blocking = { ...env, HANDLER_ANSWER: JSON.stringify({ decision: 'block', reason: 'no ledger entry for this change' }) };
  const pre = (tool, e = blocking) => run('handlers.mjs', ['pre'], e, { input: JSON.stringify({ cwd: repo, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} }) });
  const open = pre('Write');
  assert.equal(open.json.hookSpecificOutput.permissionDecision, undefined, 'not governed: not blocked');
  assert.match(open.json.hookSpecificOutput.additionalContext, /asked to block this tool call: no ledger entry for this change; not applied/);
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const governed = pre('Write');
  assert.deepEqual(governed.json.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'inventarch/gate-kit: no ledger entry for this change' });
  assert.equal(pre('Bash').stdout, '', 'Bash does not match Write|Edit');
  assert.equal(hook('post', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {} }).stdout, '', 'a pre handler is not a post handler');
});

test('a handler whose script the kit does not hold never runs (a fetched release carries no executables)', t => {
  const { kitsDir, hook } = setup(t);
  const dir = handlerKit(kitsDir, 'fetched', { session: [{ run: 'scripts/echo.mjs' }] });
  rmSync(join(dir, 'scripts'), { recursive: true });
  assert.equal(hook('session', { hook_event_name: 'SessionStart', source: 'startup' }).stdout, '');
});

test('kit check refuses a handler script that is not a declared asset', t => {
  const { kitsDir, env } = setup(t);
  handlerKit(kitsDir, 'loose', { stop: [{ run: 'scripts/echo.mjs' }] });
  const saved = process.env.IA_CORE_KITS_DIR;
  process.env.IA_CORE_KITS_DIR = env.IA_CORE_KITS_DIR;
  t.after(() => { if (saved === undefined) delete process.env.IA_CORE_KITS_DIR; else process.env.IA_CORE_KITS_DIR = saved; });
  const problems = kitProblems(findKit('inventarch/loose-kit'));
  assert.ok(problems.some(p => /handlers\.json runs scripts that are not declared assets in \.ia\/release\.json: scripts\/echo\.mjs/.test(p)), problems.join('\n'));
});

test('the governance probe names the ia-governance kit until an installed kit declares governance handlers', t => {
  const { kitsDir, repo } = setup(t);
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const kits = () => [findKit('inventarch/gov-kit', kitsDir)];
  handlerKit(kitsDir, 'gov', { session: [{ run: 'scripts/echo.mjs' }] });
  assert.equal(declaresGovernance(handlerKits({ kits: kits() }).kits), false, 'a session handler is not a governance handler');
  const notice = governanceNotice({ source: 'startup', root: repo, kits: kits() });
  assert.match(notice, /this repository is governed \(\.ia\/governance\.json\); add the ia-governance kit \(`ia kit add`\)/);
  assert.doesNotMatch(notice, /plugin/);
  assert.equal(governanceNotice({ source: 'resume', root: repo, kits: kits() }), null, 'startup only');
  writeFileSync(join(kitsDir, 'gov', 'handlers.json'), JSON.stringify({ format: 1, tool: [{ run: 'scripts/echo.mjs', phase: 'pre' }] }));
  assert.equal(governanceNotice({ source: 'startup', root: repo, kits: kits() }), null, 'a kit with a pre handler governs');
});
