# ia

The core plugin: it carries no method of its own. Three entry points, `work`, `knowledge` and `delivery` (`delivery` took `development`'s place), state an activity to the resolver; the resolver reads which method kit the repository binds for that activity, pins it to the task, reads the kit's records through the IA CLI and delivers one packet; the agent follows only the packet. The public default kits ship under `config/kits/`: [`ia-method`](config/kits/ia-method/README.md) (Work: the IA operating loop, the provisional-foundation ceiling, and one method capability per public record word), [`ia-kb`](config/kits/ia-kb/README.md) (Knowledge: placement, document binding, upkeep, checks and review) and [`ia-authoring`](config/kits/ia-authoring/README.md) (Delivery: record, host and catalogue authoring). Further kits are looked up in `<IA home>/kits/<kit>/<version>/`, where `scripts/kit.mjs add --from` installs them (decision `public-kit-lookup`). Each lane's entry capability is a whole procedure, orient, plan, act and learn (decision `public-opal-per-lane`).

## What runs where

| Situation | What the core does |
| --- | --- |
| No `.ia/src` at or above the folder | The bootstrap says nothing about a workspace (at startup it may still make the account offer); a resolve refuses `IA-CORE-NO-WORKSPACE`. The skills say what is unconfigured. |
| A workspace with no `.ia/bindings.json` | The bootstrap says nothing is bound; a resolve refuses `IA-CORE-NO-METHOD` and names `kit.mjs list` and the kits that recommend the key (`kit.mjs bind <kit> --apply` writes their keys). |
| Session startup | Once per session, never blocking: the account offer when no InventArch account is found (suppressed by `"accountOffer": false` in `~/.ia/config.json`, `IA_NO_ACCOUNT_OFFER=1` or `CI`), and, in a repository with `.ia/governance.json` but no governance plugin, a notice that it is governed (decisions `public-account-offer`, `public-governance-probe`). |
| A bound activity, kit not installed | The resolver restores the kit into a per-user temp folder and reads the method and the kit's laws there; `--seat` sets only `scope.seat`. |
| A bound activity, kit installed (`.ia/distributions.lock.json`) | The method still comes from the restored kit; the laws and seat mandates come from the repository's own position at the seat (`--seat`). If the repository cannot position (an unrestored clone), the resolve refuses with IA's hint. |
| A task folder (`--project`/`--task`, or `IA_CORE_RUN_ROOT`) | The resolve is pinned: later resolves keep the pinned kit version and report `kitUpdateAvailable`; `--rebind` writes a new revision with `supersedes`. |

Delivery checks the optional hosted stage for UX, UI, design-system and brand intent. Only an operator-bound, authorized and available service executes remotely; missing binding or unavailable runtime continues through native Delivery resolution. The four offerings share one selected hosted workspace.

## Files

| File | Use |
| --- | --- |
| [`init`](skills/init/SKILL.md) (`ia:init`, user-invoked) | Setting IA up here: `ia init`, the default kits and their bindings, diagnostics, how resolution works, the delivery protocol in full. |
| [`doctor`](skills/doctor/SKILL.md) (`ia:doctor`, user-invoked) | What is not ok here and the command that fixes it, never run without the person's confirmation. |
| [`work`](skills/work/SKILL.md), [`delivery`](skills/delivery/SKILL.md), [`knowledge`](skills/knowledge/SKILL.md) | The three lanes (`ia:work`, `ia:delivery`, `ia:knowledge`), the plugin's only model-invocable skills: each resolves its lane's activity and follows the packet. |
| [`design-stage`](references/design-stage.md) | Optional operator-bound hosted UX, UI, design-system and brand service stage reached through Delivery; [client reference](references/design-service.md). Software and IA architecture design use the native method. |
| [`reader`](agents/reader.md), [`checker`](agents/checker.md), [`worker`](agents/worker.md) | Role briefs: read-only evidence, the constrained check runner, and bounded changes; each takes its role from the packet's `role.brief`. |
| `scripts/resolve.mjs` | `--entry --activity [--subject] [--seat] [--root] [--shape --phase] [--project --task [--run]] [--pin\|--no-pin] [--rebind] --json`: the packet, or a refusal. |
| `scripts/kit.mjs` | The user kit verbs, each previewing unless `--apply`: `list`, `add <kit> [<repo>]`, `add --from <folder\|archive>`, `bind <kit> [<repo>] [--key --capability [--profile]]`, `upgrade [<kit>] [<repo>]`, `repin --project --task`, `rebind <from> <to> [--keys]`, `check [<kit>]`; and `root`, `status`, `adopt`. |
| `scripts/bind.mjs` | `show [<repo>]`, `set <key> <kit> <capability> [<repo>] [--add]`, `default <entry> <kit> <capability>`, `precedence <kit...>`, `recommend <kit> [<repo>] [--apply]` (a kit's recommended keys; `--apply` writes only those the repository does not bind). |
| `scripts/check.mjs` | `<check-name> [--root] [--kit] [--manifest <workspace-relative-file>]`: runs one declared `@check` with its fixed argv and declared data slots; anything else is `IA-CORE-CHECK-UNKNOWN`. |
| `scripts/ceiling.mjs` | `[--root] [--plan] [--task] [--json]`: each task's layer above a provisional foundation (the `ia-method` kit's law); `--task` exits 1 beyond the ceiling and 2 when unknown. |
| `scripts/ia.mjs` | Runs IA: `IA_CLI_PATH`, else the repository's pinned `@inventarch/cli`, else exactly 3.4.1 through npx; never an `ia` on PATH. |
| `scripts/bootstrap.mjs` | The SessionStart hook (`startup\|resume`, 15 s): read-only context inside an IA workspace; at startup only, the account offer and the governance notice. |
| `scripts/on-write.mjs` | The PostToolUse hook (`Write\|Edit\|MultiEdit`, 30 s, off in Codex): runs the on-write checks carried kits declare (`onwrite.json`) for the file just written and returns their report as context; silent otherwise, never blocks. |
| `scripts/lib/scratch.mjs` | Scratch capture for kit scripts: copies a workspace's `.ia` and adopted source roots to a temp folder and runs `ia capture` there, with the CLI this plugin resolves. |
| `scripts/design.mjs` | Bounded JSON-stdin client for all four hosted design offerings. Requires an operator-owned service binding and existing admitted OAuth service token; workspace adoption and runs are explicit. |
| [`config/kits`](config/kits/README.md) | The kits, as text sources. |

## Contracts

**Bindings** (`<repo>/.ia/bindings.json`, interim until lowered to records): `{ "format": 1, "bindings": { "<entry>.<activity>": { "kit", "capability" } }, "precedence": [kit ids], "defaults": { "<entry>": { "kit", "capability" } } }`. A key may hold a list of candidates; `<entry>.*` answers an entry's other activities; `precedence` (first wins) resolves several candidates for one key, else `IA-CORE-CONFLICT` lists them.

**Task binding** (`<IA home>/work-v1/<project>/<task>/binding.json`, the IA home being an absolute `IA_HOME`, else `~/.ia`; format 3): `{ format: 3, revision, workspace: {root, revision}, task, kits: { <kit id>: {version, archive, sources, implementation, retained} }, keys: { <entry>.<activity>: {kit, capability, profile, records, scopeKey, intent} }, createdAt, supersedes }`, one entry per activity key the task resolved and one version per kit. A new key joins in a new revision; a changed binding for a pinned key needs `--rebind` (`IA-CORE-REBIND-REQUIRED`). Earlier revisions stay as `binding.<n>.json`; formats 1/2 remain inspectable, but execution requires an explicit rebind to retained bytes. Compare-and-swap publication under a task lock refuses stale writers; an abandoned lock requires operator recovery. A pin for another repository is refused (`IA-CORE-RUN-MISMATCH`). **Unbound resolve**: outside an IA workspace, `--kit <kit> --capability <name> [--profile <name>]` names the method directly (`binding.via: "unbound"`, nothing pinned); inside one it is refused (`IA-CORE-UNBOUND-IN-WORKSPACE`).

**Packet**: `{ contract: 1, resolver, binding: {key, via, kit, capability, revision, supersedes, pin, run}, closure: {kit, version, archive, sources, implementation, retained, records}, scope, instructions: [{playbook, address, text, digest?, source: "position"|"playbook"}], references: [{identity, digest, when: "always"|"seat"|"role"|"as-needed"}], role: {profile, brief}, requestedOperations, effectiveOperations: {status: "host-determined", runner}, missing: [{kind, message, ...}], evidence: {required, states}, kitUpdateAvailable, envelope, digest }`. The digest is sha256 over the sorted-key JSON of `{closure, scope, instructions, references, role, requestedOperations, evidence, effectiveOperations}`; the runtime envelope is outside it. A capability that composes checks adds `{kind: "enforcement", requirement: "constrained-checks", via: "scripts/check.mjs"}` to `missing`: equal content never implies equal permissions. `evidence.required` holds the checks the capability composes; `effectiveOperations.runner` every check the kit's `checks.json` declares. A `when: "role"` reference is the bound profile's own mandate. `instructions` are the isolated method position's cells of the bound playbooks at the scope key, or every cell of them, read by identity, for a whole-procedure activity, a capability the kit's `delivery.json` declares whole, or a position that delivers none of them.

**Scope keys**: `work` activities map to `governance/plan` (task, decision, default), `sequence/plan` (dependencies), `execution/act` (delegation), `context/orient` (progress), `learning/learn` (completion); `delivery` to `context/orient` (understand, diagnose), `governance/plan` (design), `execution/act` (change, default), `learning/learn` (review, deliver); `knowledge` to `context/orient` (find, explain, packet, default), `governance/plan` (place), `learning/learn` (reconcile), `execution/act` (maintain). `--shape` and `--phase` override. A capability its kit's `delivery.json` declares whole carries every cell of its playbooks, read by identity in phase order; any activity whose position delivers no cell of the bound playbooks gets them the same way.

**Retained methods:** the legacy format-3 task pin retains kit/core bytes separately from consumer position. The opt-in complete method contract uses format-4 pins and packet/2, exact runtime attestation, admitted native ownership/composition, retained source/assets/helper bytes and reviewed runner profiles. Missing or changed content refuses without falling back to the current plugin. In an adopted repository the consumer position supplies the packet's laws and seat mandates. A composed check the kit's `checks.json` gives no runner is IA-evaluated when its record runs a built-in evaluator other than `COMP-CHECK` (such as `COMP-COVERAGE`): `ia validate` gives its verdict, it stays in `evidence.required` and `missing` names it (`kind: "ia-evaluated"`). A composed `COMP-CHECK` without a runner is host-run: it stays in `evidence.required` and `missing` reports it (`kind: "check-unavailable"`); a capability none of whose `COMP-CHECK` checks has a runner refuses (`IA-CORE-CHECK-UNAVAILABLE`). The catalogue's validator refuses a host-run check that is not on its maintainer list (`HOST_RUN_CHECKS` in `tools/validate.py`). The KB checks and the authoring field-lint have explicit executor profiles; arbitrary Node imports and ambient executors remain unsupported. A result is execution evidence, not a qualified receipt or host authorization.

## Install and test

```sh
claude plugin install ia@inventarch
codex plugin add ia@inventarch
node --test "tests/*.test.mjs"
```

Node 22. The tests build their kits and a stand-in CLI at runtime and touch no network; `IA_CORE_TEST_CLI=<@inventarch/cli 3.4.1 dist/main.js>` enables the real-CLI cases the kits add.

### Task locator manifests

A check may declare `"arguments": {"manifest": "workspace-file"}` and place `${ARG:manifest}` in one whole argv slot after its executable. `check.mjs --manifest <relative-path>` fills it with a validated regular file inside the workspace. It rejects traversal, absolute paths, links, missing files, duplicate options and arguments that the selected check does not declare. It never adds arbitrary flags or runs a shell. This first argument type serves `ia-kb` 0.3.0's `kb-check-task-locators`; task slugs, base revisions, design roots and checkout mappings remain follow-up work. Path validation is an input boundary, not a sandbox against concurrent filesystem mutation.

### Delivery migration

The reconciled core uses `delivery` only. Rename `development.<activity>`, `development.*` and `defaults.development` bindings to their Delivery equivalents after updating every host. Existing task pins require an explicit `--rebind` for each migrated activity; this writes a new revision and preserves the old revision as history. Review the selected kit and capability before rebinding.

## Supervised service composition

Internal callers of `runMethodCheck` may select `processGroup: "inherited"` only when the calling process is the leader of a supervisor-owned POSIX group; on POSIX the call refuses otherwise. Ordinary calls keep isolated groups. This internal option is not an evaluator argument or an environment switch. An inherited evaluator shares the outer lifetime: its abort kills the caller's whole group, including the caller. Isolated groups are cleaned after root exit, including abrupt exit; when that cleanup kills a live descendant, the result sets `descendantsTerminated` and the descendant's later output is not captured; process and pipe errors terminate descendants before refusal. Windows retains the pinned taskkill tree supervisor, runs no root-exit cleanup and reports `descendantsTerminated: false`; complete service crash containment additionally requires a separately qualified kill-on-close Job Object launcher. These process observations confer no native, ledger or receipt qualification.
