# SQL Conversation Storage

## Why

Conversation content (visible messages and the model execution transcript) lives in Redis under three overlapping representations with inconsistent, caller-supplied TTLs (7 and 30 days mixed), making it unqueryable, impossible to retain by policy, and awkward to erase. Moving it into the shared Junior SQL database (Neon Postgres) makes conversations queryable for dashboards/analytics, lets retention follow conversation privacy (private 14 days, public 90 days), and is the one-time opportunity to fix structural problems in the stored format since the data must migrate anyway.

## What Changes

- Add two SQL tables to the shared Junior database: `junior_conversation_messages` (visible transcript, one row per message) and `junior_agent_steps` (durable execution history, one row per step).
- Replace the Redis list at `junior:agent-session-log:<conversationId>` as the execution-history authority. **BREAKING** for storage layout (runtime port contracts preserved; one-time backfill from Redis).
- Restructure the execution-history format: `projection_reset` entries carrying embedded transcript arrays are replaced by context epochs — every context message is always a row; compaction/rollback starts a new epoch (marker step `context_epoch_started {reason}`) and writes replacement messages as ordinary rows in one transaction.
- Model subagent (advisor) histories as child conversations: `junior_conversations.parent_conversation_id` FK replaces the ad-hoc `junior:<id>:advisor_session` Redis key and the polymorphic `transcriptRef {type, key}` reference.
- Add visibility-tiered retention enforced by a dedicated daily purge cron (`/api/internal/retention`): content expires `window(visibility)` after `last_activity_at` (private/unknown fail-closed 14d, public 90d), computed at purge time from current destination visibility; purge also nulls private raw-payload metadata (title, channel name, actor JSON) and stamps `transcript_purged_at`. Writers no longer own TTLs (the `ttlMs` parameter is removed from storage ports).
- Adopt the settled terminology at the new storage boundary: `contextEpoch` replaces `sessionId`/`session_0`, `turnId` replaces `runId` in new interfaces, `transcript` is reserved for the reporting read model (terminology flip already landed in `specs/terminology.md`).
- Shrink Redis `thread-state:<id>` to runtime scratch (artifacts, sandbox, processing) — the `conversation.messages` and `conversation.piMessages` mirrors are removed. Mailbox, lease, and wake state remain in Redis unchanged per `specs/task-execution.md`.
- One-time migration: bulk backfill in `junior upgrade` plus a lazy per-conversation import under the conversation lease for records touched by the old deployment during promotion; expand-only schema throughout.

## Capabilities

### New Capabilities

- `conversation-messages`: durable SQL storage for the visible conversation transcript — one row per user/assistant/system message with immutable source facts, explicitly updatable delivery marks (`replied_at`), and identity FKs.
- `agent-step-history`: durable SQL storage for the model execution history — one row per agent step, per-conversation `seq` ordering, context-epoch projection semantics (current epoch = model context), subagent histories as child conversations, and the resume/compaction/reporting read contracts.
- `conversation-retention`: visibility-tiered retention and purge — retention windows, fail-closed tier resolution via the parent chain to the root conversation's destination, the purge job contract (bounded batches, metadata scrubbing, `transcript_purged_at`), and single-conversation erasure as the same primitive.

### Modified Capabilities

<!-- No existing OpenSpec capabilities; repo-level contract docs affected are listed under Impact. -->

## Impact

- **Schema**: new migration `0005_conversation_transcripts` (expand-only) adding `junior_conversation_messages`, `junior_agent_steps`, and `junior_conversations.parent_conversation_id` + `transcript_purged_at`.
- **Code**: `packages/junior/src/chat/conversations/` gains `messages`, `history` (steps), and `retention` slices with Drizzle confined to `chat/conversations/sql/`; `chat/state/session-log.ts` consumers (~15 modules: reply-executor, agent-continue-runner, context-compaction, turn-preparation, local runner, advisor tool, reporting) move to the new `AgentStepStore`/`ConversationMessageStore` ports; turn-session read-model cursors flip from `committedMessageCount` counts to `seq` references at cutover.
- **Runtime/deploy**: new daily Vercel cron `/api/internal/retention`; `junior upgrade` gains the bulk backfill; Redis keys (`junior:agent-session-log:*`, advisor session keys, conversation-details title/context keys) become legacy and expire naturally after cutover.
- **Contract docs**: rewrite `specs/conversation-storage.md` (transcripts move in-scope; its current Non-Goals explicitly excluded this), update `specs/agent-session-resumability.md` (authority + epoch vocabulary), touch `specs/data-redaction-policy.md` (retention tiers), align `specs/advisor-tool.md` (child-conversation transcripts). `specs/terminology.md` flip already landed.
- **Data**: private-conversation content retention drops from ~30d to 14d; public extends to 90d; conversation metadata rows outlive content but are scrubbed of private raw payloads at purge.
