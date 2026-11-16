// Shared normalization and buffering for Google Antigravity and Gemini CLI
// lifecycle hooks (`scripts/agy-hook.mjs` and `scripts/gemini-hook.mjs`).
// Translates each host's stdin payload onto the canonical hook JSON that
// `bootstrap.mjs`, `handlers.mjs`, `on-write.mjs` and `method-advise.mjs` read,
// and manages the bounded `PostToolUse` -> `PostInvocation` context buffer for
// Antigravity (`PLUGIN_DATA`, falling back to `<IA home>/agy-hook-buffer`).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { iaHome } from './home.mjs';

export const BUFFER_CAP = 12_000;
export const BUFFER_TTL_MS = 3_600_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

const EVENT_TO_CANONICAL = {
  session: 'SessionStart',
  prompt: 'UserPromptSubmit',
  pre: 'PreToolUse',
  post: 'PostToolUse',
  stop: 'Stop',
};

const plain = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function mapTool(name, args) {
  const input = plain(args) ? { ...args } : {};
  if (!name || typeof name !== 'string') return { toolName: undefined, toolInput: input };
  if (name === 'write_file' || name === 'Write') {
    const filePath = input.file_path ?? input.Path ?? input.path;
    const content = input.content ?? input.Content;
    return {
      toolName: 'Write',
      toolInput: { ...input, ...(typeof filePath === 'string' ? { file_path: filePath } : {}), ...(typeof content === 'string' ? { content } : {}) },
    };
  }
  if (name === 'edit_file' || name === 'replace' || name === 'Edit' || name === 'MultiEdit') {
    const filePath = input.file_path ?? input.Path ?? input.path;
    const oldString = input.old_string ?? input.Target;
    const newString = input.new_string ?? input.Replacement;
    return {
      toolName: name === 'MultiEdit' ? 'MultiEdit' : 'Edit',
      toolInput: {
        ...input,
        ...(typeof filePath === 'string' ? { file_path: filePath } : {}),
        ...(typeof oldString === 'string' ? { old_string: oldString } : {}),
        ...(typeof newString === 'string' ? { new_string: newString } : {}),
      },
    };
  }
  if (name === 'run_command' || name === 'run_shell_command' || name === 'shell' || name === 'code_execution' || name === 'Bash' || name === 'PowerShell') {
    const command = input.command ?? input.CommandLine;
    return {
      toolName: name === 'PowerShell' ? 'PowerShell' : 'Bash',
      toolInput: { ...input, ...(typeof command === 'string' ? { command } : {}) },
    };
  }
  if (name === 'ask_question' || name === 'ask_user' || name === 'AskUserQuestion') {
    return { toolName: 'AskUserQuestion', toolInput: input };
  }
  if (name === 'read_file' || name === 'view_file' || name === 'Read') {
    const filePath = input.file_path ?? input.Path ?? input.path;
    return { toolName: 'Read', toolInput: { ...input, ...(typeof filePath === 'string' ? { file_path: filePath } : {}) } };
  }
  return { toolName: name, toolInput: input };
}

