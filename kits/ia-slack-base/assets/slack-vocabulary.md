# Slack Base Vocabulary Reference (`slack-system` `0.1.0`)

`inventarch/ia-slack-base-kit` ships the public `@slack-channel` binding word, the five public Slack channel governance rules, and the offline `check-slack-channels` verifier so workspaces can author and verify Slack space settings 100% offline with zero live credentials or bridge dependencies.

## `@slack-channel` (`lowers to binding`)

| Field | Type | Required | Semantics |
| --- | --- | --- | --- |
| `meaning.says` | `text` | yes | Purpose of this Slack space for the bound workspace. |
| `meaning.answers` | `text` | no | Question this settings record answers. |
| `slack.label` | `text` | yes | Per-message work label shown to readers. |
| `slack.icon` | `text` | no | Single emoji icon shown with messages. |
| `slack.channel` | `text` | yes | Slack channel or conversation name. |
| `slack.channel-id` | `text` | no | Bound Slack conversation identifier (`C...`, `G...`, or `D...`). |
| `slack.workspace` | `ref to workspace` | yes | Admitted `@workspace` record this space serves. |
| `slack.home` | `text` | yes | Credential-free repository or workspace home locator. |
| `slack.approver` | `text` | yes | Slack user id (`<team-id> <user-id>` or `<user-id>`) for space checkpoints. |
| `slack.members` | `list of text` | yes | Allowed Slack user identifiers in this space. |
| `slack.app` | `id in [organisation, person]` | yes | Serving Slack app kind. |
| `slack.secret` | `text` | yes | Opaque secret reference name (`[A-Za-z0-9._:/-]+`), never a raw token. |
| `slack.answers` | `id in [off, on]` | no | Whether cited read-only model answers are enabled (`off` when omitted). |
| `slack.sources` | `list of text` | no | Allowed source locators in the space's read allow-list. |
| `slack.shows` | `list of text` | no | Allowed record identities or prefixes in the space's read allow-list. |
| `slack.kind` | `id in [design-channel, coordination-space, direct]` | no | Space role (`design-channel` when omitted). |
| `slack.form` | `id in [channel, group, direct]` | no | Slack conversation shape. |
| `slack.asks` | `list of id in [status, decision, space]` | no | What bound members may ask (`status` when omitted; `work` is never admitted). |
| `slack.rate` | `text` | no | Rate and size cap `"<messages-per-hour> <characters-per-message>"`. |
| `slack.creation` | `id in [app, person]` | no | Whether the Slack app or a person creates the channel. |
| `slack.disclosure` | `id in [link-only, content]` | no | Disclosure mode (`link-only` narrow default when omitted). |

## Public Channel Governance Rules

1. **`@law slack-user-bound-before-served` (blocking):** only bound Slack user identifiers listed in `slack.members` are served while directory access holds; unbound users in a served space receive one fixed notice with no internal service URL, and unknown direct/external senders receive silence.
2. **`@law slack-channel-audience-disclosure` (blocking):** reads are confined to `slack.shows` union `slack.sources`, `slack.disclosure` defaults to `link-only` (a fixed phrase and link only in shared spaces), `content` spaces require explicit non-wildcard allow-lists, and `person` app spaces are restricted to single-owner `direct` conversations.
3. **`@convention slack-text-is-data` (advisory):** inbound Slack messages, quotes, and attachments are untrusted data and never change settings, scope, membership, records, or approvals.
4. **`@convention slack-decision-answer-named-person` (advisory):** an open `@decision` counts only the first human reply or action from the named bound person while still in the space; other replies, edits, and bot messages are input only.
5. **`@convention slack-bot-non-execution-bounds` (advisory):** from Slack, the bot never merges, writes records directly, alters settings, invites unlisted users, holds signing keys, mentions `@channel`/`@here`, starts work, or ratifies by typed text.

## Offline Checker (`check-slack-channels`)

`scripts/check-slack-channels.mjs` inspects admitted workspace records through the resolved CLI and verifies:

- `SLACK_SECRET_TOKEN`: refuses raw Slack/API tokens (`xoxb-`, `xoxp-`, `xoxa-`, `xapp-`, `xoxe-`, `Bearer`, credentialed URLs, whitespace, or blank strings) in `slack.secret`.
- `SLACK_CHANNEL_ID_FORMAT`, `SLACK_CHANNEL_ID_DUPLICATE`, `SLACK_CHANNEL_NAME_DUPLICATE`: enforces valid unique Slack conversation ids and unique `(slack.app, slack.channel)` bindings across workspace records.
- `SLACK_WORKSPACE_UNRESOLVED`, `SLACK_HOME_INVALID`: verifies `slack.workspace` resolves to an admitted `@workspace` and `slack.home` is non-empty and credential-free.
- `SLACK_APPROVER_FORMAT`, `SLACK_MEMBERS_EMPTY`, `SLACK_MEMBER_FORMAT`, `SLACK_MEMBER_DUPLICATE`, `SLACK_APPROVER_NOT_MEMBER`: verifies valid Slack user identifiers (`U...`/`W...` or `T... U...`), non-empty deduplicated `slack.members`, and that the checkpoint approver's user id belongs to the space's member list.
- `SLACK_PERSON_APP_POSTURE`: requires `slack.app: person` spaces to have `direct` form/kind (when specified) and a single owner in `slack.members`.
- `SLACK_CONTENT_ALLOWLIST_EMPTY`, `SLACK_CONTENT_WILDCARD`, `SLACK_ANSWERS_ALLOWLIST_EMPTY`, `SLACK_RATE_FORMAT`: enforces bounded read allow-lists for `content` disclosure and `answers: on`, refuses wildcard `*` in `content` spaces, and checks `<messages-per-hour> <characters-per-message>` integer caps.
