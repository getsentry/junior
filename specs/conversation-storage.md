# Conversation Storage

## Metadata

- Created: 2026-06-11
- Last Edited: 2026-07-11

## Purpose

Define Junior's SQL-backed storage contract for durable conversation content and
queryable conversation records. SQL is the single durable authority for the
visible conversation messages and the model execution history; retention follows
conversation privacy and is enforced by a purge job rather than caller-supplied
TTLs.

This storage is the feature-owned slice of Junior's shared SQL database. It
supports stats, dashboard lists, audit queries, conversation configuration,
durable source/destination/identity metadata, durable visible messages and agent
steps, and deploy-safe schema evolution. Plugin-owned SQL extensions are governed
by `./plugin-database.md`. Canonical execution vocabulary (turn, slice, step,
context epoch, transcript) is owned by `./terminology.md`; this spec uses those
terms as defined there.

## Scope

- Conversation records and query indexes.
- Visible conversation messages (`junior_conversation_messages`).
- Model execution history as agent steps (`junior_agent_steps`), including context
  epochs, compaction/rollback markers, and subagent child conversations.
- Execution status summaries and run/checkpoint timestamps.
- Conversation display details such as title, channel, source, destination, and
  actor.
- Conversation-scoped configuration entries.
- Visibility-tiered content retention, the purge job contract, and
  single-conversation erasure.
- SQL schema migration and one-time Redis import behavior on Vercel with Neon
  Postgres in production.

## Non-Goals

- Moving pending inbound mailbox payloads to SQL.
- Moving lease ownership and worker wake-up state to SQL.
- Replacing the turn-session read model with a `junior_agent_turns` table
  (follow-up slice; read-model cursors flip from counts to `seq` here, storage
  stays in Redis).
- Retention for conversation metadata rows beyond purge-time scrubbing of private
  raw-payload fields.
- Strictly typing the Pi SDK's message payload shape.
- Adding a general workflow engine, event-sourcing framework, or durable task
  database.

## Contracts

### Data Authorities

SQL owns durable, queryable Junior data: conversation records and their long-term
metadata, the visible conversation messages, and the model execution history.
Plugin tables may join the same shared database through the package migration
contract in `./plugin-database.md`.

- `junior_conversations` is the authority for title, channel, source,
  destination, actor, activity, execution metadata, and cumulative conversation
  runtime/token usage. Redis has no parallel conversation-details or dashboard
  metrics record.

- `junior_conversation_messages` is the authority for visible conversation
  messages. The `conversation.messages` mirror in Redis `thread-state:<id>` is
  removed.
- `junior_agent_steps` is the authority for the model execution history. It
  replaces the Redis list `junior:agent-session-log:<conversationId>` and the
  `conversation.piMessages` mirror in `thread-state:<id>`. The resume and
  projection semantics that consume this table are owned by
  `./agent-session-resumability.md`.

Redis retains only transient execution and runtime state, per
`./task-execution.md`:

- `junior:conversation:<conversationId>` stores pending inbound mailbox entries,
  lease ownership, active execution state, and worker recovery indexes.
- `conversation:active` and `conversation:by-activity` remain the bounded state
  indexes used by task execution and as the metadata backfill source.
- `thread-state:<conversationId>` retains only runtime scratch — artifact state,
  sandbox identity and dependency-profile hash, and processing state — under a
  single Junior-owned TTL and a single writer. Its visible-message and
  Pi-message transcript mirrors are removed.

Reporting reads content through SQL. The reporting read model rendered from
`junior_conversation_messages` and `junior_agent_steps` is the transcript
(`./data-redaction-policy.md`); storage tables and runtime ports must not use
`transcript` to name stored data.

### Conversation Store Boundary

Runtime, services, ingress, scheduler, and dashboard modules must depend on small
feature storage ports. Drizzle owns SQL schema definitions and typed query
implementation details. The shared Junior database is app-wide (chat, reporting,
handlers, CLI, dashboard), so the SQL infrastructure boundary lives at
`packages/junior/src/db/`: the canonical schema folder is
`packages/junior/src/db/schema/` (one file per table), composed into
`juniorSqlSchema` by `packages/junior/src/db/schema.ts`. The Drizzle client,
table, and ORM types must not leak outside the SQL infrastructure modules
(`packages/junior/src/db/` and `packages/junior/src/chat/conversations/sql/`).

