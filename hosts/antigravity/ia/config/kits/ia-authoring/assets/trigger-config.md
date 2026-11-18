# Trigger evaluation config

The JSON config `scripts/eval-triggers.mjs` reads. The rules of a trigger evaluation are the `host-trigger-*` conventions of the `ia-authoring-host` system; this file keeps only the config shape the runner reads.

The config lives at `<workspace>/.ia/work/trigger-eval.json`; paths in it resolve against the workspace root.

| Field | Meaning |
| --- | --- |
| `mode` | `dev` or `gate` |
| `model` | the model to run; gate mode needs an `opus` model |
| `runs` | runs per case per arm: 1 in dev mode, 3 in gate mode |
| `cap` | the most sessions the run may start, a positive integer |
| `snapshot` | path of the captured snapshot |
| `contract`, `requirement` | the contract and requirement whose cases run |
| `skill` | the skill to detect, as listed in the host's init event |
| `arms` | exactly two plugins to compare: `{ id, pluginDir }` with the ids `original` and then `regenerated`, in that order, and existing directories |
| `disable` | installed plugin ids to switch off with `--settings`; the array must be present, and may be empty |
| `out` | the directory for the manifest, raw streams and results; it must not already hold a manifest |
| `sessionTimeoutSeconds` | optional per-session timeout, a positive integer of seconds; default 600 |
| `claude` | optional host command: a string, or an argument prefix as an array |

Every required field is checked before anything is written; a refusal names the field and exits 1.
