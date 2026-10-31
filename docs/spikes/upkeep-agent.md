# Spike: a background upkeep agent (2026-10-31)

Thomas's idea: a Sonnet agent, started for every task, that keeps the spec and everything derived from it up to date, including kit-made artifacts with bespoke output (a different voice, a Mermaid architecture map, a web page).

Status: spike. The prototype is `plugins/ia/scripts/upkeep.mjs`, `plugins/ia/agents/upkeep.md` and `plugins/ia/tests/upkeep.test.mjs` with its fixture. Nothing is wired into a lane, hook or manifest.

## Recommendation in one paragraph

Do not start a model for every task. Start one only when a deterministic script (`upkeep.mjs stale`) says something is stale, at task close, from the work lane's learn cell. The agent is a plugin agent with `model: sonnet`, `background: true` and `isolation: worktree`. It regenerates into its own worktree and returns a patch; the main agent (or the person) applies it. Kits declare derived outputs in a new `derived.json` sidecar: inputs, a generator (a script, which follows the handler trust rule, or a method capability the agent follows), an output path. Recorded input digests live in the workspace, not the kit. Report-only is the fallback when no worktree is available (Codex, Copilot).

## Findings

### 1. Triggering "for every task"

Sources: [sub-agents](https://code.claude.com/docs/en/sub-agents), [hooks](https://code.claude.com/docs/en/hooks), [plugins-reference](https://code.claude.com/docs/en/plugins-reference), [headless](https://code.claude.com/docs/en/headless). Fetched 2026-10-31 by a docs-research subagent from partial reads of long pages; re-verify exact wording before a release.

| Route | Verdict |
|---|---|
| Agent frontmatter `model: sonnet` | Works. Plugin agents also take `tools`, `maxTurns`, `background`, `isolation: worktree`, `effort`. They do not take `hooks`, `mcpServers` or `permissionMode` ("For security reasons, plugin subagents don't support..."). |
| `background: true` in frontmatter | Works, and keeps the agent in the background "even when Claude asks to wait for it". The docs list no per-call `run_in_background` parameter on the Agent tool, so the work lane should not instruct one; the frontmatter field carries it. Completion reaches the main session as a notification in a later turn. Permission prompts for a background subagent surface in the main session, so a write-capable agent can interrupt; this is a reason to keep its writes inside its own worktree. |
| A hook starts a subagent | Not possible. Hook types are `command`, `http`, `mcp_tool`, `prompt`, `agent`. `prompt` is a one-shot LLM check with a settable model; `agent` is experimental, read-only (Read, Grep, Glob), returns `{ok, reason}`. Neither is a general subagent. |
| Hook shells out to `claude -p --model sonnet` | Possible, not recommended. It starts a second session with its own cost and no shared context. Recursion: the child loads the same plugin and hooks; guard with `--bare` (skips hooks, plugins, MCP; needs `ANTHROPIC_API_KEY`, no OAuth) or `--settings '{"disableAllHooks":true}'`, plus an env guard. This is exactly what `ia:delegate` already does behind the person's word, with `IA_DELEGATION_DEPTH`; reuse that machinery only if a hook-started run is ever wanted. |
| Task events | `TaskCreated` and `TaskCompleted` exist but fire for the `TaskCreate`/`TaskUpdate` tools, not for IA tasks, which are records pinned by `ia_method`. They are not a reliable "task delivered" signal for IA. |
| `Stop` hook | `decision: "block"` with a `reason` makes the main agent continue, and `additionalContext` reaches it. So the existing `handlers.mjs stop` can run `upkeep.mjs stale` (deterministic, no model) and, only when it reports something, block once with "launch the upkeep agent with this report". `stop_hook_active` prevents a loop. This is the one route that makes the trigger mechanical rather than a request to the main agent. Caveat: Stop fires at every turn end, not task close, so gate it on the task pin being in its learn phase. |

Recommended trigger, cheapest first:

1. The work lane's learn cell (completion) runs `upkeep.mjs stale --base <task base> --json`. If `startAgent` is true, the main agent launches the `upkeep` agent with that JSON. Instruction-driven, works on every host that has skills.
2. Optionally a kit `handlers.json` `stop` entry (trusted publisher only) runs the same script and blocks once. Claude Code only.

Snippet for the work lane (documented, not wired):

```
At completion, before the learn cell's close step:
  node "${CLAUDE_PLUGIN_ROOT}/scripts/upkeep.mjs" stale --root <repository> --base <task base ref> --json
Exit 0 and no output: nothing stale; start nothing, say nothing.
Exit 3: launch the ia:upkeep agent (Agent tool, subagent_type ia:upkeep) with the JSON as its prompt.
It runs in the background in its own worktree and returns a patch; report the patch, do not apply it unasked.
```

### Host matrix

| Host | Start the agent | Deterministic check | Write safety |
|---|---|---|---|
| Claude Code | Plugin agent, `model: sonnet`, `background: true`; optional Stop-hook nudge | `upkeep.mjs stale` from the lane or handler | `isolation: worktree`, patch back |
| Codex | No plugin agents or hooks yet (`hosts.md`). The lane can run `codex exec` only through `ia:delegate`, the person's word | Lane runs `upkeep.mjs stale` itself via CODEX.md | Report only; or the person delegates a patch run |
| Copilot | No plugin, no hooks, no agents from us. The coding agent reads AGENTS.md | `upkeep.mjs` is a plugin script and is absent without the plugin; a repo would need it committed or run through the door | Report only |

The host-neutral part is the sidecar, the staleness script and the packet/capability the agent follows. Only the launch is host-specific.

### 2. A deterministic staleness check

`upkeep.mjs stale [--root] [--sidecar] [--base <ref>] [--changed a,b] [--json]`:

- For each declared output: hash the matched inputs (paths plus LF-normalized bytes, so CRLF cannot fake drift, as in `sourcesDigest`) and compare with the recorded digest. Reasons: `never-recorded`, `output-missing`, `output-edited` (a person changed it by hand; the agent must not overwrite it silently), `inputs-changed`.
- For the changed files (`git diff --name-only <base>` plus untracked), list records whose `source`, `cites` or `grounded-by` line names one. Output gives record, relation and `file:line`.
- Silent and exit 0 when nothing is stale; exit 3 when something is; `--json` adds `startAgent`. No model is involved.

Limit of the prototype: relations are found by a line match on `source|cites|grounded-by` in `.ia/src/**/*.ia`. A real implementation should ask the IA CLI (`ia read`, relationships) so that it follows the language's actual relation words and transitive closure. That needs the relation names confirmed from the language definitions, which this spike did not do.

Worked example (fixture `plugins/ia/tests/fixtures/upkeep/`, test 2 in `upkeep.test.mjs`): `architecture-map` (a Mermaid graph built from the records by `scripts/mermaid-map.mjs`) is `never-recorded`; `build` generates and records it; `stale` is silent; appending a `@decision` record makes it `inputs-changed`; `build` makes it fresh and the map now contains the new node.

### 3. How a kit declares derived outputs

Sidecar `derived.json` beside `handlers.json`, `checks.json` and the others (format 1):

```json
{ "format": 1, "outputs": [
  { "id": "architecture-map",
    "inputs": [".ia/src/**/*.ia"],
    "generator": { "script": "scripts/mermaid-map.mjs" },
    "output": "docs/architecture.mmd" },
  { "id": "spec-plain-voice",
    "inputs": ["docs/spec.md"],
    "generator": { "capability": "render-voice" },
    "output": "docs/spec.plain.md" } ] }
```

- `inputs`: workspace-root-relative globs. Record ids as inputs (the second form the brief asked about) are a follow-up; they need the CLI to resolve a record to its file or digest.
- `generator.script`: deterministic, `node <script> --root <ws> --out <file>`. It is code, so it follows `public-kit-trust` exactly like a handler `run`: trusted publisher, bytes equal the recorded release, script a declared asset, hygiene-wrapped child. The prototype's `--allow-code` flag stands in for that check; production `build` must call `kitTrust`. Add `derived.json` to `SIDECARS` in `lib/kit.mjs` so the sources digest covers it.
- `generator.capability`: a method capability the agent resolves with `ia_method` and follows (a voice rewrite, a web page). It runs no kit code, so it needs no trust beyond the packet's own pin, but its result is model output: proposed, never verified.
- Recorded digests: `<workspace>/.ia/derived.lock.json` (`inputs` digest and `output` digest per id). They belong to the workspace, not the kit, because the kit is an immutable release and the digests change with every edit. The lock is a plain file the agent's patch updates with the output.
- A kit is not a sandbox: a generator is a hygiene-wrapped process with the person's files. The only protection is the trust rule. An untrusted kit's `derived.json` is data: `stale` still reports its outputs, but `build` refuses and the agent follows only `capability` generators.

### 4. Write safety

| Approach | Verdict |
|---|---|
| Edit in place at task close | Races the main agent, which may still be editing; background permission prompts surface mid-task. Reject. |
| Scratch worktree, return a patch | Recommended. `isolation: worktree` is supported in plugin agent frontmatter; it needs a git repository and, for IA-governed repositories, the pre-tool gate applies inside it too (so a governed worktree may refuse the agent's writes: test this before shipping). |
| Report only | The fallback and the right default for Codex and Copilot, and for `output-edited`. |

Moves and scope. The agent needs Observation (read), Synthesis (the regenerated output or the record edit as a proposal) and, only for `build`/`record`, Execution inside its worktree. It should not need Delegation or Verification: a derived output is verified by the checker agent or a kit check, not by the agent that wrote it. The existing worker/reader/checker briefs already say role, not authority; the upkeep brief does the same. Open question: which `@mandate` covers it. The language workspace's `language-mandate` grants these five moves but the public plugin has no mandate record naming this agent; a kit mandate is a decision for Thomas.

Records are not edited blindly: for `citing` items the agent proposes the smallest edit or says the record still holds, and records are authored through the authoring lane rather than by hand, so a record patch should still pass `ia validate` before anyone applies it.

### 5. Cost and noise

Rough per-task estimate, Sonnet class, no measurement taken (assumptions: a 3-file change, 2 citing records, 1 stale output):

| Case | Tokens | Notes |
|---|---|---|
| Nothing stale (the common case) | 0 model tokens | Script only, about 100 ms, prints nothing |
| One script output stale | about 5-8k | Agent reads the report, runs `build`, reports; mostly fixed brief and tool overhead |
| One capability output (voice, page) | about 25-60k | Reads inputs, writes the output; scales with document size |
| Two citing records reviewed | about 15-30k | Reads each record and the changed file |

Always-on would burn the fixed overhead (system prompt, tool schemas, door packet) every task; gating makes the average the weighted mean of the cases, probably well under 10k per task. Keep it quiet: no output on a clean check, one line from the agent when it changed nothing, one patch path otherwise, `maxTurns: 25`, and capability generators only on request when the input digest actually changed (the digest is the whole gate, so an unchanged input never costs a model call).

## Open decisions for Thomas

1. **New nouns.** The design uses "derived output" (a thing generated from inputs), "upkeep" (the agent and the act) and possibly "rendition" for a voice rewrite. The brief's rule: kits and workspaces never mint words. Options: (a) keep them as plain English in this plugin's docs only, never as record words; (b) ask an owning `@system` to mint them (the likely owner is `template-system` or `workspace-system`; the language's own distribution decides). Recommendation: (a) now, and (b) for "derived output" only if kits need to cite one from a record.
2. **Where recorded digests live.** Options: workspace `.ia/derived.lock.json` (prototype); a record in the workspace; the kit's release. Recommendation: the lock file, since it is generated state, not authored. It needs an owner decision on whether it is committed.
3. **Trigger.** Options: lane instruction only; plus a trusted Stop handler. Recommendation: lane instruction first (works on every host); the Stop nudge later and Claude-only.
4. **Write mode default.** Options: patch from a worktree, report only. Recommendation: patch in a worktree on Claude Code, report-only elsewhere, `output-edited` always report-only.
5. **Mandate for the agent.** Which mandate lets it do Synthesis and Execution, and does a kit ship one? Recommendation: none in this release; the agent proposes patches and the person's own mandate applies them.
6. **Capability outputs are unverified.** Should a voice or page rewrite ever be marked fresh in the lock without a person's acceptance? Recommendation: no; `record` for capability outputs requires the person's word, matching "proposed until accepted".
7. **Relation source.** Replace the prototype's line match with CLI relation reads, and confirm the real relation words (`grounded-by`, `cites`, `source`) from the language definitions. Not done in this spike.
8. **Governed repositories.** Does the pre-tool gate allow writes inside an agent worktree? Untested here.

## What the prototype does not do

It does not wire a lane or hook, does not add `derived.json` to `SIDECARS` or the sources digest, does not call `kitTrust`, does not read relations from the CLI, and was not run through a real Claude Code session, so `background: true` plus `isolation: worktree` on a plugin agent is documented behaviour, not observed behaviour here.