The feature ports are:

- `ConversationStore` — queryable conversation metadata rows: read one summary by
  id; record visible conversation activity/source/destination/identity fields;
  list retained top-level conversations by activity for dashboard/plugin/reporting
  reads (children excluded).
- `ConversationMessageStore` — record and read visible messages; set the
  `replied_at` delivery mark.
- `AgentStepStore` — append agent steps under the conversation lease, read a
  conversation's steps in `seq` order, and read the current context-epoch Pi
  projection.
- The retention/erasure surface (purge and `purgeConversation`) described under
  Retention And Erasure.

No port accepts a per-write TTL. Writers do not own retention.

These ports explicitly do not own mailbox append/drain, inbound dedupe, lease
check-in/release, continuation wake-ups, or active-conversation recovery scans.
Those operations remain in `packages/junior/src/chat/task-execution/state.ts` and
the state-backed task execution store.

### Drizzle SQL Shape

- `junior_schema_migrations`
  - legacy migration state retained only to adopt pre-Drizzle installations
- `junior_identities`
  - internal id, kind (`user`, `system`, `service`), provider, provider tenant
    id, provider subject id, display/contact fields, provider metadata
  - unique `(provider, provider_tenant_id, provider_subject_id)`
- `junior_destinations`
  - internal id, provider, provider tenant id, provider destination id, kind,
    visibility, display fields, provider metadata
  - unique `(provider, provider_tenant_id, provider_destination_id)`
- `junior_conversations`
  - `conversation_id`, `source`, origin fields, `destination_id`,
    role-specific identity references (`actor_identity_id`,
    `creator_identity_id`, `credential_subject_identity_id`), provider detail
    JSON, `channel_name`, `title`, `created_at`, `last_activity_at`,
    `updated_at`, `execution_status`, `run_id`, checkpoint/enqueue timestamps,
    `parent_conversation_id` (nullable self FK), and `transcript_purged_at`
    (nullable)
- `junior_conversation_messages`
  - `(conversation_id, message_id)` primary key, `role`, `text`,
    `author_identity_id` (nullable FK to `junior_identities`), `meta` JSON,
    `created_at`, `replied_at` (nullable)
- `junior_agent_steps`
  - `(conversation_id, seq)` primary key, `context_epoch` integer, `type`
    discriminant, `role` (nullable, denormalized for `pi_message` rows),
    `payload` jsonb, `created_at`

Identities model provider-scoped principals, not just actors. A Slack user turn
may use the same identity row for multiple roles. Scheduled work uses a system
actor identity, may record a separate creator identity, and only uses a
credential-subject identity when a separate credential contract allows it. Plugin
dispatch follows the same role separation. This keeps future web, Telegram,
scheduler, and plugin analytics on indexed foreign keys rather than
source-specific JSON extraction.

Opaque JSON columns are allowed for source-specific payloads that are not used
for authorization, lock ownership, credential routing, or external side-effect
authority.

### Visible Message Storage

`junior_conversation_messages` holds one row per visible message, keyed by
`(conversation_id, message_id)` where `conversation_id` is the globally unique
conversation key and `message_id` is the source-scoped message identity (Slack
`ts`-derived, local sequence).

- Each row carries `role` (`user` | `assistant` | `system`), `text`, an optional
  `author_identity_id` FK, optional `meta` JSON for bounded source facts, and
  `created_at`.
- Recording the same source message twice is idempotent — exactly one row per
  `(conversation_id, message_id)`.
- `role`, `text`, `author_identity_id`, and `created_at` are immutable after
  insert. Mutable bookkeeping is limited to two surfaces: the `replied_at`
  delivery mark, and wholesale refresh of the bounded `meta` JSON when the same
  message is idempotently re-recorded (late vision hydration, routing/skip
  marks). `meta` stays bounded source/processing facts and is never an
  authorization input. This gives reply policy a durable, queryable home and
  removes the hidden `meta.replied` mutation.
