# InventArch marketplace

The public InventArch plugin catalogue (`inventarch`). It ships one plugin, `ia`, and the public method kits it carries.

| Plugin | What it is for |
|---|---|
| [ia](plugins/ia/README.md) | The core. Three lanes, `ia:work`, `ia:knowledge` and `ia:delivery`, plus the user-invoked `ia:init` and `ia:doctor`; a resolver over `ia position` that binds a task to a method kit and delivers its playbook cells as a packet; reader, checker and worker profiles; kit lookup, install and bind verbs; and two read-only hooks (a session bootstrap and an on-write check). |

## Kits

The core carries three public kits, one default per lane. Their sources are under [`kits/`](kits/README.md), and [`kits/index.json`](kits/index.json) lists each kit's latest release and the binding keys it offers.

| Kit | Lane | What it gives you |
|---|---|---|
| [`ia-method`](kits/ia-method/README.md) (`inventarch/ia-method-kit`) | Work | The IA operating loop, the ceiling on work that rests on a provisional foundation, and one method capability (a four-cell orient, plan, act, learn playbook) for every public IA record word, plus one over the vocabulary. |
| [`ia-kb`](kits/ia-kb/README.md) (`inventarch/ia-kb-kit`) | Knowledge | Where knowledge goes and where workspaces live, binding a document to its record, maintenance, checks, migration and review. |
| [`ia-authoring`](kits/ia-authoring/README.md) (`inventarch/ia-authoring-kit`) | Delivery | One authoring process in three parts: records of existing IA words, host plugins (lower, project, evaluate, qualify), and plugin catalogues. It replaces the retired `inventarch/host-authoring-kit` and `inventarch/catalogue-authoring-kit`. |

Each lane's entry capability is a whole procedure: a request with no specific activity gets all four phases, and `--phase` selects one.

More kits (meetings, governed work, organisation-wide knowledge custody, workspace and system design, and others) are available with an InventArch account. They are served by the InventArch API and installed into your IA home, never into this repository.

### Kit names

Every kit follows one pattern, public or not:

| Part | Name |
|---|---|
| Folder | `ia-<name>` |
| Kit id | `inventarch/ia-<name>-kit` |
| Main system | `ia-<name>` |
| Extra systems | `ia-<name>-<part>` (for example `ia-authoring-host`) |
| Workspace | `ia-<name>-kit` |
| Distribution | `ia-<name>-distribution` |
| Steward | `ia-<name>-steward` |

Whether a kit is public is shown by the repository that holds it, never by its name.

## Install

Claude Code:

```sh
claude plugin marketplace add inventarch/marketplace
claude plugin install ia@inventarch
```

To pick up a new version, run `claude plugin marketplace update inventarch` and then `claude plugin update ia@inventarch`.

Codex:

```sh
codex plugin marketplace add inventarch/marketplace
codex plugin add ia@inventarch
```

`codex plugin marketplace upgrade` refreshes the Git snapshot. If the plugin's version did not change, Codex keeps its cached copy: run `codex plugin remove` and then `codex plugin add`.

Then run `/ia:init` in a repository: it offers `ia init` and binds the default kits. By hand, in a repository that is an IA workspace:

```sh
node "<plugin root>/scripts/kit.mjs" list
node "<plugin root>/scripts/kit.mjs" bind inventarch/ia-method-kit --apply
node "<plugin root>/scripts/kit.mjs" bind inventarch/ia-kb-kit --apply
node "<plugin root>/scripts/kit.mjs" bind inventarch/ia-authoring-kit --apply
```

Every `kit.mjs` verb previews unless you pass `--apply`. `upgrade`, `repin` and `rebind` move a repository to a new kit release; `add --from <folder or archive>` installs a kit into `<IA home>/kits/<kit>/<version>/`.

### Coexisting with the CLI-rendered plugin

`ia host claude --user` (IA CLI 3.4.x) renders its own `ia@inventarch` plugin into `~/.ia/claude/marketplace` and registers that folder under the same catalogue name, `inventarch`. The CLI will change so that `ia host` adds this public marketplace and installs `ia@inventarch` from it instead of rendering its own plugin. Until that CLI release, remove the CLI-rendered registration first:

```sh
claude plugin marketplace remove inventarch
claude plugin marketplace add inventarch/marketplace
claude plugin install ia@inventarch
```

This plugin carries the rendered plugin's `init` and `doctor` skills (`ia:init`, `ia:doctor`).

### Names

Everything user-facing starts with `ia`: the plugin `ia`; its skills `ia:work`, `ia:knowledge`, `ia:delivery`, `ia:init` and `ia:doctor`; its agents `ia:reader`, `ia:checker` and `ia:worker`; and a capability bound to a lane, shown as `ia-<lane>:<activity>` whichever kit supplies it: the binding key re-spelled, so `work.milestone` reads `ia-work:milestone` and a lane's entry `work.*` reads `ia-work`. A kit extends a lane by binding its capability to that lane's key (a kit binding `work.brainstorm` adds `ia-work:brainstorm`). Kit ids (`inventarch/ia-<kit>-kit`) and the catalogue name (`inventarch`) do not change.

### An InventArch account

At the start of a session the core offers, once, to connect an InventArch account. Add the remote MCP server `https://api.inventarch.dev/mcp` to your host (for Claude Code: `claude mcp add --transport http inventarch https://api.inventarch.dev/mcp`); the host runs the sign-in. The plugin stores no token and makes no network call. To stop the offer, set `"accountOffer": false` in `~/.ia/config.json` or `IA_NO_ACCOUNT_OFFER=1`; it never appears when `CI` is set.

### Governed repositories

A repository adopted for governance (it has `.ia/governance.json`) needs the InventArch governance plugin, available with an account. Without it the core says so once per session and does not pretend the repository is ungoverned.

### Set it up for a team repository

Commit this to the repository's `.claude/settings.json` to have Claude Code offer the catalogue to everyone who opens it:

```json
{
  "extraKnownMarketplaces": {
    "inventarch": {
      "source": { "source": "github", "repo": "inventarch/marketplace" }
    }
  },
  "enabledPlugins": {
    "ia@inventarch": true
  }
}
```

Claude Code asks each person to trust the folder before it applies these settings. Nothing in this catalogue edits a person's own settings.

## Where workspaces live

Your workspaces default to `~/Documents/ia/<domain>` (for example `~/Documents/ia/studio`), and you can point elsewhere. `~/.ia` is the IA home only: configuration, state, the location registry and installed kits; the IA CLI refuses a workspace inside it.

## Work on it

Read [AGENTS.md](AGENTS.md), [docs/decisions.md](docs/decisions.md) and [docs/adding-plugins.md](docs/adding-plugins.md) first. Open work is in [docs/roadmap.md](docs/roadmap.md), and host support in [docs/hosts.md](docs/hosts.md). You need Python 3.11+ and Node 22.22.x. Run `npm ci` at the root once in each checkout: it installs lefthook, Biome and the pinned `@inventarch/cli` 3.4.1, and lefthook installs this repository's Git hooks. CI runs the same gates on every pull request into `main` (`.github/workflows/gates.yml`):

```sh
python tools/validate.py
python tools/selection.py --check
node tools/bundle-kits.mjs --check
node tools/kit.mjs index --check
python tools/consistency.py
npm run lint
node tools/check-language.mjs
python -m unittest discover -s tests -v
node --test "tests/*.test.mjs" "plugins/*/tests/*.test.mjs"
```

`tools/kit.mjs` holds the maintainer verbs (`pack`, `bundle`, `index`, `convert`); see [the kit README](kits/README.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
