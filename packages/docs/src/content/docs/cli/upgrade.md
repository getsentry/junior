---
title: "junior upgrade"
description: "Apply Junior schema and data migrations."
type: reference
summary: Move configured SQL schemas and persisted state forward after upgrades.
prerequisites:
  - /start-here/quickstart/
related:
  - /reference/config-and-env/
  - /cli/check/
  - /cli/snapshot-create/
---

Use `junior upgrade` after installing a Junior release that includes schema or
data migrations. The command mutates the configured SQL database and state
stores, so run it from the same app environment that has the production state
and SQL environment variables configured for the deployment you are upgrading.

## Usage

Run it from a project that already has `@sentry/junior` installed:

```bash
pnpm exec junior upgrade
```

The command takes no extra arguments.

## What it does

`junior upgrade` runs migrations sequentially. Core and plugin migration
directories use Drizzle Kit's ordered journal and may contain either generated
SQL schema migrations or TypeScript data migrations targeting a versioned
host capability API. Current
upgrade work includes:

- Apply core and enabled-plugin SQL schema migrations.
- Rewrite retained turn-session records from legacy storage shapes before the
  new runtime reads them.
- Move legacy `junior:conversation-work:*` Redis state into the newer conversation record and index state used by the durable worker and dashboard feed.
- Backfill retained conversation records into the shared Junior SQL database. The upgrade requires `DATABASE_URL`.
- Apply the SQL schema cutover and rewrite legacy Pi-message rows into canonical conversation events.
- Repair legacy token and estimated-cost rollups from durable SQL conversation events in bounded batches. Conversations that are active during the repair are left unchanged and can be repaired by rerunning the command after they become idle.

Completed journal entries are tracked individually, and TypeScript migrations
can checkpoint progress for safe retries. Legacy backfills remain idempotent:
rerunning them skips records that were already moved, removes stale legacy
index entries that no longer have a record, and upserts SQL conversation rows.
The conversation-history import paginates through every conversation in the
retained activity index; orphaned or expired Redis keys outside that index are
not treated as retained history. After cutover, SQL owns durable conversation
metadata and event history.

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
Running migration core-migrations...
Finished migration core-migrations: scanned=8 migrated=4 existing=4 missing=0 skipped=0
Running migration repair-conversation-usage...
Finished migration repair-conversation-usage: scanned=2 migrated=1 existing=1 missing=0
Running migration plugin-migrations...
Finished migration plugin-migrations: scanned=8 migrated=8 existing=0 missing=0 skipped=0
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

## Next step

Run [junior check](/cli/check/) after the upgrade, then continue with [junior snapshot create](/cli/snapshot-create/) if your plugins need sandbox dependencies.