- Reply policy, channel-context assembly, and reporting read visible messages
  through `ConversationMessageStore`; no transcript data is read from
  `thread-state`.

### Agent Step History

`junior_agent_steps` holds the durable model execution history, one row per agent
step. Rows are append-only; deletion happens only through retention purge or
erasure.

- The primary key is `(conversation_id, seq)`. `seq` is assigned `max+1`
  transactionally under the conversation lease. A conflicting write fails with a
  primary-key violation rather than silently interleaving or overwriting; the PK
  doubles as a fencing tripwire that fails loudly.
- `context_epoch` is an integer generation of the model-visible context. Epochs
  start at 0 and advance on each context rebuild. The current model context for a
  conversation is exactly the `pi_message` steps of the highest `context_epoch`,
  ordered by `seq`. Steps in older epochs remain readable audit history and do
  not contribute to model context. Host-only step types (activity, auth,
  provider-connection facts) are excluded from the Pi projection.
- The row envelope (`conversation_id`, `seq`, `context_epoch`, `type`,
  `created_at`) is strictly validated with the existing Zod step-type union at
  the store boundary. An unknown `type` or invalid envelope fails loudly as
  corrupt state. `pi_message` payload content stays permissive (the Pi SDK owns
  the message shape) and carries its payload `schemaVersion` per row. There is no
  `payloadBytes` column; sizes for redacted reporting compute at read time
  (`octet_length`).
- Visible-thread context compactions are durable host-only
  `visible_context_compacted` snapshot steps. The latest snapshot owns the
  covered visible-message ids and summaries used to rebuild future turn
  context; `thread-state` does not retain a competing compaction copy.

#### Compaction And Rollback Epochs

Context rebuilds must not store embedded transcript arrays. Compaction and
safe-boundary rollback (including in-process provider retry) each, in one
transaction:

1. append a `context_epoch_started` marker step carrying `reason`
   (`initial` | `compaction` | `handoff` | `rollback`), authoritative
   `modelProfile`, and audit-only `modelId` that opens the next epoch; initial
   selects `standard`, handoff records its selected configured non-standard
   profile, and compaction/rollback inherit the current profile while resolving
   its current configured model id,
   then
2. append the replacement context as ordinary `pi_message` rows in the new epoch,
   preserving each message's original timestamp so replay is byte-stable.

The prior epoch remains intact as audit history. "Current context" is therefore a
single indexed query (highest epoch, `pi_message`, ordered by `seq`) with no
pointer-chasing and no in-row transcript payloads. Legacy compaction and
rollback markers may omit both model binding fields and resolve to `standard`;
markerless legacy history has no inferred model id. New markers require both
fields. Runtime always selects through
`modelProfile`; the stored `modelId` records configuration drift but never pins
execution. Handoff requires an explicit valid profile binding. Whether a named
profile is configured is a runtime configuration concern, not a storage-schema
concern.

### Subagent Child Conversations

A subagent execution is recorded as its own conversation row with
`parent_conversation_id` set to the parent, and its steps stored in
`junior_agent_steps` under the child's own `conversation_id`. The parent's
`subagent_started` step references the child by `childConversationId`. The
polymorphic `transcriptRef {type, key}` reference and the ad-hoc
`junior:<id>:advisor_session` Redis key are removed. The generic storage shape
retains both isolated and shared history modes for future subagent runtimes.

- Reading a subagent transcript uses the same query path as any conversation.
- Top-level listings filter `parent_conversation_id IS NULL`; children are
  excluded from dashboard/reporting lists and purge with their root.

### Destination Visibility

`junior_destinations.visibility` is the persisted conversation-visibility
authority consumed by redaction, transcript access, dashboard reporting, and
content retention (`./data-redaction-policy.md`).

- Visibility is captured from source-provided signals only. For Slack that is the
  Events API `channel_type` or `conversations.info` `is_private`. Identifier
  prefixes must not be used to mark a destination public.
- Ingress refreshes visibility from the current event's signal when it differs
  from the stored value, so a channel converted between public and private
  converges on the next message.
