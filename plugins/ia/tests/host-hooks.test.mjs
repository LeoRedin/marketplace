// Google Antigravity (`agy-hook.mjs`) and Gemini CLI (`gemini-hook.mjs`)
// lifecycle hook adapters, shared payload normalization (`lib/host-hook.mjs`),
// `PostToolUse` -> `PLUGIN_DATA` -> `PostInvocation` buffering, and process
// hygiene (`childEnv`) for host-specific variables.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgyHook } from '../scripts/agy-hook.mjs';
import { runGeminiHook } from '../scripts/gemini-hook.mjs';
import { appendPendingContext, BUFFER_CAP, BUFFER_TTL_MS, drainPendingContext, normalizeHookInput } from '../scripts/lib/host-hook.mjs';
import { childEnv } from '../scripts/lib/hygiene.mjs';
import { declareAssets, envFor, fakeCli, makeKit, makeRepo, recordSources, run, sandbox } from './helpers/fixtures.mjs';

const ECHO = `import { readFileSync } from 'node:fs';
const hook = JSON.parse(readFileSync(0, 'utf8') || '{}');
const answer = process.env.IA_TEST_HANDLER_ANSWER
  ? JSON.parse(process.env.IA_TEST_HANDLER_ANSWER)
  : { additionalContext: 'saw ' + hook.hook_event_name + ':' + (hook.tool_name ?? 'none') };
process.stdout.write(JSON.stringify(answer) + '\\n');
`;

