#!/usr/bin/env node
// Google Antigravity lifecycle hook adapter for the `ia` plugin:
//   node scripts/agy-hook.mjs session          SessionStart
//   node scripts/agy-hook.mjs prompt           PreInvocation
//   node scripts/agy-hook.mjs pre              PreToolUse
//   node scripts/agy-hook.mjs post             PostToolUse (buffers into PLUGIN_DATA)
//   node scripts/agy-hook.mjs post-invocation  PostInvocation (flushes buffered context)
//   node scripts/agy-hook.mjs stop             Stop
// Antigravity expects camelCase JSON on stdin and strictly structured JSON on
// stdout (`{}` for PostToolUse, `injectSteps` for SessionStart/PreInvocation/
// PostInvocation, `{ decision: "allow"|"deny", reason? }` for PreToolUse, and
// `{ decision: "continue"|"allow", reason? }` for Stop).
import { readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payload as bootstrapPayload } from './bootstrap.mjs';
import { answer as handlersAnswer, BUDGET_MS } from './handlers.mjs';
import { gate } from './lib/handlers.mjs';
import {
  appendPendingContext,
  clearStopContinuation,
  consumeStopContinuationCap,
  drainPendingContext,
  normalizeHookInput,
  recordStopContinuation,
} from './lib/host-hook.mjs';
import { killRunning } from './lib/hygiene.mjs';
import { kitsDir, listKits } from './lib/kit.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/');

function injectStep(systemMessage, userMarkdown = null) {
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: systemMessage ?? '',
          ...(userMarkdown ? { metadata: { user_markdown: userMarkdown } } : {}),
        },
      },
    ],
  };
}

export async function runAgyHook(phase, rawText, { env = process.env, kits } = {}) {
  const effectiveEnv = {
    ...env,
    CLAUDE_PLUGIN_ROOT: env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT,
  };
  const resolvedKits = kits ?? (effectiveEnv.IA_CORE_KITS_DIR ? listKits(kitsDir(effectiveEnv)) : undefined);
  if (phase === 'post-invocation') {
    let rawObj = {};
    try { rawObj = JSON.parse(rawText || '{}'); } catch { rawObj = {}; }
    const drained = drainPendingContext(rawObj?.conversationId, { env: effectiveEnv });
    return drained ? injectStep(drained) : {};
  }
  const { ok, rawObj, normalized, normalizedRaw } = normalizeHookInput(phase, rawText);
  if (!ok) {
    if (phase === 'pre') return { decision: 'allow' };
    if (phase === 'stop') return { decision: 'allow' };
    return {};
  }
  if (phase === 'session') {
    const boot = bootstrapPayload(normalized, effectiveEnv);
    const handlers = await handlersAnswer('session', normalizedRaw, { env: effectiveEnv, kits: resolvedKits });
    const parts = [
      boot?.hookSpecificOutput?.additionalContext,
      handlers?.hookSpecificOutput?.additionalContext,
    ].filter(s => typeof s === 'string' && s.trim());
    const userNotice = typeof boot?.systemMessage === 'string' && boot.systemMessage.trim() ? boot.systemMessage.trim() : null;
    if (!parts.length && !userNotice) return {};
    return injectStep(parts.join('\n\n'), userNotice);
  }
  if (phase === 'prompt') {
    const handlers = await handlersAnswer('prompt', normalizedRaw, { env: effectiveEnv, kits: resolvedKits });
    const text = handlers?.hookSpecificOutput?.additionalContext;
    return typeof text === 'string' && text.trim() ? injectStep(text.trim()) : {};
  }
  if (phase === 'pre') {
    const handlers = await handlersAnswer('pre', normalizedRaw, { env: effectiveEnv, kits: resolvedKits });
    const out = handlers?.hookSpecificOutput;
    if (out?.permissionDecision === 'deny') {
      return { decision: 'deny', reason: out.permissionDecisionReason || 'Blocked by InventArch governance handler.' };
    }
    if (typeof out?.additionalContext === 'string' && out.additionalContext.trim()) {
      appendPendingContext(rawObj.conversationId, out.additionalContext, { env: effectiveEnv });
    }
    return { decision: 'allow' };
  }
  if (phase === 'post') {
    const handlers = await handlersAnswer('post', normalizedRaw, { env: effectiveEnv, kits: resolvedKits });
    const text = handlers?.hookSpecificOutput?.additionalContext;
    if (typeof text === 'string' && text.trim()) {
      appendPendingContext(rawObj.conversationId, text, { env: effectiveEnv });
    }
    return {};
  }
  if (phase === 'stop') {
    if (rawObj.continuationActive === true || normalized.stop_hook_active === true) {
      clearStopContinuation(rawObj.conversationId, { env: effectiveEnv });
      return { decision: 'allow' };
    }
    if (consumeStopContinuationCap(rawObj.conversationId, rawObj.lastUserInput, { env: effectiveEnv })) {
      return { decision: 'allow' };
    }
    const handlers = await handlersAnswer('stop', normalizedRaw, { env: effectiveEnv, kits: resolvedKits });
    const out = handlers?.hookSpecificOutput;
    if (out?.permissionDecision === 'deny') {
      recordStopContinuation(rawObj.conversationId, rawObj.lastUserInput, { env: effectiveEnv });
      return { decision: 'continue', reason: out.permissionDecisionReason || 'InventArch stop check requested continuation.' };
    }
    if (typeof out?.additionalContext === 'string' && out.additionalContext.trim()) {
      recordStopContinuation(rawObj.conversationId, rawObj.lastUserInput, { env: effectiveEnv });
      return { decision: 'continue', reason: out.additionalContext.trim() };
    }
    return { decision: 'allow' };
  }
  return {};
}

const writeJson = value => new Promise(done => { process.stdout.write(`${JSON.stringify(value)}\n`, () => done()); });

async function main() {
  const phase = process.argv[2] ?? '';
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = '{}'; }
  const response = await runAgyHook(phase, raw);
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
    } else if (phase === 'pre' || phase === 'stop') {
      process.stdout.write('{"decision":"allow"}\n');
    } else {
      process.stdout.write('{}\n');
    }
    process.exit(0);
  }, budget + 3_000);
  guard.unref();
  try {
    await main();
  } catch (error) {
    process.stderr.write(`ia agy-hook: ${error?.message ?? error}\n`);
    if (phase === 'pre' && gate.kit) process.stdout.write(`${JSON.stringify({ decision: 'deny', reason: `${gate.kit}: pre-tool hook failed (fail closed)` })}\n`);
    else if (phase === 'pre' || phase === 'stop') process.stdout.write('{"decision":"allow"}\n');
    else process.stdout.write('{}\n');
  }
  process.exit(0);
}
