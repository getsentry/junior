# Conversation Metadata Storage

## Metadata

- Created: 2026-06-11
- Last Edited: 2026-06-11

## Purpose

Define Junior's SQL-backed storage contract for queryable conversation metadata
without moving transcript authorities into SQL.

This storage exists to support stats, dashboard lists, audit queries,
conversation configuration, recovery metadata, and deploy-safe schema
evolution.

## Scope

- Conversation records and query indexes.
- Inbound mailbox metadata and dedupe ids.
- Execution status, run ids, leases, and recovery timestamps.
- Conversation display details such as title, channel, source, destination, and
  requester.
- Conversation-scoped configuration entries.
- Artifact, sandbox, scheduler task, and session/run summary references.
- SQL schema migration and backfill deployment behavior on Vercel with Neon
  Postgres in production.

## Non-Goals

- Moving visible conversation transcript messages to SQL.
- Moving Pi/model execution transcript entries to SQL.
- Reconstructing model context from SQL metadata.
- Replacing Redis/blob transcript storage in this project.
- Adding a general workflow engine or durable task database.

## Contracts

### Data Authorities

SQL owns queryable metadata only.

The transcript authorities from `./task-execution.md` remain unchanged:

- `thread-state:<conversationId>` stores visible thread/runtime transcript
  state.
- `junior:agent-session-log:<conversationId>` stores the append-only Pi/model
  execution transcript.

SQL records may reference transcript authorities by `conversationId`,
`sessionId`, message count, or summary fields, but must not duplicate full
transcript payloads as the normal read path.

### Metadata Store Boundary

Runtime modules must depend on a small metadata storage port. Drizzle owns SQL
schema definitions and typed query implementation details, but Drizzle client,
table, and ORM types must not leak through chat runtime, services, ingress,
scheduler, or dashboard boundaries.

The first storage port is `ConversationMetadataStore` in
`packages/junior/src/chat/metadata/store.ts`. It covers the existing
conversation execution record shape, mailbox dedupe and injection state,
lease/check-in/release operations, continuation wake-ups, activity listing, and
active-conversation recovery scans.

Additional metadata concerns should join this boundary in separate vertical
slices:

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
    `credential_subject_identity_id`), provider detail JSON,
    `channel_name`, `title`, `created_at`, `last_activity_at`, `updated_at`,
    `execution_status`, `run_id`, lease fields
- `junior_conversation_inbound_messages`
  - `conversation_id`, `inbound_message_id`, `source`, `created_at`,
    `received_at`, `injected_at`, `destination_id`, provider detail JSON, safe
    input size/count metadata, and transient pending `input_json`
  - unique `(conversation_id, inbound_message_id)`

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

Opaque JSON columns are allowed for source-specific payloads that are not used
for authorization, lock ownership, credential routing, or external side-effect
authority.

Inbound mailbox SQL rows may store raw inbound input only while the message is
pending worker injection. Once the worker durably injects the message into the
session log, SQL must clear the raw input payload and retain only metadata such
as id, timestamps, source, destination, injected status, text length, and
attachment count. This keeps SQL from becoming a long-term transcript history
authority while still allowing a single SQL-backed mailbox path.

### Production Database

Production uses Neon Postgres. The runtime metadata store must treat Neon as
Postgres, not as a special transcript or analytics backend:

- Drizzle owns schema and typed queries.
- Neon driver/client types stay inside SQL infrastructure modules.
- The metadata-store port remains the public runtime/dashboard/plugin boundary.
- Migration and backfill code must use transaction-scoped database locks so
  Neon/Vercel's normal pooled `DATABASE_URL` works. Neon HTTP may be used for
  one-shot query paths only when no advisory lock or interactive transaction is
  required.

Local tests and local development may use PGlite for the shared Junior SQL
database. It must be treated as a Postgres-compatible local mode, not as a
SQLite mock. The private `@sentry/junior-test-fixtures` package owns the
PGlite dependency as dev-only test infrastructure so production deploy artifacts
do not include PGlite. `packages/junior/tests/fixtures/sql.ts` wraps that
fixture with Junior's schema and factories so future metadata tables can be
covered without rebuilding ad-hoc stores.

