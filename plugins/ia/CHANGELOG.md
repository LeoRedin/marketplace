# Changelog

## 1.1.0

The lanes go through the IA door, kits run handlers and depend on other kits, and governance arrives as a kit (decisions `public-door-mcp`, `public-kit-handlers`, `public-kit-dependencies`, `public-delegate`, `public-governance-probe` and `public-core-hooks`). No kit's bytes changed: the bundled releases stand.

- The plugin ships the IA door as its MCP server `ia` (`.mcp.json`: `npx -y @inventarch/mcp-door@3.4.1`, with `IA_KITS_DIR` set to the bundled kits). Claude Code names its tools `mcp__plugin_ia_ia__<tool>`.
- The lanes call `ia_session` once per session, then `ia_catalogue {lane}` to choose a key and `ia_method {key}` for the packet. Until `@inventarch/mcp-door` ships `ia_method`, they fall back to `scripts/resolve.mjs` and `kit.mjs list`.
- The reader, checker and worker allowlists name the door's tools by their plugin-scoped names; the checker now has the door tools too. The old `mcp__ia-workspace` entries never matched a plugin server and are gone.
- The SessionStart bootstrap also runs on `compact`, and then re-injects the current task pin's summary and how to resolve the same method again.
- Kit handlers: a kit's `handlers.json` declares session, prompt, tool (pre or post, with a tool-name match) and stop handlers, and `scripts/handlers.mjs` runs them from SessionStart (every source), UserPromptSubmit, PreToolUse, PostToolUse and Stop. Only installed kits whose folder holds the script run; each kit's context is capped at 2,000 characters; a pre block is honoured only with `.ia/governance.json`; with no handler declared every hook is a silent no-op. `onwrite.json` runs as tool post handlers, from the kits in `<IA home>/kits` too. `handlers.json` is a sidecar the sources digest covers, and `kit.mjs check` refuses a handler script that is not a declared asset.
- The governance probe no longer looks for a plugin: in a repository with `.ia/governance.json` where no installed kit declares governance handlers (a tool pre handler), it says "this repository is governed; add the ia-governance kit (`ia kit add`)".
- Kit dependencies: a kit whose `.ia/release.json` depends on another kit finds it carried by the plugin, in `<IA home>/kits` or next to it, and adoption (`kit.mjs add`), `add --from` and the restored read root vendor the dependency's recorded release with `ia install --catalog`.
- The user-invoked `ia:delegate` hands one packet-driven step to `codex exec` or `claude -p` with the door and the packet inline, one level deep (`IA_DELEGATION_DEPTH`), with a timeout. It is off until the person sets `"delegation": true` in `~/.ia/config.json`.

## 1.0.0

The first public release, cut on 2026-10-30 from InventArch's internal catalogue with fresh history (decisions `public-catalogue-cut` and `public-core-1-0-0`). It is a breaking release: repositories bound to a kit this core no longer carries must rebind.

- The plugin is `ia` (`ia@inventarch`; decision `public-plugin-ia`). Its model-invocable skills are the three lanes, `ia:work`, `ia:knowledge` and `ia:delivery`; the former router became the user-invoked `ia:init`, with the CLI-rendered plugin's init steps merged in, beside a new `ia:doctor`. Agents are `ia:reader`, `ia:checker` and `ia:worker`.
- Licence Apache-2.0; repository `inventarch/marketplace`.
- The bundled kits are exactly the public defaults: `ia-method` 0.7.0 (Work), `ia-kb` 0.9.0 (Knowledge) and `ia-authoring` 0.1.0 (Delivery; it replaces the retired `inventarch/host-authoring-kit` and `inventarch/catalogue-authoring-kit`). Each lane's entry capability is a whole four-phase procedure; Knowledge `place` maps to the plan phase; the core names no whole-procedure activity of its own.
- Kit lookup in two places: `config/kits`, then `<IA home>/kits/<kit>/<version>/`.
- `scripts/kit.mjs` user verbs: `list`, `add` (also `add --from <folder|archive>`), `bind`, `upgrade`, `repin`, `rebind` and `check`, each previewing unless `--apply` and validating before it writes; `root`, `status` and `adopt` stay.
- Releases format 2: the core reads a release index and `releases/<version>.json` (and still format 1); `lib/releases.mjs` converts losslessly; release history is left out of the implementation digest and the method closure capture.
- The SessionStart hook offers an InventArch account once per session at startup, never blocking, with no network and no token (suppressed by `"accountOffer": false` in `~/.ia/config.json`, `IA_NO_ACCOUNT_OFFER=1` or `CI`), and says once when a repository has `.ia/governance.json` but the governance plugin is not installed.
- Pins `@inventarch/cli` 3.4.1, with a regenerated qualified runtime cohort.
