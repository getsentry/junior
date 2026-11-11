Refs #2890. This is the first slice for the Conversation execution (mailbox) status and its SQL copy, measured against `policies/interface-design.md` "Lifecycle state".

### Changes

- **SQL stores `paused` by its own name.** `executionStatusToSql` is gone. Migration 0089 renames existing `awaiting_resume` rows. The reader still accepts both names, because workers from older releases write `awaiting_resume` during a rollout. This matters for #2951: its `conversationStatusSql` checks `in ('pending', 'running', 'paused')`, so on main today every yielded or backing-off Conversation would read as not `active`.
- **One runnable check.** `task-execution/store.ts` had its own `hasRunnableConversationWork` (`status !== "idle" || pending > 0`), and the heartbeat used it. It counted `failed` as runnable, so the heartbeat sent no-op wakes. `worker.ts` had a fourth inline version. Now the state check is the only one, re-exported from `store.ts`, and the worker reads `needsRun`.
- **No status repair on read or write.** The decoder and `writeConversation` used to turn `idle` with a lease into `running`, and `idle` with pending messages into `pending`. No writer produces these states, and the write-time repair has existed since #596, which is much longer than the 7-day Redis TTL. So no stored record can need the repair. `writeConversation` now rejects both states (`assertLegalExecution`): only `running` and `paused` can hold a lease, and `idle` cannot have pending messages.
- **The heartbeat prunes the active index under the mutation lock.** `removeActiveConversation` removed the entry outside the lock. A heartbeat that read `idle` could then delete the entry of work that an append had just made runnable. `pruneActiveConversation` reads the record again under the lock. It removes the entry only when the record is missing, invalid, or not runnable.

### Tests

- `conversation-work.test.ts`:
  - New: a stale `failed` entry is pruned and gets no wake.
  - New: an `idle` record with pending messages is rejected and not repaired.
  - Changed: the activity-refresh case now seeds a legal `pending` record.
  - Both new cases fail on main.
- `conversation-sql-store.test.ts`: a yielded slice stores `execution_status = 'paused'`.
- `pnpm typecheck` and `pnpm lint` pass, and so does the full `@sentry/junior` vitest run, with two exceptions:
  - `attachment-s3-storage`: no S3 container in my sandbox.
  - One case in `thread-input-stop`: it failed once on a pg pool connect error under full-suite load. It passes when run alone.

### Compatibility

- Redis v2 records decode unchanged. No schema version bump.
- SQL: a data-only migration. No column changes. `junior-plugin-api` and HTTP schemas are unchanged.
- #2951 also adds migration `0089`. Whichever PR merges second must renumber its migration.

### Left for later slices

1. A tagged `Execution` union with one `transitionExecution` owner. Today `paused` means three things: a yielded slice, a retry backoff that holds the lease, and a requeue after a lease expires.
2. Two writers for SQL `execution_status`/`run_id`. Turn summary writes (`turn-cursor.ts` `conversationExecutionFromSummary`) should stop writing them, and with them go the `olderRunFinished` and `coalesce(execution_updated_at, updated_at)` winner logic. This needs #2951's `failed_turn_id` first, because the Turn writer is what shows a failed Turn as `failed` today.
3. `recordExecutionMetadata` reads Redis again outside the lock. The SQL copy should come from the record that the transition wrote.
4. `coalesce(excluded.last_*_at, existing)` keeps SQL timestamps that Redis cleared. No reader uses `last_checkpoint_at` or `last_enqueued_at`, so they can stop being mirrored.
5. Retry exhaustion is computed in `state.ts` (×3), `worker.ts`, and `heartbeat.ts`.
6. Remove the `awaiting_resume` reader once this release is the oldest deployed worker.