### Vercel Deployment And Upgrade

Vercel deployments can be created from Git, CLI, Deploy Hooks, or REST API, and
Git pushes normally trigger deployments automatically. Vercel Cron Jobs invoke
production functions by HTTP GET. Junior SQL schema and metadata backfills are
applied by `junior upgrade`, not by request handlers.

Vercel projects using Neon normally receive a standard `DATABASE_URL` from the
integration. Projects that need a Junior-specific database set
`JUNIOR_DATABASE_URL`; otherwise Junior uses `DATABASE_URL`. Vercel build
commands can run `junior upgrade` before the app build so schema changes are
applied before the new deployment starts serving traffic:

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

Historical Redis metadata moves to SQL through a bounded migration, not through
a single blocking request and not through long-lived read fallbacks.

1. Deploy A introduces schema, migration runner, and the SQL metadata store
   implementation.
2. `junior upgrade` copies historical Redis metadata into the shared Junior SQL
   database after a SQL database URL is configured. The registered SQL
   migration uses `backfillToSql` to copy retained
   conversation metadata from the state-backed metadata store into the SQL
   store.
3. The retained activity index is bounded, so the migration should finish in
   one run. If the source exceeds that bound, the upgrade command must fail
   clearly instead of enabling SQL metadata from a partial copy.
4. The runtime and dashboard use the canonical metadata store interface. Junior
   points that interface at Neon-backed SQL when it can resolve a SQL database
   URL from `JUNIOR_DATABASE_URL` or `DATABASE_URL`, in that order. The explicit
   Junior variable remains the override for projects where the default
   application database is not the Junior SQL database. Leaving both database
   URL variables unset keeps the state-backed local/default store. During the
   migration deployment, enable the
   SQL metadata store once required schema and migration completion checks pass.
5. A cleanup deployment removes obsolete metadata-only Redis writes after
   production observation.

Transcript keys are excluded from this backfill unless a separate transcript
storage spec changes their authority.

## Failure Model

- If schema migration fails during `junior upgrade`, the deployment must fail
  before the new runtime serves traffic.
- If a migration lock is held by another upgrade process, the command waits or
  fails according to the SQL executor. Runtime request handlers must not run
  migrations concurrently.
- If backfill fails partway through, already copied rows remain valid. The next
  `junior upgrade` run repeats the bounded retained-activity scan and
  idempotently upserts rows.
- If SQL is unavailable after the metadata store cutover, the caller must
  surface the failure. Do not hide SQL failures with broad Redis read fallbacks.
- Rollback must be supported by expand-only schema changes and delayed read
  cutover. A code rollback after schema deployment can ignore unused SQL tables.

## Observability

The metadata store should emit existing logging/tracing conventions from
`./instrumentation.md` for:

- migration start, success, failure, and duration
- migration lock contention
- backfill chunk progress and failure
- SQL metadata migration progress and cutover readiness
- SQL read/write latency at the store boundary

Telemetry output is diagnostic and must not be used as the behavior contract in
normal runtime tests.

## Verification

- Component tests for metadata-store invariants: inbound dedupe, mailbox
  ordering, lease exclusivity, active/recent list ordering, and schema migration
  idempotency.
- Integration tests for the SQL migration and Drizzle schema against the local
  Postgres-compatible PGlite fixture. Do not replace this with SQLite mocks.
- Component tests for backfill conversion from Redis metadata to SQL rows.
- Integration tests for production wiring once reads move to SQL: inbound event
  persistence, worker recovery, heartbeat recovery, and final delivery metadata.
- No evals are required unless prompt behavior or agent-facing continuity
  behavior changes.

## Related Specs

- `./task-execution.md`
- `./chat-architecture.md`
- `./agent-session-resumability.md`
- `./scheduler.md`
- `./dashboard.md`
- `./runtime-boundary-schemas.md`
- `./testing.md`
