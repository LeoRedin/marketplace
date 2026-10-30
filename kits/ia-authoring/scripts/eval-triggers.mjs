#!/usr/bin/env node
// Trigger evaluation for one model-invocable skill, per the ia-authoring-host system's host-trigger-* conventions (config: assets/trigger-config.md).
// It runs in the logged-in Claude config: an isolated CLAUDE_CONFIG_DIR has no login.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// What one session is allowed; the manifest records the same values.
const SESSION = { maxTurns: 2, allowedTools: ['Skill'] };
const DEFAULT_SESSION_TIMEOUT_SECONDS = 600;
const sessionTimeout = (config) => config.sessionTimeoutSeconds ?? DEFAULT_SESSION_TIMEOUT_SECONDS;
const ARM_IDS = ['original', 'regenerated'];

const text = (field) => field?.value?.text;
export function parseStream(stream) {
  const parsed = { listed: [], invoked: [], initialized: false, finished: false, resultSubtype: null, isError: false };
  for (const line of stream.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'system' && event.subtype === 'init') { parsed.initialized = true; parsed.listed = [...(event.skills ?? [])]; }
    if (event.type === 'result') { parsed.finished = true; parsed.resultSubtype = event.subtype ?? null; parsed.isError = event.is_error === true; }
    if (event.type === 'assistant')
      for (const item of event.message?.content ?? [])
        if (item.type === 'tool_use' && item.name === 'Skill' && typeof item.input?.skill === 'string') parsed.invoked.push(item.input.skill);
  }
  return parsed;
}
export const verdict = (parsed, skill) => ({ listed: parsed.listed.includes(skill), triggered: parsed.invoked.includes(skill) });

