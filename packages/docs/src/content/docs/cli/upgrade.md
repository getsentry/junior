---
title: "junior upgrade"
description: "Run one-shot Junior state upgrade migrations."
type: reference
summary: Move persisted Junior state forward after upgrading packages.
prerequisites:
  - /start-here/quickstart/
related:
  - /reference/config-and-env/
  - /cli/check/
  - /cli/snapshot-create/
---

Use `junior upgrade` after installing a Junior release that includes a one-shot state migration. The command mutates the configured state stores, so run it from the same app environment that has the production state and SQL environment variables configured for the deployment you are upgrading.

## Usage

Run it from a project that already has `@sentry/junior` installed:

```bash
pnpm exec junior upgrade
```

The command takes no extra arguments.

## What it does

`junior upgrade` runs registered migrations sequentially. Current migrations:

- Move legacy `junior:conversation-work:*` Redis state into the newer conversation record and index state used by the durable worker and dashboard feed.
- Backfill retained conversation records into the shared Junior SQL database. The upgrade requires `DATABASE_URL`.
- Apply the SQL schema cutover and rewrite legacy Pi-message rows into canonical conversation events.
- Repair legacy token and estimated-cost rollups from durable SQL conversation events in bounded batches. Conversations that are active during the repair are left unchanged and can be repaired by rerunning the command after they become idle.

The migrations are idempotent: rerunning them skips records that were already moved, removes stale legacy index entries that no longer have a record, and upserts SQL conversation rows. The conversation-history import paginates through every conversation in the retained activity index; orphaned or expired Redis keys outside that index are not treated as retained history. After cutover, SQL owns durable conversation metadata and event history.

## Hard-cutover upgrade sequence

The canonical conversation-event cutover is not rolling-compatible. Do not run it inside a Vercel build while the previous deployment can still accept work. Use this operator sequence:

1. Block new ingress and enqueueing while leaving the previous release's workers and continuation consumers running.
2. Let existing work drain, then verify that no turns remain running or awaiting resume.
3. Stop every old worker, queue consumer, and heartbeat. Keep the old deployment stopped for the rest of the procedure.
4. Run the upgrade from an operator environment with the production `REDIS_URL`, `JUNIOR_STATE_KEY_PREFIX`, and `DATABASE_URL`.
5. Confirm the history import and message-event seal complete with no missing rows.
6. Run `junior check`, deploy the new release, and only then reopen ingress and start the new workers.

Run the upgrade as a separate operator command:

```bash
pnpm exec junior upgrade
pnpm exec junior check
```

The checkpoint and message-event rewrites fail closed if resumable work remains. After the drain succeeds, each rewrite invalidates stale resume state before changing physical event positions. Checkpoint normalization closes deletion gaps, and the message migration resequences the streams it changes while preserving reporting summaries.

If the command exits nonzero, leave the deployment stopped, correct the reported state, and rerun it. Do not restart workers after only part of the sequence completes.

## Example output

Typical logs look like this:

```text
Running Junior upgrade migrations...
Running migration migrate-redis-conversation-state...
Finished migration migrate-redis-conversation-state: scanned=2 migrated=1 existing=0 missing=1
Running migration backfill-conversations-sql...
Finished migration backfill-conversations-sql: scanned=2 migrated=2 existing=0 missing=0
Running migration repair-conversation-usage...
Finished migration repair-conversation-usage: scanned=2 migrated=1 existing=1 missing=0
Junior upgrade complete.
```

## Failure behavior

If the configured state store is unavailable or a legacy record is malformed, the CLI exits non-zero and prints the underlying error:

```text
junior command failed: Legacy conversation work state is invalid for slack:C123:1712345.0001
```

Treat that as a deploy blocker for the affected environment. Check `REDIS_URL`, `JUNIOR_STATE_KEY_PREFIX`, `DATABASE_URL`, and the reported legacy record before retrying.

## Verification

After running the command:

1. Confirm the final log line includes `Junior upgrade complete`.
2. Confirm `backfill-conversation-events-sql` scanned the complete retained activity index and did not stop at one page.
3. Confirm `move-conversation-messages-to-events` reports `missing=0`. The runtime now uses the copied events. The legacy message table remains available so a later upgrade can recover messages written by old workers during deployment.
4. Run `pnpm exec junior check` before building or deploying the app.

A nonzero `missing` count for `repair-conversation-usage` means retained SQL assistant messages did not contain usable, schema-safe usage values. Junior leaves those totals unchanged.

The command does not rewrite legacy duration totals. Run summaries are TTL-bound and do not carry an authoritative completeness marker, so even a non-empty retained index may omit a run. Replacing a total from that evidence could silently undercount it.

## Next step

Run [junior check](/cli/check/) after the upgrade, then continue with [junior snapshot create](/cli/snapshot-create/) if your plugins need sandbox dependencies.
