# Security policy

## Supported versions

Security fixes target the latest release of the `ia` plugin on `main` and the kit releases it bundles. Claude Code and Codex install the catalogue from `main`, so a fix reaches users when it merges and they update the plugin (`claude plugin marketplace update inventarch`, then `claude plugin update ia@inventarch`). Older plugin versions are not patched in parallel; tagged releases are listed on the [releases page](https://github.com/inventarch/marketplace/releases).

## Reporting a vulnerability

Do not open a public issue for a security problem.

Report it privately through GitHub's vulnerability reporting form for this repository:

<https://github.com/inventarch/marketplace/security/advisories/new>

If you cannot use the form, email <admin@inventarch.dev>. Either route reaches the repository maintainers only. Include what you can of the following:

- The affected component: the `ia` plugin (a skill, an agent, the session hook, the kit handler runner, kit trust, the kit verbs or the door launcher), a bundled kit (`ia-method`, `ia-kb`, `ia-authoring`), the `@inventarch/public-kits` package or the repository tooling.
- The plugin and kit versions, the host (Claude Code, Codex or another), and the operating system.
- Steps to reproduce, including any `.ia` records, `.ia/bindings.json`, `.ia/governance.json` or kit folder needed.
- The impact you observed or expect.

We acknowledge reports in the advisory thread and keep you informed there as we assess and fix the problem. We ask that you give us reasonable time to publish a fix before disclosing details publicly, and we credit reporters in the advisory unless they ask otherwise.

## Scope

This policy covers the files published in this repository, the `@inventarch/public-kits` package published from it, and the releases tagged here. The `ia` CLI, the language and `@inventarch/mcp-door` are covered by the [inventarch/ia security policy](https://github.com/inventarch/ia/security/policy). Separately operated hosted services, including the InventArch account server the plugin offers to connect, are outside this repository's scope; report their problems to their operators.

What is in scope includes:

- **Kit trust.** A kit whose publisher is not on `plugins/ia/config/trusted-publishers.json`, or whose files are not its recorded release, running code through `handlers.json`, `onwrite.json` or `checks.json`; or an altered gate in a governed repository that does not fail closed.
- **Process hygiene.** A script the core starts receiving an environment variable outside its allowlist, outliving its deadline, or writing past its output cap.
- **Install paths.** `kit.mjs add --from` writing outside `<IA home>/kits`, following a link, or installing a dependency it did not find.
- **Shipped bytes.** A credential, machine path or private material in any shipped file.

Process hygiene is not a sandbox: a trusted kit's code runs as you. A report that a trusted publisher's kit can do what its own code does is not a vulnerability; a way to make an untrusted kit run code is.
