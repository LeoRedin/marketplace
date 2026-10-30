# Changelog

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
