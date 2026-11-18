# Repository Structure Vocabulary and Dependency-Role Grammar

`inventarch/ia-repo-kit` (`Apache-2.0`) defines `repo-system`: the public base vocabulary and offline structural verifier (`check-layers`) for declaring a Git repository, its ranked dependency layers, its packages, and its cross-layer functional areas. It contains no private repository names, no tenant corpora, and no hardcoded tier numbers, and it grants no host permissions.

## Words Minted by `repo-system`

| Word | Kind | Schema | Purpose |
| --- | --- | --- | --- |
| `@repository` | `definition` | `@schema repository` | Declares a Git repository's canonical credential-free `repository.url`, optional `repository.profile` tie, optional `repository.organisation` workspace identity, and optional single canonical `repository.knowledge-base` locator. |
| `@layer` | `definition` | `@schema layer` | Declares one ranked dependency tier (`layer.rank`, `layer.title`, optional `layer.paths`, optional `layer.policy`, optional `layer.repository`, and `require @layer` edges). |
| `@package` | `definition` | `@schema package` | Declares one codebase package (`package.name`, `package.path`, `package.layer`, optional `package.kind`, optional `package.repository`, and `require @layer` / `require @package` edges). |
| `@area` | `definition` | `@schema area` | Declares one functional boundary across layers (`area.packages`, `area.purpose`, optional `area.repository`, and `require @area` edges). |

## Public Dependency-Role Grammar (`package.kind`)

`package.kind` is optional (`id in [host, contract, core, adapter, view, composition, tool]`). Omitting `package.kind` means the package is **not classified**, allowing any repository to adopt `@package` incrementally without forced classification. When present, each value carries a rank-independent dependency-role definition:

| `package.kind` | Public Dependency Role | Checker-Enforced Dependency Rule (`check-layers`) |
| --- | --- | --- |
| `contract` | Shared types, schemas, interfaces, wire contracts, and protocol shapes with zero runtime I/O. | May `require` only `contract` packages (`CONTRACT_PURITY`). |
| `core` | Deterministic domain or algorithmic logic free of host, transport, and storage I/O. | May `require` only `core` or `contract` packages (`CORE_PURITY`). |
| `adapter` | Concrete boundary integration (storage, network, filesystem, external API, or SDK client) implementing or translating contracts. | May `require` classified runtime packages at equal or lower `layer.rank` (never `host` or `tool`). |
| `view` | User-interface components, visual state projections, and presentation surfaces free of deployable server/CLI entrypoints. | May `require` classified runtime packages at equal or lower `layer.rank` (never `host` or `tool`). |
| `composition` | Wiring assembly that binds `core`, `adapter`, and `view` packages for one application slice. | Cannot `require` another `composition` package at the same `layer.rank` (`COMPOSITION_ISOLATION`), nor `host` or `tool`. |
| `host` | Deployable runtime entrypoint (HTTP server, CLI binary, background worker, or desktop shell). | No `@package` may `require` a `host` package (`HOST_DEPENDENCY`), and a `host` package never depends on `tool` packages. |
| `tool` | Build, codegen, migration, or verification utility executed outside the production runtime closure. | Runtime packages (`contract`, `core`, `adapter`, `view`, `composition`, `host`) may never `require` a `tool` package (`TOOL_DEPENDENCY`). |

## Explicit Relationship Consent Rows

`repo-system` declares explicit relationship consent without broad wildcards:

- Structural `require` edges: `require layer using package`, `require layer using layer`, `require package using package`, `require area using area`.
- Outgoing citations from repository words: `cite * using repository`, `cite * using layer`, `cite * using package`, `cite * using area`.
- Repository ties: `cite repository using layer`, `cite repository using package`, `cite repository using area`.
- Specification anchors (`work-system`): `cite repository using spec`, `cite layer using spec`, `cite package using spec`, `cite area using spec`.

## Enforced vs Convention Standing

1. **Enforced by the IA 1.0 schema at admission (`ia validate`):**
   - Required sections and fields (`repository.url`; `layer.rank`, `layer.title`; `package.name`, `package.path`, `package.layer`; `area.packages`, `area.purpose`).
   - Typed references (`ref to repository`, `ref to layer`, `list of ref to package`) and `package.kind` enum membership.
   - Relationship consent rows (unconsented edges fail with `IA-LANG-EDGE-UNCONSENTED`) and single-owner word registration across composed systems.
2. **Enforced mechanically by `check-layers` (`scripts/layer-checker.mjs`):**
   - Finite numeric `layer.rank` and strictly lower `layer.rank` on every `@layer` `require @layer` edge (`LAYER_RANK_ORDER`).
   - `@package` `require @layer` matching `package.layer` (`PACKAGE_LAYER_MISMATCH`), and non-increasing `layer.rank` on every `@package` `require @package` edge (`PACKAGE_LAYER_ORDER`).
   - Directed acyclic graph (`require`) across `@layer`, `@package`, and `@area` records (`LAYER_CYCLE`, `PACKAGE_CYCLE`, `AREA_CYCLE`).
   - Canonical repository-relative POSIX `package.path` and `layer.paths` entries, and unique non-overlapping `package.path` roots per repository scope (`CANONICAL_PATH`, `PACKAGE_PATH_OVERLAP`).
   - Non-empty `area.packages` (`AREA_EMPTY`), credential-free `repository.url` (`REPOSITORY_URL`), and classified `package.kind` role boundaries (`CONTRACT_PURITY`, `CORE_PURITY`, `HOST_DEPENDENCY`, `TOOL_DEPENDENCY`, `COMPOSITION_ISOLATION`).
3. **Repository-level conventions (not claimed by the base schema or `check-layers`):**
   - Whether `package.kind` is mandatory for all packages in a repository.
   - Whether a `@package` belongs to at most one `@area` or participates in several cross-cutting areas.
   - How an external build-system or import-graph policy file reconciles with descriptive `.ia` records (when paired, the executable build policy enforces source imports while `.ia` records describe architecture).
   - Git repository visibility, which is governed by the Git host rather than duplicated as a mutable record field.

## Running `check-layers`

- **Through the `ia` plugin checker runner:**
  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs" check-layers --kit inventarch/ia-repo-kit --root <workspace>
  ```
- **Direct CLI invocation from an admitted workspace root:**
  ```
  node scripts/layer-checker.mjs <ia command words...>
  ```
