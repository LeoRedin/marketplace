#!/usr/bin/env node
// Gemini CLI (`@google/gemini-cli`) lifecycle hook adapter for the `ia` plugin:
//   node scripts/gemini-hook.mjs session   SessionStart
//   node scripts/gemini-hook.mjs prompt    BeforeAgent
//   node scripts/gemini-hook.mjs pre       BeforeTool
//   node scripts/gemini-hook.mjs post      AfterTool
//   node scripts/gemini-hook.mjs stop      AfterAgent
// Enforces Gemini CLI's stdout rule: stdout always receives exactly one JSON
// object line, and any diagnostic text goes strictly to stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payload as bootstrapPayload } from './bootstrap.mjs';
import { answer as handlersAnswer, BUDGET_MS } from './handlers.mjs';
import { gate } from './lib/handlers.mjs';
import { normalizeHookInput } from './lib/host-hook.mjs';
import { killRunning } from './lib/hygiene.mjs';
import { kitsDir, listKits } from './lib/kit.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/');

const GEMINI_EVENT = {
  session: 'SessionStart',
  prompt: 'BeforeAgent',
  pre: 'BeforeTool',
  post: 'AfterTool',
  stop: 'AfterAgent',
};

export async function runGeminiHook(phase, rawText, { env = process.env, kits } = {}) {
  const hookEventName = GEMINI_EVENT[phase];
  if (!hookEventName) return {};
  const effectiveEnv = {
    ...env,
    CLAUDE_PLUGIN_ROOT: env.extensionPath || env.GEMINI_EXTENSION_PATH || env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT,
  };
  const resolvedKits = kits ?? (effectiveEnv.IA_CORE_KITS_DIR ? listKits(kitsDir(effectiveEnv)) : undefined);
  const { ok, normalized, normalizedRaw } = normalizeHookInput(phase, rawText);
  if (!ok) return phase === 'session' ? {} : { decision: 'allow' };
  if (phase === 'session') {
    const boot = bootstrapPayload(normalized, effectiveEnv);
    const handlers = await handlersAnswer('session', normalizedRaw, { env: effectiveEnv, kits: resolvedKits });
    const parts = [
      boot?.hookSpecificOutput?.additionalContext,
      handlers?.hookSpecificOutput?.additionalContext,
    ].filter(s => typeof s === 'string' && s.trim());
    const systemMessage = typeof boot?.systemMessage === 'string' && boot.systemMessage.trim() ? boot.systemMessage.trim() : undefined;
    return {
      ...(systemMessage ? { systemMessage } : {}),
      ...(parts.length ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } } : {}),
    };
  }
  if (phase === 'stop' && normalized.stop_hook_active === true) {
    return { decision: 'allow' };
  }
  const handlers = await handlersAnswer(phase, normalizedRaw, { env: effectiveEnv, kits: resolvedKits });
  const out = handlers?.hookSpecificOutput;
  if (out?.permissionDecision === 'deny') {
    return {
      decision: 'deny',
      reason: out.permissionDecisionReason || 'Blocked by InventArch handler.',
      ...(typeof out.additionalContext === 'string' && out.additionalContext.trim()
        ? { hookSpecificOutput: { hookEventName, additionalContext: out.additionalContext.trim() } }
        : {}),
    };
  }
  const additionalContext = typeof out?.additionalContext === 'string' && out.additionalContext.trim()
    ? out.additionalContext.trim()
    : undefined;
  return {
    decision: 'allow',
    ...(additionalContext ? { hookSpecificOutput: { hookEventName, additionalContext } } : {}),
  };
}

const writeJson = value => new Promise(done => { process.stdout.write(`${JSON.stringify(value)}\n`, () => done()); });

async function main() {
  const phase = process.argv[2] ?? '';
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = '{}'; }
  const response = await runGeminiHook(phase, raw);
  await writeJson(response);
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  const phase = process.argv[2] ?? '';
  const budget = phase === 'session' ? 60_000 : (BUDGET_MS[phase] ?? 25_000);
  const guard = setTimeout(() => {
    const kit = gate.kit;
    killRunning();
    if (phase === 'pre' && kit) {
      process.stdout.write(`${JSON.stringify({ decision: 'deny', reason: `${kit}: its pre-tool handler did not answer within the hook's budget, so the call is refused (fail closed)` })}\n`);
    } else if (phase === 'session') {
      process.stdout.write('{}\n');
    } else {
      process.stdout.write('{"decision":"allow"}\n');
    }
    process.exit(0);
  }, budget + 3_000);
  guard.unref();
  try {
    await main();
  } catch (error) {
    process.stderr.write(`ia gemini-hook: ${error?.message ?? error}\n`);
    if (phase === 'pre' && gate.kit) process.stdout.write(`${JSON.stringify({ decision: 'deny', reason: `${gate.kit}: pre-tool hook failed (fail closed)` })}\n`);
    else if (phase === 'session') process.stdout.write('{}\n');
    else process.stdout.write('{"decision":"allow"}\n');
  }
  process.exit(0);
}
