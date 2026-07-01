# Conversation Storage

## Metadata

- Created: 2026-06-11
- Last Edited: 2026-07-01

## Purpose

Define Junior's first SQL-backed storage contract for queryable conversation
records without moving transcript authorities into SQL.

This storage is the first feature-owned slice of Junior's shared SQL database.
It supports stats, dashboard lists, audit queries, conversation configuration,
durable source/destination/identity metadata, and deploy-safe schema evolution.
Plugin-owned SQL extensions are governed by `./plugin-database.md`.

## Scope

- Conversation records and query indexes.
- Execution status summaries and run/checkpoint timestamps.
- Conversation display details such as title, channel, source, destination, and
  requester.
- Conversation-scoped configuration entries.
- Artifact, sandbox, scheduler task, and session/run summary references.
- SQL schema migration and backfill deployment behavior on Vercel with Neon
  Postgres in production.

## Non-Goals

- Moving visible conversation transcript messages to SQL.
- Moving Pi/model execution transcript entries to SQL.
- Moving pending inbound mailbox payloads to SQL.
- Moving lease ownership and worker wake-up state to SQL.
- Reconstructing model context from SQL records.
- Replacing Redis/blob transcript storage in this project.
- Adding a general workflow engine or durable task database.

## Contracts

### Data Authorities

SQL owns durable, queryable Junior data. This spec covers the first
feature-owned slice: conversation records and their long-term metadata. Plugin
tables may join the same shared database through the package migration contract
in `./plugin-database.md`.

The transcript authorities from `./task-execution.md` remain unchanged:

- `thread-state:<conversationId>` stores visible thread/runtime transcript
  state.
- `junior:agent-session-log:<conversationId>` stores the append-only Pi/model
  execution transcript.

SQL records may reference transcript authorities by `conversationId`,
`sessionId`, message count, or summary fields, but must not duplicate full
transcript payloads as the normal read path.

The transient task-execution authorities from `./task-execution.md` also remain
state-backed:

- `junior:conversation:<conversationId>` stores pending inbound mailbox entries,
  lease ownership, active execution state, and worker recovery indexes.
- `conversation:active` and `conversation:by-activity` remain the bounded
  state indexes used by task execution and by the SQL backfill source.

### Conversation Store Boundary

Runtime modules must depend on small feature storage ports. Drizzle owns SQL
schema definitions and typed query implementation details, but Drizzle client,
table, and ORM types must not leak through chat runtime, services, ingress,
scheduler, or dashboard boundaries.

The first SQL-backed feature port is `ConversationStore` in
`packages/junior/src/chat/conversations/store.ts`. It covers queryable
conversation rows only:

- read one conversation summary by id
- record visible conversation activity/source/destination/identity fields
- list retained conversations by activity for dashboard/plugin/reporting reads

It explicitly does not own mailbox append/drain, inbound dedupe, lease
check-in/release, continuation wake-ups, or active-conversation recovery scans.
Those operations remain in `packages/junior/src/chat/task-execution/state.ts`
and the state-backed task execution store.

Additional SQL concerns should join the shared Junior database in separate
vertical slices:

- conversation context and generated titles
- conversation-scoped configuration
- artifact and sandbox references
- agent-run/turn-session summaries
- scheduler task and run associations

### Drizzle SQL Shape

The first Drizzle schema should optimize for queryability and simple
transactional invariants:

- `junior_schema_migrations`
  - migration id, checksum, applied timestamp
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
    `requester_identity_id`, `creator_identity_id`,
    `credential_subject_identity_id`), provider detail JSON, `channel_name`,
    `title`, `created_at`, `last_activity_at`, `updated_at`,
    `execution_status`, `run_id`, and checkpoint/enqueue timestamps

Identities model provider-scoped principals, not just requesters. A Slack user
turn may use the same identity row for actor and requester. Scheduled work uses
a system actor identity, may record a separate creator identity, and only uses a
credential-subject identity when a separate credential contract allows it.
Plugin dispatch follows the same role separation. This keeps future web,
Telegram, scheduler, and plugin analytics on indexed foreign keys rather than
source-specific JSON extraction.

Future slices may add feature-owned SQL tables for conversation configuration,
artifact references, agent-run summaries, scheduler links, and other metadata
concerns once their owning store interfaces are implemented.
Plugin-owned slices add tables through `./plugin-database.md` and must keep
their table names under their plugin-owned prefix.

Opaque JSON columns are allowed for source-specific payloads that are not used
for authorization, lock ownership, credential routing, or external side-effect
authority.

Inbound mailbox rows and lease fields are not part of the SQL schema. Pending
input payloads and active lease ownership are temporary execution data and
remain in the state-backed task-execution store until they either become
durable session-log entries or expire.

### Production Database

Production uses Neon Postgres. The shared Junior SQL database must treat Neon as
Postgres, not as a special transcript, queue, or analytics backend:

- Drizzle owns schema and typed queries.
- Neon driver/client types stay inside SQL infrastructure modules.
- Feature store ports remain the public runtime/dashboard/plugin boundaries.
- Migration and backfill code must use transaction-scoped database locks so
  Neon/Vercel's normal pooled `DATABASE_URL` works. Neon HTTP may be used for
  one-shot query paths only when no advisory lock or interactive transaction is
  required.

