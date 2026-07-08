# conversation-retention

## ADDED Requirements

### Requirement: Content retention follows conversation visibility from last activity

Conversation content (message rows, step rows, and descendant conversations' content) SHALL be retained for `window(visibility)` after the conversation's `last_activity_at`: 90 days when the root conversation's destination has persisted visibility `public`, 14 days otherwise. Any visibility other than persisted `public` — including `private`, `direct`, `unknown`, and a missing destination — SHALL resolve to the private window (fail closed). Windows SHALL be owned by named policy constants; storage write paths SHALL NOT accept or apply per-write TTLs.

#### Scenario: Private conversation expires at 14 days

- **WHEN** a private conversation's `last_activity_at` is more than 14 days old at purge time
- **THEN** its content is deleted

#### Scenario: Public conversation retained past 14 days

- **WHEN** a public conversation's `last_activity_at` is 15 days old
- **THEN** its content is retained until 90 days after last activity

#### Scenario: New activity restarts the clock

- **WHEN** a conversation receives an accepted inbound message or a finalized assistant delivery
- **THEN** `last_activity_at` advances and the retention window is measured from the new value

### Requirement: Visibility is resolved at purge time through the root conversation

The purge job SHALL compute each conversation's window at purge time by resolving the parent chain to the root conversation and reading its destination's current persisted visibility. No `expires_at` SHALL be stored. Descendant (subagent) conversations SHALL NOT have independent retention clocks; they purge with their root.

#### Scenario: Visibility flip shortens retention

- **WHEN** a channel's destination visibility changes from `public` to `private`
- **THEN** the next purge pass applies the 14-day window to conversations in that destination

#### Scenario: Child rides the root's window

- **WHEN** an advisor child conversation belongs to a public root conversation
- **THEN** the child's content is retained on the root's 90-day clock and deleted when the root is purged

### Requirement: Purge deletes content wholesale and scrubs private metadata

When a conversation expires, the purge job SHALL, in bounded work: delete all of its message rows, step rows, and descendants' content; stamp `transcript_purged_at` on the conversation row; and, for non-public conversations, null the raw-payload metadata fields (`title`, `channel_name`, actor JSON) so purged private conversations retain only safe metadata. The conversation metadata row itself SHALL survive purge. Reporting SHALL present purged content as expired, distinct from redacted.

#### Scenario: Private conversation purged

- **WHEN** the purge job processes an expired private conversation
- **THEN** its messages and steps are deleted, `transcript_purged_at` is set, its title/channel name/actor JSON are nulled, and the conversation still appears in listings with a generic label

#### Scenario: Expired is distinct from redacted

- **WHEN** the dashboard requests a purged conversation's transcript
- **THEN** the response indicates the content expired under retention, not that it was redacted for privacy

### Requirement: Purge runs as a dedicated bounded cron

Retention SHALL be enforced by a dedicated scheduled job (daily Vercel cron at `/api/internal/retention`), not by the heartbeat repair loop. Each run SHALL process a bounded batch ordered by `last_activity_at` and leave remaining work for later runs. A purge failure SHALL NOT affect task execution, heartbeat recovery, or delivery paths.

#### Scenario: Bounded batch under backlog

- **WHEN** more conversations are expired than one run's batch limit
- **THEN** the run purges up to the limit and the next run continues from the remaining backlog

### Requirement: Single-conversation erasure uses the purge primitive

The system SHALL expose `purgeConversation(conversationId)` deleting one conversation's content and descendants immediately, regardless of age, applying the same metadata scrubbing.

#### Scenario: Erasure request honored

- **WHEN** an operator invokes erasure for one conversation id
- **THEN** its messages, steps, and descendant content are deleted and its private metadata fields are scrubbed without waiting for the retention window
