# Host support

| Host | What it loads | Hooks | Qualified |
|---|---|---|---|
| Claude Code | `.claude-plugin/marketplace.json`; the core's skills, agents, scripts and bundled kits | The core's read-only SessionStart bootstrap (`startup\|resume`) and PostToolUse on-write check (`Write\|Edit\|MultiEdit`), pinned by `tools/validate.py` (decision `public-core-hooks`) | Not yet (task `qualify-claude-code`) |
| Codex | `.agents/plugins/marketplace.json`; the core's skills and its `CODEX.md` | None: the Codex manifest keeps the hooks off with `"hooks": {"hooks": {}}` | Not yet (task `qualify-codex`, `node tools/smoke-codex.mjs --codex <codex executable> --report <file>`) |

Codex ignores `disable-model-invocation`, so it lists every skill; every skill therefore opens with the bridge line to `CODEX.md` (decision `public-codex-manifest-interface`). Without hooks, a Codex session gets no bootstrap, account offer or governance probe: the `inventarch` skill tells the agent to run `scripts/bootstrap.mjs` itself.

The IA door (the `ia-workspace` MCP server) is registered per workspace by `ia host claude` or `ia host codex`, never by this catalogue. The InventArch account is a remote MCP server the person adds to their host (`https://api.inventarch.dev/mcp`); the host runs the OAuth sign-in, and nothing in this catalogue stores a token.