// Normalizes a raw host stdin string into `{ ok, rawObj, normalized, normalizedRaw }`.
export function normalizeHookInput(event, rawText, { cwdFallback = process.cwd() } = {}) {
  let rawObj;
  try { rawObj = JSON.parse(rawText || '{}'); } catch { return { ok: false, rawObj: {}, normalized: {}, normalizedRaw: '{}' }; }
  if (!plain(rawObj)) return { ok: false, rawObj: {}, normalized: {}, normalizedRaw: '{}' };
  const workspaceFirst = Array.isArray(rawObj.workspacePaths) && typeof rawObj.workspacePaths[0] === 'string' && rawObj.workspacePaths[0]
    ? rawObj.workspacePaths[0]
    : null;
  const cwd = typeof rawObj.cwd === 'string' && rawObj.cwd ? rawObj.cwd : (workspaceFirst ?? cwdFallback);
  const rawToolCall = plain(rawObj.toolCall) ? rawObj.toolCall : (plain(rawObj.tool_call) ? rawObj.tool_call : null);
  const rawToolName = typeof rawObj.tool_name === 'string' ? rawObj.tool_name : (typeof rawToolCall?.name === 'string' ? rawToolCall.name : undefined);
  const rawToolArgs = plain(rawObj.tool_input) ? rawObj.tool_input : (plain(rawToolCall?.args) ? rawToolCall.args : undefined);
  const { toolName, toolInput } = mapTool(rawToolName, rawToolArgs);
  const source = typeof rawObj.source === 'string' && rawObj.source ? rawObj.source : 'startup';
  const stopActive = rawObj.continuationActive === true || rawObj.stop_hook_active === true;
  const normalized = {
    ...rawObj,
    cwd,
    hook_event_name: EVENT_TO_CANONICAL[event] ?? rawObj.hook_event_name ?? rawObj.hookEventName,
    session_id: rawObj.session_id ?? rawObj.conversationId ?? 'default',
    ...(rawObj.transcript_path || rawObj.transcriptPath ? { transcript_path: rawObj.transcript_path ?? rawObj.transcriptPath } : {}),
    ...(event === 'session' ? { source } : {}),
    ...(event === 'prompt' ? { prompt: rawObj.prompt ?? rawObj.lastUserInput ?? '' } : {}),
    ...(stopActive ? { stop_hook_active: true } : {}),
    ...(toolName ? { tool_name: toolName, tool_input: toolInput } : {}),
  };
  return { ok: true, rawObj, normalized, normalizedRaw: JSON.stringify(normalized) };
}

function bufferDir(env = process.env) {
  if (typeof env.PLUGIN_DATA === 'string' && env.PLUGIN_DATA.trim()) return env.PLUGIN_DATA.trim();
  try { return join(iaHome(env), 'agy-hook-buffer'); } catch { return null; }
}

function bufferFile(dir, conversationId) {
  const key = typeof conversationId === 'string' && conversationId ? conversationId : 'default';
  const safe = SAFE_ID.test(key) ? key : createHash('sha256').update(key).digest('hex').slice(0, 32);
  return join(dir, `pending-${safe}.json`);
}

function pruneBufferDir(dir, now) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith('pending-')) continue;
    const full = join(dir, name);
    try {
      if (now - statSync(full).mtimeMs > BUFFER_TTL_MS) rmSync(full, { force: true });
    } catch { /* concurrent removal */ }
  }
}

export function appendPendingContext(conversationId, text, { env = process.env, now = Date.now() } = {}) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return false;
  const dir = bufferDir(env);
  if (!dir) return false;
  try {
    mkdirSync(dir, { recursive: true });
    pruneBufferDir(dir, now);
    const file = bufferFile(dir, conversationId);
    let items = [];
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed?.items) && typeof parsed.updatedAt === 'number' && now - parsed.updatedAt <= BUFFER_TTL_MS) {
          items = parsed.items.filter(x => typeof x === 'string' && x.trim());
        }
      } catch { items = []; }
    }
    if (!items.includes(trimmed)) items.push(trimmed);
    let joined = items.join('\n\n');
    if (joined.length > BUFFER_CAP) joined = `${joined.slice(0, BUFFER_CAP - 12)} [truncated]`;
    const temp = `${file}.${process.pid}.${now}.tmp`;
    writeFileSync(temp, JSON.stringify({ format: 1, updatedAt: now, items: [joined] }) + '\n', 'utf8');
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

export function drainPendingContext(conversationId, { env = process.env, now = Date.now() } = {}) {
  const dir = bufferDir(env);
  if (!dir || !existsSync(dir)) return '';
  const file = bufferFile(dir, conversationId);
  if (!existsSync(file)) return '';
  const claimed = `${file}.${process.pid}.${now}.drain`;
  try {
    renameSync(file, claimed);
  } catch {
    return '';
  }
  try {
    const parsed = JSON.parse(readFileSync(claimed, 'utf8'));
    rmSync(claimed, { force: true });
    if (typeof parsed?.updatedAt === 'number' && now - parsed.updatedAt > BUFFER_TTL_MS) return '';
    const items = Array.isArray(parsed?.items) ? parsed.items.filter(x => typeof x === 'string' && x.trim()) : [];
    const joined = items.join('\n\n').trim();
    return joined.length > BUFFER_CAP ? `${joined.slice(0, BUFFER_CAP - 12)} [truncated]` : joined;
  } catch {
    try { rmSync(claimed, { force: true }); } catch { /* gone */ }
    return '';
  }
}
