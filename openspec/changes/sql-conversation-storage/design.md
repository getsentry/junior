# Design: SQL Conversation Storage

## Context

Conversation content currently lives in the Redis/state store under three overlapping representations: `thread-state:<id>` (visible `ConversationMessage[]` plus a duplicate `piMessages` mirror; written at 7d by Junior and 30d by the Chat SDK), `junior:agent-session-log:<id>` (the canonical append-only Pi execution log, TTL supplied by every caller — in practice the SDK's 30d constant), and `junior:agent_turn_session:<id>:<sessionId>` (a read model holding count-based cursors into the log). Advisor subagent transcripts sit at a fourth ad-hoc key with a 7d TTL, referenced by a polymorphic `transcriptRef {type, key}`. The shared Junior SQL database (Neon Postgres, Drizzle, `junior_conversations`/`junior_identities`/`junior_destinations`) holds metadata only; `specs/conversation-storage.md` currently lists transcript moves as Non-Goals, which this change reverses.

Retention today is refresh-on-append whole-key expiry, unrelated to conversation privacy. `junior_destinations.visibility` is the persisted privacy authority used by redaction (`specs/data-redaction-policy.md`) but not by retention. Terminology was settled ahead of this change (`specs/terminology.md`): **turn** is canonical for response-producing execution; **step**, **slice**, **context epoch**, and **transcript** (reporting read model only) are pinned.

## Goals / Non-Goals

**Goals:**

- SQL is the single durable authority for visible messages and execution history; queryable for dashboards, analytics, and audit.
- Retention follows privacy: 14d private (fail-closed), 90d public, measured from `last_activity_at`, enforced by a purge job; writers own no TTLs.
- Fix format debts while data migrates anyway: row-per-message/row-per-step, epochs instead of embedded projection arrays, subagents as child conversations, natural keys, mutable delivery marks made explicit.
- Deploy-safe: expand-only schema, idempotent backfill, old deployment keeps working during promotion.
- Single-conversation erasure becomes a trivial primitive.

**Non-Goals:**

- Moving mailbox, lease, wake-up, or heartbeat state out of Redis (`specs/task-execution.md` unchanged).
- Replacing the turn-session read model with a `junior_agent_turns` table (follow-up slice; cursors flip from counts to `seq` here, storage stays).
- Retention for conversation metadata rows beyond purge-time scrubbing of private raw-payload fields.
- Strictly typing the Pi SDK's message payload shape.
- A workflow engine, event-sourcing framework, or generic queue in Postgres.

## Decisions

1. **Row per step, not a JSON list.** Redis forced list-shaped storage; Postgres makes each step a row with a strict envelope. Gives stable ordering references, partial reads, per-row schema versioning, and SQL queryability. _Alternative rejected:_ one jsonb array column per conversation — replicates the Redis shape and none of the benefits.
2. **Context epochs replace `projection_reset` payloads.** The old design embedded an entire replacement transcript inside one entry (the only atomic option in Redis). In SQL, compaction/rollback appends a `context_epoch_started {reason}` marker plus ordinary `pi_message` rows in one transaction; "current context" is a single indexed query (`highest epoch, pi_message, order by seq`). _Alternative rejected:_ Pi-coding-agent-style `firstKeptEntryId` pointers — avoids copying retained messages but Junior's compaction retains non-contiguous message sets, and pointer-chasing complicates the reducer. Copy volume is identical to today's embedded arrays.
3. **Natural keys throughout.** `conversationId` is globally unique (`slack:<channel>:<thread_ts>`, …), so PKs are `(conversation_id, seq)` and `(conversation_id, message_id)`; no surrogate identity columns, no invented `eventId` (inbound dedupe stays at the mailbox where it lives today). `seq` is assigned `max+1` transactionally under the conversation lease; the PK doubles as a fencing tripwire that fails loudly.
4. **Subagent histories are child conversations.** `parent_conversation_id` FK; advisor steps live under the child's own `conversation_id`; `subagent_started` carries a plain `childConversationId`. Kills the polymorphic `transcriptRef` (a Redis key locator), unifies read/redaction/retention paths, and makes future subagent kinds free. Listings filter `parent_conversation_id IS NULL`.
5. **One retention rule: TTL from last activity.** Content expires `window(visibility)` after `last_activity_at` and is deleted wholesale — the exact semantics Redis `pExpire`-on-append gives today, enforced by a job. Visibility is resolved at purge time via the parent chain to the root's destination (handles public↔private flips; fail-closed for missing/unknown). No stored `expires_at` (would go stale on flips). _Alternative rejected:_ additional age-based trimming of superseded epochs in live conversations — defensive complexity; additive later if a pathological conversation ever appears.
6. **Dedicated retention cron, not heartbeat.** Heartbeat is contractually "a repair loop, not a worker"; purge is a daily bounded-batch cron at `/api/internal/retention` whose failures cannot touch execution or recovery paths.
7. **Purge scrubs private metadata.** The metadata row survives purge (dashboard index), but `title`, `channel_name`, and legacy actor JSON are nulled for non-public conversations — otherwise the 14-day promise leaves raw payloads (per the redaction policy's definition) behind indefinitely. Reporting distinguishes expired from redacted.
8. **Strict envelope, permissive payload.** Envelope and step-type union validate via the existing Zod schemas and fail loudly; Pi message content stays passthrough (vendor-owned shape) with `schemaVersion` carried per row. No `payloadBytes` column — sizes for redacted reporting compute at read time (`octet_length`).
9. **Messages table declares its mutability.** `role`/`text`/`created_at` immutable; delivery bookkeeping is exactly `replied_at`. Resolves the hidden `meta.replied` mutation smell; reply policy gets a durable, queryable home.
10. **Migration: bulk backfill + lazy import, then hard cutover.** `junior upgrade` imports legacy Redis logs (bounded, newest-first, idempotent per conversation); conversations the old deployment touched during promotion import lazily on first read under the lease. No dual-write period. Backfilled timestamps come from message-internal Pi timestamps, falling back to conversation timestamps — never fabricated import-time values. Lazy import is deleted once the 30-day Redis TTL horizon passes.
11. **Terminology at the boundary.** New interfaces use `turnId`, `contextEpoch`; `session_0`-style markers translate to integer epochs at import; `transcript` appears only in reporting. Deployed historical names (`run_id` column, turn-session keys) are not renamed here.

## Risks / Trade-offs

- [Neon latency on the resume hot path] → Appends batch at safe boundaries; the projection read is one indexed query; both are negligible next to model calls. Store-boundary latency is logged per the instrumentation conventions.
- [Backfill fidelity: legacy entries lack per-entry timestamps] → Defined fallback order (message-internal → conversation timestamps); import tests assert no fabricated "now" values.
- [Old deployment writes Redis after the bulk backfill snapshot] → Lazy per-conversation import under the lease closes the promotion race; idempotence is per conversation (skip when rows exist).
- [Private retention drops 30d → 14d] → Intentional product decision; affects how far back private history reaches for users and dashboards.
- [Rollback/compaction copies retained messages into the new epoch] → Same data volume as today's embedded arrays; accepted for reducer simplicity.
- [Chat SDK remains a second `thread-state` writer until cleanup] → Final phase shrinks thread-state to scratch with one Junior-owned TTL and one writer; until then the mirror-removal only lands with its consumers moved.
- [Purge deletes rows the dashboard may be rendering] → Reads are point-in-time; a purged conversation renders as expired on next load, which the reporting contract covers.

## Migration Plan

1. **Schema + stores**: expand-only migration `0005_conversation_transcripts` (`junior_conversation_messages`, `junior_agent_steps`, `junior_conversations.parent_conversation_id` + `transcript_purged_at`); `AgentStepStore`/`ConversationMessageStore` implementations in `chat/conversations/sql/`; PGlite integration tests.
2. **Cutover + backfill**: runtime consumers move to the new ports; `junior upgrade` bulk-imports Redis logs; lazy import handles stragglers; turn-session cursors flip from counts to `seq`.
3. **Retention**: policy constants, purge job, `/api/internal/retention` cron, erasure primitive.
4. **Dead-code deletion (follow-up PR, deliberately deferred for safety)**: remove thread-state transcript mirrors, Redis session-log/advisor stores, conversation-details title/context keys (SQL becomes title authority), and — after the Redis TTL horizon — the lazy-import path. Keeping the legacy modules intact (unused) in the cutover PR preserves a clean rollback: reverting the cutover restores Redis-backed behavior while its keys are still live, and the lazy import re-converges conversations touched during a rollback window once rolled forward again.

Rollback: schema is expand-only, so a code rollback ignores the new tables; Redis keys continue expiring on their own schedule. Read cutover happens with the code deploy, so rolling back the code rolls back the reads.

## Open Questions

- Should conversation metadata rows (beyond scrubbed fields) eventually get their own retention window? Deferred; purge-time scrubbing covers the privacy exposure.
- `junior_agent_turns` (replacing the Redis turn-session read model) — follow-up change once this lands and cursors are `seq`-based.
- Whether `junior_conversations`' legacy JSON copies (`destination_json`, `actor_json`) are dropped in this change's cleanup phase or a later one; the FKs are already authoritative.
