# The public kits package

`@inventarch/public-kits` carries the three kits the `ia` plugin bundles (`ia-method`, `ia-kb`, `ia-authoring`) to a bare IA door or workspace as one npm package (decision `public-kits-package`; contracts C7 and C7b). npm is transport only: a repository records the package as one entry in its `.ia/distributions.lock.json`, and the IA engine expands each kit from its IA archive into `.ia/distributions/store/`, as an ordinary installed release.

## What it holds

`packages/public-kits/package.json` is committed. Its `version` is the package's own semver, set by hand. Every other byte is generated, and `ia.kits` is the claim a lock entry repeats:

```json
{ "id": "inventarch/ia-kb-kit", "version": "0.9.0", "archive": "<sha256 of the IA archive>",
  "manifest": "<sha256 of the archive's distribution.json>", "sources": "<sourcesDigest of the kit folder>", "folder": "ia-kb" }
```

Each row is the kit's latest release row in `plugins/ia/config/kits/<folder>/releases.json`. The package has no scripts, dependencies, entry points or `exports`.

The built files sit beside it:

| Path | From |
|---|---|
| `archives/<archive>.ia.tgz` | The kit's recorded release, packed again with the pinned `@inventarch/cli` 3.4.1 (`packRelease`). The build refuses bytes whose sha256 is not the recorded `archive`. |
| `archives/<archive>.distribution.json` | That archive's manifest. Its sha256 is the recorded `manifest`. |
| `kits/<folder>/` | `plugins/ia/config/kits/<folder>/`, byte for byte. |
| `index.json` | `kits/index.json`. |
| `LICENSE`, `NOTICE` | The repository's. |

The kit folders stay beside the archives. An archive holds a kit's records and declared assets, its scripts included, but not its sidecars (`delivery.json`, `bindings.json`, `checks.json`, `handlers.json`) or its release history, and a door reads those today. They can go once the IA engine takes them from the expanded store.

The built files are gitignored, not committed. The plugin and `kits/` already hold these bytes twice, and `bundle --check` proves they agree. The committed `package.json` binds the build to them by digest, and the build is deterministic: the same commit always gives the same archives, which the build checks against the recorded digests. Neither the export selection nor the consistency rules read the built files, so they gain nothing from committed bytes, while the history would gain a binary copy of every kit release.

## Commands

```sh
node tools/kit.mjs package --check            # a gate: package.json is the claim; built files, if present, match
node tools/kit.mjs package --write            # rewrite package.json's ia.kits, then build (needs the pinned CLI)
node tools/kit.mjs package --build            # build only; refuses a stale package.json
node tools/kit.mjs package --check --built    # the same check, requiring the built files
```

`--check` runs in lefthook, in `npm run check` and in the gates workflow. When a kit release changes (the stamp commit in [kits/README.md](../kits/README.md)), run `package --write` and raise the package version. `python tools/consistency.py --base <ref>` refuses a changed `ia.kits` whose version did not rise.

## Publishing (the operator's step)

`.github/workflows/publish-public-kits.yml` publishes the package. It has no trigger except `workflow_dispatch`, so only an operator starts it: from the Actions tab, or with `gh workflow run publish-public-kits.yml -R inventarch/marketplace --ref main`. No agent runs it. In order, it:

1. refuses any ref but `main`;
2. installs npm 11.6.2 (trusted publishing needs 11.5.1 or later) and the root dependencies with `--ignore-scripts`;
3. checks the bundle, the kit index and `package --check`;
4. refuses a version npm already has (`npm view @inventarch/public-kits@<version>`);
5. builds with the pinned CLI and runs `package --check --built`;
6. prints `npm pack --dry-run --json`, whose `integrity` is the value a lock entry records;
7. runs `npm publish --provenance --access public` under OIDC trusted publishing, with no token stored or passed.

Before the first run, the operator configures the trusted publisher on npmjs.com for `@inventarch/public-kits`: GitHub Actions, organisation `inventarch`, repository `marketplace`, workflow `publish-public-kits.yml`. If npm only lets a trusted publisher be added to a package that already exists, the operator makes the first 1.0.0 publish by hand from a build of the same commit (`node tools/kit.mjs package --build`, then `npm publish --access public` in `packages/public-kits`), adds the trusted publisher, and publishes every later version through the workflow.

After a publish, record the integrity the workflow printed, which `npm view @inventarch/public-kits@<version> dist.integrity` also returns. That is the npm integrity a repository's lock entry carries. A local `npm pack` can give a different integrity if its npm version compresses differently, so the published value is the one that counts.