Local tests may use PGlite for the shared Junior SQL database when a real
Postgres service is not required. It must be treated as a Postgres-compatible
test fixture, not as a SQLite mock. The private `@sentry/junior-testing/pglite`
helper owns the PGlite dependency as dev-only test infrastructure so production
deploy artifacts do not include PGlite. `packages/junior/tests/fixtures/sql.ts`
wraps that fixture with Junior's schema and factories so future metadata tables
can be covered without rebuilding ad-hoc stores.

### Vercel Deployment And Upgrade

Vercel deployments can be created from Git, CLI, Deploy Hooks, or REST API, and
Git pushes normally trigger deployments automatically. Vercel Cron Jobs invoke
production functions by HTTP GET. Junior SQL schema and conversation backfills are
applied by `junior upgrade`, not by request handlers.

Vercel projects using Neon normally receive a standard `DATABASE_URL` from the
integration. `DATABASE_URL` is required for every Junior runtime. Junior
deployments use the Neon serverless client by default. Set
`JUNIOR_DATABASE_DRIVER=postgres` for local Postgres, node-postgres deployments,
or test harnesses that need pooled Postgres semantics. Driver selection must
come from configuration, not hostname inference from the database URL. Vercel
build commands can run `junior upgrade` before the app build so schema changes
are applied before the new deployment starts serving traffic:

```bash
pnpm exec junior upgrade && pnpm build
```

Schema migrations must be expand-only because the old deployment can continue
serving traffic while Vercel builds and promotes the new deployment:

- create tables
- add nullable columns
- add compatible indexes
- add new non-breaking constraints only after data is clean
- create or update backfill tracking records

Migrations must not drop columns, rewrite large tables synchronously, or require
all old deployment instances to stop before the new deployment can serve
traffic.

### Backfill And Cutover

Historical conversation metadata that still exists in Redis moves to SQL
through a bounded legacy import. This is a one-time compatibility path, not the
steady-state storage model.

1. Deploy A introduces schema, migration runner, and the SQL conversation store
   implementation.
2. `junior upgrade` requires a SQL database URL and copies legacy Redis
   conversation metadata into the shared Junior SQL database. Pending inbound
   payloads, leases, wake-up state, and transcripts remain in Redis because
   they are execution/cache state, not durable reporting metadata.
3. The legacy import reads only a bounded newest-first slice of the old Redis
   activity index. SQL reporting starts from the copied metadata plus any new
   and updated conversation metadata written directly to SQL after cutover.
4. The runtime and dashboard use the canonical conversation store interface.
   Junior points that interface at SQL using `DATABASE_URL`. Leaving
   `DATABASE_URL` unset is a startup configuration error. During the migration
   deployment, enable the SQL conversation store once required schema and
   migration completion checks pass.

Transcript keys are excluded from this backfill unless a separate transcript
storage spec changes their authority.

## Failure Model

- If schema migration fails during `junior upgrade`, the deployment must fail
  before the new runtime serves traffic.
- If the runtime cannot resolve a SQL database URL, startup must fail before
  accepting work.
- If `junior upgrade` cannot resolve a SQL database URL, the command must fail.
  Do not silently skip SQL conversation metadata setup.
- If a migration lock is held by another upgrade process, the command waits or
  fails according to the SQL executor. Runtime request handlers must not run
  migrations concurrently.
- If backfill fails partway through, already copied rows remain valid. The next
  `junior upgrade` run repeats the bounded legacy import and idempotently
  upserts rows.
- If SQL metadata writes are unavailable while Redis-backed task execution is
  accepting or running work, task execution must continue and log the metadata
  update failure. Redis remains the mailbox, lease, wake-up, and transcript
  authority.
- If SQL reporting reads are unavailable after the conversation store cutover,
  reporting callers must surface the failure. Do not hide SQL read failures with
  broad Redis read fallbacks.
- Rollback must be supported by expand-only schema changes and delayed read
  cutover. A code rollback after schema deployment can ignore unused SQL tables.

## Observability

The conversation store should emit existing logging/tracing conventions from
`./instrumentation.md` for:

- migration start, success, failure, and duration
- migration lock contention
- backfill chunk progress and failure
- SQL conversation migration progress and cutover readiness
- SQL read/write latency at the store boundary

Telemetry output is diagnostic and must not be used as the behavior contract in
normal runtime tests.

## Verification

- Component tests for task-execution invariants: inbound dedupe, mailbox
  ordering, lease exclusivity, and active/recent state-index ordering.
- Component tests for conversation-store invariants: SQL migration idempotency,
  activity ordering, identity/destination linking, and state-to-SQL backfill
  without pending input payloads.
- Integration tests for the SQL migration and Drizzle schema against the local
  Postgres-compatible PGlite fixture. Do not replace this with SQLite mocks.
- Component tests for backfill conversion from Redis conversation records to SQL
  rows.
- Integration tests for production wiring once reads move to SQL: inbound event
  persistence, worker recovery, heartbeat recovery, and final delivery metadata.
- No evals are required unless prompt behavior or agent-facing continuity
  behavior changes.

## Related Specs

- `./task-execution.md`
- `./chat-architecture.md`
- `./agent-session-resumability.md`
- `./scheduler.md`
- `./plugin-database.md`
- `./dashboard.md`
- `./testing.md`

Related policy:

- `../policies/runtime-boundary-schemas.md`