export function loadCases(snapshot, contract, requirement) {
  return snapshot.records
    .filter((r) => r.discriminator === 'case')
    .filter((r) => r.edges.some((e) => e.spelling === 'implements' && e.reference?.discriminator === 'contract'
      && e.reference?.name === contract && String(e.reference?.fragment ?? '').replace(/^#/, '') === requirement))
    .map((r) => {
      const scenario = r.sections.find((s) => s.name === 'scenario')?.fields ?? [];
      const kind = text(scenario.find((f) => f.key === 'kind'));
      const request = text(scenario.find((f) => f.key === 'request'));
      if (typeof request !== 'string' || !request.trim()) throw new Error(`case ${r.name}: request must be a non-empty string`);
      if (kind !== 'success' && kind !== 'refusal') throw new Error(`case ${r.name}: kind must be success or refusal`);
      return { id: r.name, prompt: request, shouldTrigger: kind === 'success' };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function planSessions(config, cases) {
  // Case-major, then run, then arm, so rate limits and model drift hit both arms evenly.
  const sessions = cases.flatMap((c) => Array.from({ length: config.runs }, (_, run) => config.arms.map((arm) => ({ arm: arm.id, case: c.id, run }))).flat());
  if (sessions.length > config.cap) throw new Error(`${sessions.length} sessions exceed the declared cap of ${config.cap}`);
  return sessions;
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const MIN_PER_KIND = 10;

// Refuses a config (and its cases) the protocol cannot run honestly. Throws an
// Error naming the field. `base` resolves relative plugin directories.
export function validateConfig(config, cases, base = process.cwd()) {
  const fail = (field, why) => { throw new Error(`config ${field}: ${why}`); };
  if (config === null || typeof config !== 'object') fail('(root)', 'must be an object');
  for (const field of ['mode', 'model', 'skill', 'contract', 'requirement', 'snapshot', 'out'])
    if (!nonEmpty(config[field])) fail(field, 'must be a non-empty string');
  if (config.mode !== 'dev' && config.mode !== 'gate') fail('mode', 'must be dev or gate');
  if (!Number.isInteger(config.runs)) fail('runs', 'must be an integer');
  if (config.mode === 'dev' && config.runs !== 1) fail('runs', 'dev mode runs each case once');
  if (config.mode === 'gate') {
    if (config.runs !== 3) fail('runs', 'gate mode runs each case three times');
    if (!config.model.includes('opus')) fail('model', 'gate mode runs on the target model (opus)');
  }
  if (!Number.isInteger(config.cap) || config.cap <= 0) fail('cap', 'must be a positive integer');
  if (!Array.isArray(config.arms) || config.arms.length !== 2) fail('arms', 'needs exactly two arms: the original and the regenerated plugin');
  config.arms.forEach((arm, i) => {
    if (!nonEmpty(arm?.id)) fail(`arms[${i}].id`, 'must be a non-empty string');
    if (!nonEmpty(arm?.pluginDir)) fail(`arms[${i}].pluginDir`, 'must be a non-empty string');
    else if (!existsSync(resolve(base, arm.pluginDir)) || !statSync(resolve(base, arm.pluginDir)).isDirectory()) fail(`arms[${i}].pluginDir`, 'must be an existing directory');
  });
  if (config.arms[0].id !== ARM_IDS[0] || config.arms[1].id !== ARM_IDS[1]) fail('arms', `the arm ids must be exactly ${ARM_IDS[0]} and then ${ARM_IDS[1]}, in that order`);
  if (config.sessionTimeoutSeconds !== undefined && (!Number.isInteger(config.sessionTimeoutSeconds) || config.sessionTimeoutSeconds <= 0)) fail('sessionTimeoutSeconds', 'must be a positive integer of seconds');
  if (!Array.isArray(config.disable)) fail('disable', 'must be present as an array (it may be empty)');
  const success = cases.filter((c) => c.shouldTrigger).length;
  const refusal = cases.length - success;
  if (success < MIN_PER_KIND) fail('cases', `needs at least ${MIN_PER_KIND} success cases, found ${success}`);
  if (refusal < MIN_PER_KIND) fail('cases', `needs at least ${MIN_PER_KIND} refusal cases, found ${refusal}`);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// sha256 over every file of a directory, each as relpath\0bytes\0, sorted by code point, skipping .git.
export function hashDirectory(dir) {
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (name === '.git') continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path); else files.push(path);
    }
  };
  walk(dir);
  const entries = files.map((p) => ({ rel: relative(dir, p).split('\\').join('/'), path: p }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel)));
  const hash = createHash('sha256');
  for (const { rel, path } of entries) { hash.update(rel); hash.update('\0'); hash.update(readFileSync(path)); hash.update('\0'); }
  return hash.digest('hex');
}

// The Wilson 95% score interval of k correct out of n.
export function wilson(k, n) {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.959964, p = k / n, d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const round = (x) => Math.round(x * 10000) / 10000;
  return { low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)) };
}

// A session is complete when the host started, was not killed, and the stream holds the init and the final result event.
export const sessionComplete = (child, parsed) => !child.error && !child.signal && parsed.initialized && parsed.finished && (!parsed.isError || parsed.resultSubtype === 'error_max_turns');

// The Newcombe hybrid-score 95% interval for the difference of two proportions (b minus a), from the two Wilson intervals.
export function newcombe(a, b) {
  const pa = a.n ? a.k / a.n : 0, pb = b.n ? b.k / b.n : 0;
  const wa = wilson(a.k, a.n), wb = wilson(b.k, b.n);
  const d = pb - pa;
  const round = (x) => Math.round(x * 10000) / 10000;
  return { estimate: round(d), interval95: { low: round(d - Math.sqrt((pb - wb.low) ** 2 + (wa.high - pa) ** 2)), high: round(d + Math.sqrt((wb.high - pb) ** 2 + (pa - wa.low) ** 2)) } };
}

function summarize(config, results) {
  const arms = Object.fromEntries(config.arms.map((arm) => {
    const mine = results.filter((r) => r.arm === arm.id);
    const rows = mine.filter((r) => r.complete && r.listed);
    const correct = rows.filter((r) => r.correct).length;
    return [arm.id, { sessions: rows.length, unlisted: mine.filter((r) => r.complete && !r.listed).length, incomplete: mine.filter((r) => !r.complete).length, correct, rate: rows.length ? Math.round((correct / rows.length) * 10000) / 10000 : null, interval95: wilson(correct, rows.length) }];
  }));
  const [a, b] = config.arms.map((arm) => arms[arm.id]);
  return { ...arms, difference: newcombe({ k: a.correct, n: a.sessions }, { k: b.correct, n: b.sessions }) };
}

function main(argv) {
  const at = argv.indexOf('--config');
  if (at < 0 || !argv[at + 1]) { process.stderr.write('usage: eval-triggers.mjs --config <path>\n'); return 2; }
  const refuse = (message) => { process.stderr.write(`${message}\n`); return 1; };
  const base = resolve(argv[at + 1], '..', '..', '..');
  let config, cases, sessions;
  try {
    config = JSON.parse(readFileSync(argv[at + 1], 'utf8'));
    if (!nonEmpty(config?.snapshot)) throw new Error('config snapshot: must be a non-empty string');
    cases = loadCases(JSON.parse(readFileSync(resolve(base, config.snapshot), 'utf8')), config.contract, config.requirement);
    if (cases.length === 0) throw new Error('no cases implement the requirement');
    validateConfig(config, cases, base);
    sessions = planSessions(config, cases);
  } catch (error) { return refuse(error.message); }
  const out = resolve(base, config.out);
  if (existsSync(join(out, 'manifest.json'))) return refuse(`${config.out} already holds a manifest: a rerun needs a fresh out, so no case is repeated selectively`);
  const host = [].concat(config.claude ?? 'claude');
  const versionRun = spawnSync(host[0], [...host.slice(1), '--version'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (versionRun.error || versionRun.status !== 0 || !(versionRun.stdout ?? '').trim()) return refuse(`the host did not answer --version: ${versionRun.error?.message ?? `exit ${versionRun.status}`}`);
  const runner = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  const manifest = {
    format: 'ia.trigger-eval-manifest.v1', mode: config.mode, model: config.model, skill: config.skill, contract: config.contract, requirement: config.requirement,
    runs: config.runs, cap: config.cap, sessions: sessions.length,
    caseSet: sha256(JSON.stringify(cases.map((c) => ({ id: c.id, prompt: c.prompt, shouldTrigger: c.shouldTrigger })))),
    host: { name: 'claude', version: versionRun.stdout.trim() },
    runner: { sha256: runner }, disable: config.disable, session: { ...SESSION, timeoutSeconds: sessionTimeout(config) },
    arms: config.arms.map((a) => ({ id: a.id, plugin: hashDirectory(resolve(base, a.pluginDir)) })),
  };
  mkdirSync(join(out, 'raw'), { recursive: true });
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const settings = config.disable.length ? ['--settings', JSON.stringify({ enabledPlugins: Object.fromEntries(config.disable.map((id) => [id, false])) })] : [];
  const results = [];
  const write = (complete) => writeFileSync(join(out, 'results.json'), `${JSON.stringify({ format: 'ia.trigger-eval-results.v1', complete, incomplete: results.filter((r) => !r.complete).length, unlisted: results.filter((r) => r.complete && !r.listed).length, summary: summarize(config, results), results }, null, 2)}\n`);
  write(false);
  // Sessions run in an empty directory outside the workspace, so they load none of its CLAUDE.md or .claude/.
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'trigger-eval-'));
  try {
    for (const session of sessions) {
      const arm = config.arms.find((a) => a.id === session.arm);
      const c = byId.get(session.case);
      const child = spawnSync(host[0], [...host.slice(1), '-p', '--output-format', 'stream-json', '--verbose', '--model', config.model,
        '--max-turns', String(SESSION.maxTurns), '--allowedTools', SESSION.allowedTools.join(','), '--plugin-dir', resolve(base, arm.pluginDir), ...settings], { cwd: scratch, input: c.prompt, encoding: 'utf8', timeout: sessionTimeout(config) * 1000, windowsHide: true });
      writeFileSync(join(out, 'raw', `${session.arm}-${session.case}-${session.run}.jsonl`), child.stdout ?? '');
      const parsed = parseStream(child.stdout ?? '');
      const v = verdict(parsed, config.skill);
      const complete = sessionComplete(child, parsed);
      results.push({ ...session, shouldTrigger: c.shouldTrigger, ...v, complete, correct: complete && v.listed && v.triggered === c.shouldTrigger, resultSubtype: parsed.resultSubtype, isError: parsed.isError, invoked: parsed.invoked, exit: child.status, signal: child.signal ?? null, error: child.error?.code ?? null });
      write(false);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const summary = summarize(config, results);
  const complete = results.every((r) => r.complete && r.listed);
  write(complete);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!complete) return refuse('the run is incomplete: some sessions did not finish or did not list the skill (see results.json)');
  if (!results.some((r) => r.triggered)) return refuse('no trigger observed in any session: detection may be blind or the skill never fires');
  if (summary.difference.interval95.high < 0) return 3;
  return 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