- Readers must treat any value other than persisted `public` as private.
- Legacy Slack rows whose visibility was derived from id prefixes are migrated to
  private. Losing historical public classification is acceptable because it only
  reduces exposure; the next live source signal can restore public visibility.

### Retention And Erasure

Conversation content — message rows, step rows, and descendant conversations'
content — is retained for `window(visibility)` after the conversation's
`last_activity_at`:

- `public`: 90 days when the root conversation's destination has persisted
  visibility `public`.
- private: 14 days for any other case. Any visibility other than persisted
  `public` — including `private`, `direct`, `unknown`, and a missing destination
  — resolves to the private window (fail closed).

Windows are owned by named policy constants. Storage write paths do not accept or
apply per-write TTLs.

- Visibility is resolved at purge time by resolving the `parent_conversation_id`
  chain to the root conversation and reading its destination's current persisted
  visibility. No `expires_at` is stored (it would go stale on public↔private
  flips). Descendant conversations have no independent retention clock; they
  purge with their root.
- New accepted inbound messages and finalized assistant deliveries advance
  `last_activity_at`, restarting the window.

When a conversation expires, the purge job, in bounded work:

- deletes all of its message rows, step rows, and descendants' content
  wholesale;
- stamps `transcript_purged_at` on the conversation row;
- for non-public conversations, nulls the raw-payload metadata fields (`title`,
  `channel_name`, and legacy actor JSON) so purged private conversations retain
  only safe metadata.

The conversation metadata row itself survives purge (it remains the dashboard
index). Reporting presents purged content as expired, distinct from redacted
(`./data-redaction-policy.md`).

Retention is enforced by a dedicated scheduled job — a daily Vercel cron at
`/api/internal/retention` — not by the heartbeat repair loop. Heartbeat is a
repair loop, not a worker; a purge failure must not affect task execution,
heartbeat recovery, or delivery paths. Each run processes a bounded batch ordered
by `last_activity_at` and leaves remaining work for later runs.

Single-conversation erasure uses the same primitive: `purgeConversation(conversationId)`
deletes one conversation's content and descendants immediately, regardless of
age, applying the same metadata scrubbing.

### Identity And Destination Authority

The identity and destination foreign keys on `junior_conversations`
(`destination_id`, `actor_identity_id`, `creator_identity_id`,
`credential_subject_identity_id`) are the authoritative source of conversation
identity and destination. Any legacy `destination_json` / `actor_json` copies on
the conversation row are legacy-read-only, retained only for backfill continuity
and pending removal in a cleanup slice; new code must read the FKs, and purge
scrubs the legacy actor JSON for non-public conversations.

### Production Database

Production uses Neon Postgres. The shared Junior SQL database must treat Neon as
Postgres, not as a special transcript, queue, or analytics backend:

- Drizzle owns schema and typed queries. Schema DDL is generated by drizzle-kit
  (`pnpm --filter @sentry/junior db:generate`) from `src/db/schema/`.
- Neon driver/client types stay inside SQL infrastructure modules
  (`src/db/` and `chat/conversations/sql/`).
- Feature store ports remain the public runtime/dashboard/plugin boundaries.
- Schema migrations run through Drizzle ORM during `junior upgrade`; bounded
  imports use transaction-scoped locks where they coordinate concurrent writes.
- Step appends batch at safe boundaries and the projection read is one indexed
  query; store-boundary latency is logged per `./instrumentation.md`.

Local tests may use PGlite for the shared Junior SQL database when a real Postgres
service is not required. It must be treated as a Postgres-compatible test fixture,
not as a SQLite mock. The private `@sentry/junior-testing/pglite` helper owns the
PGlite dependency as dev-only test infrastructure so production deploy artifacts
do not include PGlite. `packages/junior/tests/fixtures/sql.ts` wraps that fixture
with Junior's schema and factories.

### Vercel Deployment And Upgrade

Vercel deployments can be created from Git, CLI, Deploy Hooks, or REST API, and
Git pushes normally trigger deployments automatically. Vercel Cron Jobs invoke
production functions by HTTP GET. Junior SQL schema and conversation imports are
applied by `junior upgrade`, not by request handlers.