function handlerKit(kitsDir, folder, handlers, scripts = { 'scripts/echo.mjs': ECHO }, { declare = true } = {}) {
  const { dir } = makeKit(kitsDir, { folder, id: `inventarch/${folder}-kit` });
  for (const [rel, text] of Object.entries(scripts)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  writeFileSync(join(dir, 'handlers.json'), JSON.stringify({ format: 1, ...handlers }, null, 2) + '\n');
  if (declare) declareAssets(dir, Object.keys(scripts));
  recordSources(dir);
  return dir;
}

test('normalizeHookInput maps Antigravity and Gemini CLI tool names and payloads', () => {
  const agyWrite = normalizeHookInput('pre', JSON.stringify({
    conversationId: 'conv-123',
    workspacePaths: ['/repo/one', '/repo/two'],
    toolCall: { name: 'write_file', args: { Path: '/repo/one/a.ia', Content: '#! ia 1.0\n' } },
  }));
  assert.equal(agyWrite.ok, true);
  assert.equal(agyWrite.normalized.cwd, '/repo/one');
  assert.equal(agyWrite.normalized.session_id, 'conv-123');
  assert.equal(agyWrite.normalized.hook_event_name, 'PreToolUse');
  assert.equal(agyWrite.normalized.tool_name, 'Write');
  assert.equal(agyWrite.normalized.tool_input.file_path, '/repo/one/a.ia');
  assert.equal(agyWrite.normalized.tool_input.content, '#! ia 1.0\n');

  const agyEdit = normalizeHookInput('post', JSON.stringify({
    conversationId: 'conv-123',
    workspacePaths: ['/repo/one'],
    toolCall: { name: 'edit_file', args: { Path: '/repo/one/b.ia', Target: 'old', Replacement: 'new' } },
  }));
  assert.equal(agyEdit.normalized.tool_name, 'Edit');
  assert.equal(agyEdit.normalized.tool_input.file_path, '/repo/one/b.ia');
  assert.equal(agyEdit.normalized.tool_input.old_string, 'old');
  assert.equal(agyEdit.normalized.tool_input.new_string, 'new');

  const agyCmd = normalizeHookInput('pre', JSON.stringify({
    toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
  }), { cwdFallback: '/fallback' });
  assert.equal(agyCmd.normalized.cwd, '/fallback');
  assert.equal(agyCmd.normalized.tool_name, 'Bash');
  assert.equal(agyCmd.normalized.tool_input.command, 'npm test');

  const agyIdeWrite = normalizeHookInput('pre', JSON.stringify({
    conversationId: 'conv-ide',
    workspacePaths: ['/repo/ide'],
    toolCall: { name: 'write_to_file', args: { TargetFile: '/repo/ide/a.ia', CodeContent: '#! ia 1.0\n' } },
  }));
  assert.equal(agyIdeWrite.normalized.tool_name, 'Write');
  assert.equal(agyIdeWrite.normalized.tool_input.file_path, '/repo/ide/a.ia');
  assert.equal(agyIdeWrite.normalized.tool_input.content, '#! ia 1.0\n');

  const agyIdeReplace = normalizeHookInput('pre', JSON.stringify({
    conversationId: 'conv-ide',
    workspacePaths: ['/repo/ide'],
    toolCall: {
      name: 'replace_file_content',
      args: { TargetFile: '/repo/ide/b.ia', TargetContent: 'before', ReplacementContent: 'after' },
    },
  }));
  assert.equal(agyIdeReplace.normalized.tool_name, 'Edit');
  assert.equal(agyIdeReplace.normalized.tool_input.file_path, '/repo/ide/b.ia');
  assert.equal(agyIdeReplace.normalized.tool_input.old_string, 'before');
  assert.equal(agyIdeReplace.normalized.tool_input.new_string, 'after');

  const agyIdeMulti = normalizeHookInput('post', JSON.stringify({
    conversationId: 'conv-ide',
    workspacePaths: ['/repo/ide'],
    toolCall: {
      name: 'multi_replace_file_content',
      args: {
        TargetFile: '/repo/ide/c.ia',
        ReplacementChunks: [{ TargetContent: 'x', ReplacementContent: 'y' }],
      },
    },
  }));
  assert.equal(agyIdeMulti.normalized.tool_name, 'MultiEdit');
  assert.equal(agyIdeMulti.normalized.tool_input.file_path, '/repo/ide/c.ia');
  assert.deepEqual(agyIdeMulti.normalized.tool_input.edits, [{ old_string: 'x', new_string: 'y' }]);

  const agyIdeView = normalizeHookInput('pre', JSON.stringify({
    toolCall: { name: 'view_file', args: { AbsolutePath: '/repo/ide/readme.md' } },
  }));
  assert.equal(agyIdeView.normalized.tool_name, 'Read');
  assert.equal(agyIdeView.normalized.tool_input.file_path, '/repo/ide/readme.md');

  const agyStop = normalizeHookInput('stop', JSON.stringify({
    conversationId: 'conv-123',
    continuationActive: true,
  }));
  assert.equal(agyStop.normalized.stop_hook_active, true);

  const agyStopExec = normalizeHookInput('stop', JSON.stringify({
    conversationId: 'conv-123',
    executionNum: 2,
  }));
  assert.equal(agyStopExec.normalized.stop_hook_active, true);

  const agyStopTerminal = normalizeHookInput('stop', JSON.stringify({
    conversationId: 'conv-123',
    terminationReason: 'MAX_INVOCATIONS',
  }));
  assert.equal(agyStopTerminal.normalized.stop_hook_active, true);

  const geminiReplace = normalizeHookInput('pre', JSON.stringify({
    session_id: 'gem-1',
    cwd: '/repo/gem',
    tool_name: 'replace',
    tool_input: { file_path: '/repo/gem/c.ia', old_string: 'a', new_string: 'b' },
  }));
  assert.equal(geminiReplace.normalized.tool_name, 'Edit');
  assert.equal(geminiReplace.normalized.tool_input.file_path, '/repo/gem/c.ia');

  const geminiShell = normalizeHookInput('post', JSON.stringify({
    cwd: '/repo/gem',
    tool_name: 'run_shell_command',
    tool_input: { command: 'git status' },
  }));
  assert.equal(geminiShell.normalized.tool_name, 'Bash');
  assert.equal(geminiShell.normalized.tool_input.command, 'git status');

  const geminiAsk = normalizeHookInput('post', JSON.stringify({
    cwd: '/repo/gem',
    tool_name: 'ask_user',
    tool_input: { question: 'Proceed?' },
  }));
  assert.equal(geminiAsk.normalized.tool_name, 'AskUserQuestion');
});

test('appendPendingContext and drainPendingContext bound size, deduplicate, and expire stale buffers', t => {
  const dir = sandbox(t, 'ia-host-buf-');
  const env = { PLUGIN_DATA: join(dir, 'plugin-data') };
  const t0 = 1_700_000_000_000;
  assert.equal(appendPendingContext('conv/unsafe:id', 'first advisory', { env, now: t0 }), true);
  assert.equal(appendPendingContext('conv/unsafe:id', 'first advisory', { env, now: t0 + 10 }), true);
  assert.equal(appendPendingContext('conv/unsafe:id', 'second advisory', { env, now: t0 + 20 }), true);
  const drained = drainPendingContext('conv/unsafe:id', { env, now: t0 + 30 });
  assert.equal(drained, 'first advisory\n\nsecond advisory');
  assert.equal(drainPendingContext('conv/unsafe:id', { env, now: t0 + 40 }), '');

  appendPendingContext('conv-cap', 'x'.repeat(BUFFER_CAP + 500), { env, now: t0 });
  const capped = drainPendingContext('conv-cap', { env, now: t0 + 10 });
  assert.ok(capped.length <= BUFFER_CAP);
  assert.match(capped, /\[truncated\]$/);

  appendPendingContext('conv-stale', 'old advisory', { env, now: t0 });
  assert.equal(drainPendingContext('conv-stale', { env, now: t0 + BUFFER_TTL_MS + 1 }), '');
});

test('Antigravity hook adapter handles session, post buffering -> post-invocation drain, governed pre block, and stop guard', async t => {
  const dir = sandbox(t, 'ia-agy-hook-');
  const kitsDir = join(dir, 'kits');
  mkdirSync(kitsDir);
  const repo = makeRepo(dir);
  const pluginData = join(dir, 'plugin-data');
  const env = envFor({
    cli: fakeCli(dir),
    kitsDir,
    temp: join(dir, 'temp'),
    extra: { IA_HOME: join(dir, 'home'), PLUGIN_DATA: pluginData },
  });

  handlerKit(kitsDir, 'suite', {
    session: [{ run: 'scripts/echo.mjs', events: ['startup'] }],
    tool: [
      { run: 'scripts/echo.mjs', phase: 'pre', match: 'Write|Edit|MultiEdit' },
      { run: 'scripts/echo.mjs', phase: 'post', match: 'Write|Edit|MultiEdit' },
    ],
    stop: [{ run: 'scripts/echo.mjs' }],
  });

  const sessionOut = await runAgyHook('session', JSON.stringify({
    conversationId: 'c1',
    workspacePaths: [repo],
  }), { env });
  assert.ok(Array.isArray(sessionOut.injectSteps));
  assert.match(sessionOut.injectSteps[0].systemMessage.systemMessage, /inventarch\/suite-kit: saw SessionStart:none/);

  // PostToolUse returns {} while buffering into PLUGIN_DATA; PostInvocation flushes once.
  const postOut = await runAgyHook('post', JSON.stringify({
    conversationId: 'c1',
    workspacePaths: [repo],
    toolCall: { name: 'write_to_file', args: { TargetFile: join(repo, 'note.md'), CodeContent: '# hi\n' } },
  }), { env });
  assert.deepEqual(postOut, {});

  const flushed = await runAgyHook('post-invocation', JSON.stringify({ conversationId: 'c1' }), { env });
  assert.ok(Array.isArray(flushed.injectSteps));
  assert.match(flushed.injectSteps[0].systemMessage.systemMessage, /inventarch\/suite-kit: saw PostToolUse:Write/);
  assert.deepEqual(await runAgyHook('post-invocation', JSON.stringify({ conversationId: 'c1' }), { env }), {});

  // Governed PreToolUse blocks with { decision: "deny", reason } across documented Antigravity edit tools and edit_file.
  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const blockEnv = { ...env, IA_TEST_HANDLER_ANSWER: JSON.stringify({ decision: 'block', reason: 'missing mandate' }) };
  for (const toolCall of [
    { name: 'write_to_file', args: { TargetFile: join(repo, 'a.js'), CodeContent: 'const x = 1;\n' } },
    { name: 'replace_file_content', args: { TargetFile: join(repo, 'a.js'), TargetContent: '1', ReplacementContent: '2' } },
    { name: 'multi_replace_file_content', args: { TargetFile: join(repo, 'a.js'), ReplacementChunks: [{ TargetContent: '1', ReplacementContent: '2' }] } },
    { name: 'edit_file', args: { Path: join(repo, 'a.js'), Target: '1', Replacement: '2' } },
  ]) {
    const preBlocked = await runAgyHook('pre', JSON.stringify({
      conversationId: 'c1',
      workspacePaths: [repo],
      toolCall,
    }), { env: blockEnv });
    assert.equal(preBlocked.decision, 'deny', `expected deny for ${toolCall.name}`);
    assert.match(preBlocked.reason, /inventarch\/suite-kit: missing mandate/);
  }

  // Stop requests continuation once, and allows when continuationActive is true.
  const stopContinue = await runAgyHook('stop', JSON.stringify({
    conversationId: 'c1',
    workspacePaths: [repo],
    continuationActive: false,
  }), { env });
  assert.equal(stopContinue.decision, 'continue');
  assert.match(stopContinue.reason, /inventarch\/suite-kit: saw Stop:none/);

  const stopDone = await runAgyHook('stop', JSON.stringify({
    conversationId: 'c1',
    workspacePaths: [repo],
    continuationActive: true,
  }), { env });
  assert.deepEqual(stopDone, { decision: 'allow' });

  // When Antigravity IDE sends Stop payloads without continuationActive, the
  // per-turn cap in PLUGIN_DATA allows at most one continuation on the same turn
  // (even across intermediate PreInvocation calls) and resets for a new user turn.
  const ideStop1 = await runAgyHook('stop', JSON.stringify({
    conversationId: 'c-ide-stop',
    workspacePaths: [repo],
    lastUserInput: 'finish the task',
    terminationReason: 'MODEL_FINAL_ANSWER',
  }), { env });
  assert.equal(ideStop1.decision, 'continue');

  await runAgyHook('prompt', JSON.stringify({
    conversationId: 'c-ide-stop',
    workspacePaths: [repo],
    lastUserInput: 'finish the task',
  }), { env });

  const ideStop2 = await runAgyHook('stop', JSON.stringify({
    conversationId: 'c-ide-stop',
    workspacePaths: [repo],
    lastUserInput: 'finish the task',
    terminationReason: 'MODEL_FINAL_ANSWER',
  }), { env });
  assert.deepEqual(ideStop2, { decision: 'allow' });

  const ideStopNextTurn = await runAgyHook('stop', JSON.stringify({
    conversationId: 'c-ide-stop',
    workspacePaths: [repo],
    lastUserInput: 'start another task',
    terminationReason: 'MODEL_FINAL_ANSWER',
  }), { env });
  assert.equal(ideStopNextTurn.decision, 'continue');
});

test('Gemini CLI hook adapter emits strictly one JSON line on stdout across lifecycle events', t => {
  const dir = sandbox(t, 'ia-gemini-hook-');
  const kitsDir = join(dir, 'kits');
  mkdirSync(kitsDir);
  const repo = makeRepo(dir);
  const env = envFor({
    cli: fakeCli(dir),
    kitsDir,
    temp: join(dir, 'temp'),
    extra: { IA_HOME: join(dir, 'home') },
  });

  handlerKit(kitsDir, 'gem', {
    session: [{ run: 'scripts/echo.mjs', events: ['startup'] }],
    prompt: [{ run: 'scripts/echo.mjs' }],
    tool: [
      { run: 'scripts/echo.mjs', phase: 'pre', match: 'Write|Edit|Bash' },
      { run: 'scripts/echo.mjs', phase: 'post', match: 'Write|Edit|Bash' },
    ],
    stop: [{ run: 'scripts/echo.mjs' }],
  });

  const sess = run('gemini-hook.mjs', ['session'], env, { input: JSON.stringify({ cwd: repo, source: 'startup' }) });
  assert.equal(sess.status, 0);
  assert.equal(sess.stdout.trim().split('\n').length, 1);
  assert.equal(sess.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(sess.json.hookSpecificOutput.additionalContext, /inventarch\/gem-kit: saw SessionStart:none/);

  const beforeAgent = run('gemini-hook.mjs', ['prompt'], env, { input: JSON.stringify({ cwd: repo, prompt: 'check plan' }) });
  assert.equal(beforeAgent.status, 0);
  assert.equal(beforeAgent.json.decision, 'allow');
  assert.equal(beforeAgent.json.hookSpecificOutput.hookEventName, 'BeforeAgent');

  writeFileSync(join(repo, '.ia', 'governance.json'), '{}\n');
  const blocked = run(
    'gemini-hook.mjs',
    ['pre'],
    { ...env, IA_TEST_HANDLER_ANSWER: JSON.stringify({ decision: 'block', reason: 'out of scope' }) },
    { input: JSON.stringify({ cwd: repo, tool_name: 'replace', tool_input: { file_path: 'x.mjs' } }) },
  );
  assert.equal(blocked.status, 0);
  assert.equal(blocked.stdout.trim().split('\n').length, 1);
  assert.equal(blocked.json.decision, 'deny');
  assert.match(blocked.json.reason, /inventarch\/gem-kit: out of scope/);

  const afterTool = run('gemini-hook.mjs', ['post'], env, {
    input: JSON.stringify({ cwd: repo, tool_name: 'run_shell_command', tool_input: { command: 'npm test' } }),
  });
  assert.equal(afterTool.status, 0);
  assert.equal(afterTool.json.decision, 'allow');
  assert.equal(afterTool.json.hookSpecificOutput.hookEventName, 'AfterTool');
  assert.match(afterTool.json.hookSpecificOutput.additionalContext, /PostToolUse:Bash/);

  const stopActive = run('gemini-hook.mjs', ['stop'], env, {
    input: JSON.stringify({ cwd: repo, stop_hook_active: true }),
  });
  assert.deepEqual(stopActive.json, { decision: 'allow' });
});

test('childEnv strips Gemini and Antigravity secrets and plugin paths', () => {
  const cleaned = childEnv({
    PATH: '/usr/bin',
    GEMINI_API_KEY: 'secret-key',
    GOOGLE_API_KEY: 'secret-google-key',
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/tmp/settings.json',
    ANTIGRAVITY_CSRF_TOKEN: 'csrf-token',
    PLUGIN_ROOT: '/plugins/ia',
    PLUGIN_DATA: '/plugin-data/ia',
    IA_WORKSPACE_ROOT: '/repo',
    IA_GEMINI_API_KEY: 'must-still-drop',
  });
  assert.equal(cleaned.PATH, '/usr/bin');
  assert.equal(cleaned.IA_WORKSPACE_ROOT, '/repo');
  assert.equal(cleaned.IA_NO_HANDOFF, '1');
  for (const forbidden of [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
    'ANTIGRAVITY_CSRF_TOKEN',
    'PLUGIN_ROOT',
    'PLUGIN_DATA',
    'IA_GEMINI_API_KEY',
  ]) {
    assert.equal(cleaned[forbidden], undefined, `${forbidden} must not pass to kit child processes`);
  }
});
