# Tasks: SQL Conversation Storage

## 1. Contract Docs (Phase 0)

- [x] 1.1 Rewrite `specs/conversation-storage.md`: transcripts in scope (remove the Non-Goals excluding them), define `junior_conversation_messages` / `junior_agent_steps` shapes, retention tiers, purge contract, and declare identity/destination FKs authoritative over the legacy `destination_json` / `actor_json` copies
- [x] 1.2 Update `specs/agent-session-resumability.md`: SQL step rows replace the Redis session-log authority, context-epoch vocabulary replaces `sessionId`/`projection_reset`, safe-boundary and resume contracts restated against `seq`/epoch
- [x] 1.3 Update `specs/data-redaction-policy.md` (retention tiers reference, expired-vs-redacted distinction) and `specs/advisor-tool.md` (child-conversation transcripts replace `transcriptRef`)

## 2. Schema And Stores

- [x] 2.1 Add Drizzle schema for `junior_conversation_messages` and `junior_agent_steps` under `chat/conversations/sql/schema/`, plus `parent_conversation_id` and `transcript_purged_at` on `junior_conversations`
- [x] 2.2 Add expand-only raw-SQL migration `0005_conversation_transcripts` with checksum pinning; verify with the migration runner against the PGlite fixture
- [x] 2.3 Implement `AgentStepStore` (append with lease-fenced `seq`, `loadCurrentEpoch`, `loadHistory`, `purgeConversation`) in `chat/conversations/history.ts` + `chat/conversations/sql/`; strict envelope validation via the existing Zod step union, fail-loud on corrupt rows
- [x] 2.4 Implement `ConversationMessageStore` (idempotent `record`, `list`, `replied_at` mark) in `chat/conversations/messages.ts` + `chat/conversations/sql/`
- [x] 2.5 Integration tests (PGlite): seq fencing PK violation, idempotent message recording, epoch projection reads, atomic `context_epoch_started` + replacement rows, child-conversation step scoping

## 3. Runtime Cutover

- [x] 3.1 Retarget the session-log reducer/projection code to `StoredAgentStep[]` (epoch-based), preserving the Pi projection and host-only-event filtering behavior
- [x] 3.2 Move `chat/state/session-log.ts` consumers (reply-executor, agent-continue-runner, turn-preparation, context-compaction, local runner, agent-dispatch runner, plugin task-runner) to `AgentStepStore`; compaction and provider-retry rollback write epochs, not `projection_reset` payloads
- [x] 3.3 Convert the advisor tool to child conversations: create child conversation rows, write steps under the child id, replace `transcriptRef` with `childConversationId`; update reporting's subagent transcript reader
- [x] 3.4 Move visible-message writes/reads (ingress recording, reply policy, channel-context assembly) to `ConversationMessageStore`; `replied` marks become `replied_at` updates
- [x] 3.5 Flip turn-session record cursors from `committedMessageCount` counts to `seq` references at the same cutover
- [x] 3.6 Update reporting/dashboard transcript builders to read steps/messages from SQL, excluding child conversations from top-level listings; keep redaction behavior byte-compatible
- [x] 3.7 Integration tests: cooperative yield → resume from SQL epoch, compaction rebuild, follow-up injection, subagent transcript render; eval only if agent-visible continuity behavior changes

## 4. Backfill

- [x] 4.1 Bulk import in `junior upgrade`: bounded newest-first scan of Redis session logs; translate sessions→epochs, explode `projection_reset` into marker + rows, convert advisor keys to child conversations, normalize v1 shapes; idempotent per conversation
- [x] 4.2 Timestamp fallback (message-internal → conversation timestamps) with tests asserting no fabricated import-time values
- [x] 4.3 Lazy per-conversation import under the conversation lease for logs the old deployment touched after the bulk snapshot; test the no-SQL-rows + Redis-log-present path
- [x] 4.4 Backfill visible messages from `thread-state` conversation state where present (best effort, idempotent)

## 5. Retention

- [x] 5.1 Retention policy module: `CONTENT_RETENTION_MS` constants, `retentionWindowFor(visibility)` fail-closed, root-resolution through `parent_conversation_id`
- [x] 5.2 Purge job: bounded batch over expired roots by `last_activity_at`, wholesale delete of messages/steps/descendants, `transcript_purged_at` stamp, private metadata scrubbing (title, channel name, actor JSON)
- [x] 5.3 Wire `/api/internal/retention` daily cron through `juniorNitro()` Vercel Build Output config (same pattern as the heartbeat cron)
- [x] 5.4 Expose `purgeConversation(conversationId)` as the erasure primitive
- [x] 5.5 Tests: tier resolution, visibility-flip window change, child-rides-root, bounded batching, expired-vs-redacted reporting distinction

## 6. Verification

- [x] 6.1 Add eval transcript assertion helpers in `junior-evals` (SQL-store-backed readers over the normalized session, e.g. `agentSteps(result.session)` / `conversationMessages(result.session)`), plus at least one eval case asserting a turn persists its `pi_message` steps in `junior_agent_steps` (right conversation, current epoch) and its visible messages in `junior_conversation_messages`; extend the advisor eval to assert the child conversation exists and holds the advisor steps
- [x] 6.2 Run `pnpm typecheck`, full test suite, and local-agent validation (`pnpm cli -- chat ...`) across the cutover slices

## 7. Dead-Code Deletion (Deferred To Follow-Up PR)

The cutover in group 3 stops all reads/writes to the legacy stores; deleting the
then-dead modules ships separately:

- Remove `conversation.messages` / `conversation.piMessages` from thread-state; shrink thread-state to runtime scratch with one Junior-owned TTL constant and one writer
- Remove the Redis session-log store, advisor session store, and conversation-details title/context keys (SQL title/context becomes the authority); the Redis→SQL import path (bulk + lazy) is the only legacy-aware code that remains