Vercel projects using Neon normally receive a standard `DATABASE_URL` from the
integration. `DATABASE_URL` is required for every Junior runtime. Junior
deployments use the Neon serverless client by default. Set
`JUNIOR_DATABASE_DRIVER=postgres` for local Postgres, node-postgres deployments,
or test harnesses that need pooled Postgres semantics. Driver selection must come
from configuration, not hostname inference from the database URL. Vercel build
commands can run `junior upgrade` before the app build so schema changes are
applied before the new deployment starts serving traffic:

```bash
pnpm exec junior upgrade && pnpm build
```

Core and plugin packages keep standard Drizzle migration folders: edit the
owning schema, run that package's `db:generate` script, and commit the generated
SQL, snapshot, and journal changes together. `junior upgrade` passes the core
folder and each enabled plugin folder to Drizzle ORM's migrator before any data
backfill runs. Request handlers and runtime stores never apply schema
migrations. Core and each plugin use separate Junior-owned migration tables. A
Postgres advisory lock encloses each table's journal lookup, legacy adoption,
and Drizzle migration application. Existing installations adopt the generated
core baseline only when all expected legacy core migrations are recorded with
checksums. Partial legacy state fails `junior upgrade` explicitly instead of
skipping baseline DDL. The conversation backfill aggregates retained turn
summaries into absolute per-conversation metrics and writes them only while the
SQL metric columns are empty, so later SQL writes remain authoritative.

Schema migrations must be expand-only because the old deployment can continue
serving traffic while Vercel builds and promotes the new deployment:

- create tables
- add nullable columns
- add compatible indexes
- add new non-breaking constraints only after data is clean
- create or update import tracking records

Migrations must not drop columns, rewrite large tables synchronously, or require
all old deployment instances to stop before the new deployment can serve traffic.
The generated `0000_initial` baseline describes the complete existing schema.
The expand-only `0001_conversation_metrics` migration adds cumulative duration
and usage columns to `junior_conversations`; it does not replay the baseline on
complete legacy installations.

### Backfill And Cutover

This is a hard cutover in a single change: reads and writes move to SQL with the
deploy, and there is no dual-write period. The only legacy-aware behavior is the
one-time Redis→SQL import.

1. Deploy introduces schema, the migration runner, and the SQL stores.
2. `junior upgrade` bulk-imports:
   - legacy Redis conversation metadata into `junior_conversations` (bounded
     newest-first from the activity index);
   - legacy Redis session logs (`junior:agent-session-log:<id>`) into
     `junior_agent_steps`, translating `sessionId` markers into integer context
     epochs, exploding `projection_reset` entries into `context_epoch_started`
     markers plus per-message rows, converting advisor session keys into child
     conversations, and normalizing legacy v1 entry shapes;
   - visible message history into `junior_conversation_messages`.
   - legacy visible-context compaction snapshots into `junior_agent_steps`.
     Import is bounded newest-first and idempotent per conversation: it skips a
     conversation when step rows already exist.
3. For conversations the old deployment touched during promotion, the first read
   that finds no SQL rows while a Redis log still exists performs a one-time lazy
   import under the conversation lease before continuing. This closes the
   promotion race; idempotence is per conversation. The lazy-import path is
   removed after the legacy Redis TTL horizon passes.
4. Backfilled `pi_message` rows and message rows take `created_at` from
   message-internal Pi timestamps when present, falling back to the conversation's
   timestamps. Fabricated import-time (`now`) timestamps must never be used.
5. One conversation's imported visible messages and agent steps commit in the
   same row-locked transaction. A concurrent retention purge either runs after
   the import and deletes it, or wins first and prevents the import from
   resurrecting purged Redis content.

Pending inbound payloads, leases, and wake-up state remain in Redis because they
are execution state, not durable content. After cutover the legacy Redis
transcript/session keys and advisor session keys become dead and expire naturally.

## Failure Model

- If schema migration fails during `junior upgrade`, the deployment must fail
  before the new runtime serves traffic.
