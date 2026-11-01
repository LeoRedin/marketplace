## What changes

<!-- The behaviour that changes and why. Link the issue if there is one. -->

## Records and generated files

- [ ] A new or changed decision has its `@decision` record in `.ia/src/decisions.ia` and its row in `docs/decisions.md`, or no decision changed.
- [ ] A new Markdown document is a record's `source` or sits under a spec's `covers` path, or no document was added.
- [ ] Kit sources were edited under `kits/`, never in a plugin's bundled copy, and the bundle, index and selection were regenerated, or no kit changed.
- [ ] A plugin's shipped files changed and `node tools/release.mjs note` added a note under `releases/pending/`, or no shipped file changed. Versions, `CHANGELOG.md` and `releases/changesets/` were not edited by hand.

## Checks run

<!-- List the commands you ran and the platform. Say what was not run. -->

```
npm test   # on <platform>
```

## Notes for the reviewer

<!-- Decisions you made, things you are unsure about, follow-ups you left out. -->
