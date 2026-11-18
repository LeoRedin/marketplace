# Native anchor and document body

The public spec word provides a named native anchor, work status, owner/source metadata and admitted relationships. A Markdown PRD/design/reference is a document genre, not automatically a new native discriminator.

Maintain one substantive native identity and one canonical body. Aliases identify that origin; they do not become independent authorities. A record may be in the company KB while its body is in the source repo.

work.source is a locator. It does not verify content, grant access, fetch remotely or prove freshness. Reading the anchor must not implicitly disclose the body. A document reader needs separately authorised resource access with matching scope, source revision, digest and finite budget. A local missing body is unavailable.

## A body in another repository

A local body takes an ordinary relative work.source. A body in another repository takes work.source text shaped as repo://repository-id/exact-commit/repo-relative-path, with the richer binding in a companion manifest of format ia.document-locators.v1, whose documents contain:

    documentId, specIdentity, repository, commit, path, sha256

This is a kit convention, not an implemented native resolver. Repository IDs are stable aliases, exact commits are hexadecimal object IDs, paths use forward slashes without absolute/traversal components, and sha256 identifies exact bytes. Local clone paths belong only in command/configuration input. Source occurrence metadata can be retained when available.

scripts/check-locators.mjs checks metadata. With --checkout repository-id=absolute-path it also checks that checkout's HEAD and file hash, including realpath containment. It never fetches, clones, follows a body locator remotely or prints the body. A metadata-only result cannot establish byte freshness. The split-body example (examples/split-body) is a worked manifest.

Updates must preserve the native identity and deliberately replace the pinned commit/digest after source review. Duplicate document IDs/native identities and mutable branches are refused. Relationships across native graphs still require selected source adoption with complete references; a locator does not supply graph closure.

No new spec fields or universal document profile are introduced by this kit. Native records still use the target canonical schema and #! ia 1.0. Preserve lifecycle decisions and actual acceptance authority.
