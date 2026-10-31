# Knowledge placement

Choose by owner, audience and change coupling, not file extension.

| Knowledge | Usual canonical home |
|---|---|
| Company policies, shared product direction, cross-team PRDs and decisions | Organisation KB |
| Implementation-specific design, generated references, tests and operational procedures tied to code | Owning source repository |
| Shared native discovery anchor whose detailed body follows implementation | Organisation KB anchor plus pinned repository body |
| Employee-private work or personal drafts | Their explicitly authorised private context |

A public plugin contains reusable method expertise; it does not contain the organisation's approved private corpus. Installing it grants no company access. Public framework definitions and hosted subscription methods are different delivery products.

One company can expose several authorised workspace views over its corpus. A workspace composition and an audience label are not an ACL. Storage, direct readers, credentials, indexes and downstream copies must obey actual grants.

Keep a body close to code when changes should be reviewed atomically with implementation. Keep an anchor in the shared KB when organisation-wide discovery, status and cross-team relationships belong there. This is an option, not a mandatory split for every spec.

## Where workspaces live

| Location | What it holds |
|---|---|
| `~/Documents/ia/<name>` | A user's workspace, one folder per workspace named for its domain: `~/Documents/ia/studio`, `~/Documents/ia/music`, `~/Documents/ia/design`. The default; the user can point a workspace anywhere else. |
| `~/.ia` | The IA home only: config, state, the location registry and installed kits. Never a workspace: the IA CLI refuses a workspace inside its home, so work on a copy outside it. |
| A knowledge repository | One `.ia/src`, at the root. A personal or single-team KB declares one `@workspace` there. An organisation store declares one `@workspace` per department, each declaring its own scope folders, plus an organisation `@workspace` that also declares the repository root (`". @authored"`). |
| `workspaces/<name>/` in a repository | Only a workspace released or adopted on its own, with its own `.ia/src`. |

The nearest `.ia/src` decides which store a file belongs to, so keep any `workspaces/<name>/` folder apart from the scope folders the root's workspaces declare.
