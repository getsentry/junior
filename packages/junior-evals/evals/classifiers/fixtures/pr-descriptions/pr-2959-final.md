Refs #2890. First slice for the Conversation execution status and its SQL copy.

- **SQL stores `paused`, not `awaiting_resume`.** Migration 0089 renames old rows. Readers accept both names during rollout. #2951's status SQL matches only `paused`.
- **One runnable check.** The duplicates in `store.ts` and `worker.ts` are gone. The `store.ts` copy counted `failed` as runnable, so the heartbeat sent wakes that did nothing.
- **No status repair.** The decoder and `writeConversation` no longer turn `idle` into `running` or `pending`. `writeConversation` now rejects a lease on any status but `running`/`paused`, and `idle` with pending messages. No writer makes these states, and the old repair is older than the 7-day Redis TTL.
- **Heartbeat prunes the active index under the mutation lock.** Before, it could remove the entry of work that an append had just made runnable.

Compatibility: Redis v2 records decode unchanged. The migration changes data only. #2951 also adds `0089`, so the second PR to merge renumbers.

Left for later: a tagged `Execution` union with one transition owner (`paused` means three things today). Turn writes stop setting SQL `execution_status`/`run_id` (needs #2951's `failed_turn_id`). Write the SQL copy from the record that was just saved. Stop mirroring `last_*_at`. Compute retry exhaustion in one place. Drop the `awaiting_resume` reader.
