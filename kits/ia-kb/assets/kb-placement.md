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
| A knowledge repository's root | One workspace (`.ia/src` at the root), with scope folders inside it for its areas. |
| `workspaces/<name>/` in a repository | Only a workspace that needs its own identity: its own seat, participant and mandates, with its own `.ia/src`. |

The nearest `.ia/src` decides which workspace a file belongs to, so keep the root workspace's scope folders and any `workspaces/<name>/` folder apart.
