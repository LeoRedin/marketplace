# Approval Vocabulary and Offline Seal Specification

`inventarch/ia-approval-kit` (`Apache-2.0`) defines `approval-system`: the public base vocabulary and offline cryptographic verifier for ratifying IA records in Git repositories. Neither the kit nor its `check-seal` verifier holds private keys, calls a remote service, or grants host execution permissions.

## Words Minted by `approval-system`

| Word | Kind | Schema | Purpose |
| --- | --- | --- | --- |
| `@approver` | `definition` | `@schema approver` | Registers a person's directory account, the workspace identities they may ratify, optional delayed recovery or Slack route notices, and their Ed25519 public keys. |
| `@approval-rule` | `governance` | `@schema approval-rule` | Declares which records require ratification (by `words`, `kinds`, `paths`, or `pieces unrecognised`), the distinct-approver `quorum`, allowed `via` routes, `key-kind`, `staleness`, and `merge` policy. |
| `@docket` | `definition` | `@schema docket` | Records per-piece pattern recognition (`matched`, `none`, or `ambiguous`), percent-encoded ASCII source references, source digests, and target-branch pattern identities from an intake or producing step. |
| `@approval` | `definition` | `@schema approval` | Stores one Ed25519 signature over the canonical `SealStatement` for one record addition, edit (`approve`), or deletion (`delete`). |

## Cryptographic Statement (`SealStatement`)

`check-seal` never reads a pre-serialized payload. It rebuilds the exact `SealStatement` JSON object from the `@approval` record's `seal.*` fields:

```json
{
  "action": "approve",
  "baseCommit": "<40 or 64 lowercase hex git object id>",
  "dependsOn": [{ "digest": "<64 hex>", "identity": "<record identity>" }],
  "keyId": "<unpadded base64url of sha256(raw 32-byte Ed25519 public key)>",
  "keyKind": "service-held",
  "language": "3.2.0",
  "organisation": "<outermost authored workspace identity>",
  "purpose": "inventarch-approval",
  "record": "<target record identity>",
  "recordDigest": "<64 lowercase hex compiled graph per-record digest>",
  "request": "<request audit identifier>",
  "revision": "<64 lowercase hex authored corpus revision>",
  "rules": [{ "digest": "<64 hex>", "identity": "<approval-rule identity>" }],
  "signedAt": "2026-11-18T00:00:00Z",
  "signer": "<approver person.account>",
  "systems": [{ "system": "<system name>", "version": "<version>" }],
  "version": 1,
  "via": "desk",
  "workspace": "<seating workspace identity>"
}
```

### Canonicalization and Signature Rules

1. **RFC 8785 JCS:** Object members are sorted by UTF-16 code units, arrays preserve their canonical sorted order (`dependsOn` and `rules` by `identity`, `systems` by `system`), strings reject lone surrogates (I-JSON, RFC 7493), and numbers must be finite.
2. **Public Key Identity:** Each `@approver` key entry spells `<key-id> ed25519 <base64url raw 32 bytes> <active|retired|revoked> <from-commit or ->`. `key-id` must equal `base64url(sha256(rawPublicKey))` with strict unpadded RFC 4648 section 5 encoding.
3. **Strict Ed25519 Verification:** Signatures are 64 bytes encoded as unpadded `base64url`. In addition to Node `node:crypto` Ed25519 verification over the UTF-8 JCS bytes, the upper 32-byte scalar `S` must be strictly less than the Ed25519 group order `L` (RFC 8032 section 5.1.7) so malleable `S + L` encodings are rejected.
4. **File Placement:** Each `@approval` lives in `.ia/src/approvals/<record-name>.<12-hex-record-digest>.<8-hex-key-tag>.ia`, where `<8-hex-key-tag>` is `sha256(keyId).slice(0, 8)`.

## Target-Branch Authority and Intake Dockets

- **Target-branch roster and rules:** When comparing `--target <ref>` against `--head <ref>`, `check-seal` reads `@approver` keys, `@approval-rule` selectors, and trusted pattern records exclusively from `--target`. A branch cannot ratify itself by adding a key, weakening a rule, or planting a pattern in the same pull request.
- **Built-in root floor:** Changes to `@approver`, `@approval-rule`, and already-ratified `@docket` records always require a person's merge (`needsPersonMerge: true`), forbid deleting the sole approver, and enforce roster quorum (`1` when target roster size `<= 1`, `2` distinct approvers when target roster size `>= 2`, including the subject account on key edits or deletions).
- **Docket guards:** A `@docket` cannot list any `@docket` in `docket.pieces` (`docket-self-vouching`), and `docket.producer` starting with `desk` cannot claim `matched` or a pattern (`desk-docket-matched`). When multiple new dockets classify the same piece, the least trusting classification wins (`none` over `ambiguous` over `matched`).

## Running `check-seal`

- **Through the `ia` plugin checker runner (workspace audit):**
  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs" check-seal --kit inventarch/ia-approval-kit --root <workspace>
  ```
- **Direct pull-request verification against a local Git clone:**
  ```
  node scripts/check-seal.mjs --repo <clone> --target <target-ref> --head <head-ref> --cli <path-to-@inventarch/cli/dist/main.js> [--json]
  ```
