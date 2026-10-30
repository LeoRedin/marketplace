# Host support

| Host | What it loads | Hooks | Qualified |
|---|---|---|---|
| Claude Code | `.claude-plugin/marketplace.json`; the core's skills, agents, scripts and bundled kits, and the IA door as the plugin's MCP server `ia` (`.mcp.json`; tools `mcp__plugin_ia_ia__<tool>`, decision `public-door-mcp`) | The read-only SessionStart bootstrap (`startup\|resume\|compact`) and `scripts/handlers.mjs` for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop, which runs the handlers installed kits declare; all pinned by `tools/validate.py` (decisions `public-core-hooks`, `public-kit-handlers`) | Not yet (task `qualify-claude-code`) |
| Codex | `.agents/plugins/marketplace.json`; the core's skills and its `CODEX.md`. The door comes from the repository's committed `.codex/config.toml` entry (README, "Bootstrap a repository for every host") | None yet: the Codex manifest keeps the hooks off with `"hooks": {"hooks": {}}` and the plugin's door off with `"mcpServers": {}`, since Codex reads a plugin's `.mcp.json` too (task `codex-door-and-handlers`) | Not yet (task `qualify-codex`, `node tools/smoke-codex.mjs --codex <codex executable> --report <file>`) |
| GitHub Copilot | No plugin. The repository's committed door entry (`.vscode/mcp.json` in VS Code, or the repository's Copilot MCP configuration for the coding agent) and its instruction block (`.github/copilot-instructions.md` or `AGENTS.md`) | None: Copilot runs no hooks, so there is no bootstrap, account offer, governance probe or kit handler; the instruction block says to call `ia_session` first | Not yet |

Codex ignores `disable-model-invocation`, so it lists every skill; every skill therefore opens with the bridge line to `CODEX.md` (decision `public-codex-manifest-interface`). Without hooks, a Codex session gets no bootstrap, account offer, governance probe or kit handlers: `CODEX.md` tells the agent to run `scripts/bootstrap.mjs` itself.

## The IA door

The door is one MCP server, `@inventarch/mcp-door`, started with `npx -y @inventarch/mcp-door@3.4.1` (on native Windows, where `npx` is a `.cmd` shim, through `cmd /c`; this plugin's own entry runs `node scripts/door.mjs`, which does that for you). Its tools take structured input only. The lanes call three of them: `ia_session` once per session (the workspace, the installed kits, the three lanes and the current task pin, in at most 2,500 characters), `ia_catalogue {lane}` (the lane's keys with one-line descriptions, each `bound` or `installed`) and `ia_method {key}` (the packet, with the method pinned to the task). It finds kits in the folder `IA_KITS_DIR` names, which this plugin sets to its bundled kits, and in `<IA home>/kits`.

- **Claude Code with this plugin:** the plugin ships the door (`plugins/ia/.mcp.json`), so nothing else is needed. Agents and permission rules name its tools `mcp__plugin_ia_ia__<tool>`; a bare server key never matches a plugin's server.
- **Any host, with or without the plugin:** the repository commits the door entry and the instruction block (README, "Bootstrap a repository for every host"). This is the only way in for GitHub Copilot, in VS Code and in the coding agent, which runs no plugin and no hooks; a cloud session keeps only what the repository commits, and never delegates.
- **Until the framework release:** the 3.4.1 door serves its read tools but not yet `ia_session`, `ia_catalogue` and `ia_method`. The lanes then fall back to `scripts/resolve.mjs` and `kit.mjs list`, named in each lane as "until `@inventarch/mcp-door` ships `ia_method`" (task `drop-door-fallback`).

The InventArch account is a separate remote MCP server the person adds to their host (`https://api.inventarch.dev/mcp`); the host runs the OAuth sign-in, and nothing in this catalogue stores a token.