- If the runtime cannot resolve a SQL database URL, startup must fail before
  accepting work. If `junior upgrade` cannot resolve a SQL database URL, the
  command must fail; do not silently skip setup.
- If a migration lock is held by another upgrade process, the command waits or
  fails according to the SQL executor. Runtime request handlers must not run
  migrations concurrently.
- If the bulk import fails partway through, already imported conversations remain
  valid. The next `junior upgrade` repeats idempotent metadata upserts and fills
  retained aggregate metrics only where the SQL totals are still empty. Later
  SQL metric writes remain authoritative.
- SQL is now the transcript authority. If SQL is unavailable when a worker must
  append messages or agent steps, the write fails loudly and execution fails —
  there is no Redis fallback for history. The worker follows the standard
  task-execution recovery path rather than proceeding on stale in-memory state.
- If SQL reporting reads are unavailable, reporting callers must surface the
  failure. Do not hide SQL read failures with broad Redis read fallbacks.
- A sequence-fencing conflict (a writer that lost its lease) surfaces as a
  primary-key violation on `(conversation_id, seq)`; no stored row is modified.
- A read that encounters a row whose envelope fails validation fails with an
  explicit error instead of guessing behavior for the unknown shape.
- A purge failure is logged and isolated; it must not affect task execution,
  heartbeat recovery, or delivery. Reads are point-in-time; a purged conversation
  renders as expired on next load.
- Rollback is supported by expand-only schema. A code rollback after schema
  deployment ignores the unused tables; Redis keys continue expiring on their own
  schedule. Read cutover happens with the code deploy, so rolling back the code
  rolls back the reads.

## Observability

The conversation stores should emit existing logging/tracing conventions from
`./instrumentation.md` for:

- migration start, success, failure, and duration
- migration lock contention
- import chunk progress, lazy-import events, and failure
- SQL read/write latency at the store boundary (messages and steps)
- purge run batch size, conversations purged, and failures

Telemetry output is diagnostic and must not be used as the behavior contract in
normal runtime tests.

## Verification

- Integration tests for the SQL migration and Drizzle schema against the local
  Postgres-compatible PGlite fixture. Do not replace this with SQLite mocks.
- Integration: visible messages persist idempotently by
  `(conversation_id, message_id)`; source facts stay immutable and only
  `replied_at` is updated by delivery.
- Integration: agent steps append under the lease with `max+1` `seq`; a
  fencing conflict surfaces as a PK violation; reads return steps in `seq`
  order.
- Integration: the current-context read returns only the highest-epoch
  `pi_message` steps in `seq` order; compaction and rollback each write a new
  epoch (`context_epoch_started` marker plus replacement rows) in one
  transaction while prior epochs remain as audit history.
- Integration: a child conversation with `parent_conversation_id` set is
  referenced by the parent's `subagent_started` step and excluded from
  top-level listings.
- Integration: private content is purged at 14 days and public at 90 days,
  measured from `last_activity_at`; visibility is resolved through the parent
  chain to the root at purge time; a public→private flip shortens the window on
  the next pass.
- Integration: purge deletes messages/steps/descendants wholesale, stamps
  `transcript_purged_at`, and nulls private `title`/`channel_name`/actor JSON;
  the metadata row survives; `purgeConversation` performs the same immediately.
- Integration: purge runs as a bounded batch under `/api/internal/retention` and
  continues the backlog on the next run; a purge failure does not affect task
  execution or delivery.
- Integration: bulk import from legacy Redis session logs produces correct
  epochs, ordering, and child conversations, is idempotent per conversation, and
  never fabricates import-time timestamps; a straggler conversation lazily
  imports once under the lease on first read.
- No evals are required unless prompt behavior or agent-facing continuity
  behavior changes.

## Related Specs

- `./terminology.md`
- `./task-execution.md`
- `./chat-architecture.md`
- `./agent-session-resumability.md`
- `./data-redaction-policy.md`
- `./scheduler.md`
- `./plugin-database.md`
- `./dashboard.md`
- `./testing.md`

Related policy:

- `../policies/runtime-boundary-schemas.md`
