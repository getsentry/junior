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

The migrations are idempotent: rerunning them skips records that were already moved, removes stale legacy index entries that no longer have a record, and upserts SQL conversation rows. The SQL conversation backfill copies a bounded legacy slice of Redis conversation metadata; after cutover, durable conversation metadata is written to SQL while Redis remains the transcript and execution/cache store.

## Vercel deploys

Run `junior upgrade` from the Vercel build command when the deployment has access to the same `REDIS_URL`, `JUNIOR_STATE_KEY_PREFIX`, and `DATABASE_URL` used by production.

Use a build command like:

```bash
pnpm exec junior upgrade && pnpm build
```

For monorepos, keep the same prefix and replace the build command with the app-specific build:

```bash
pnpm exec junior upgrade && pnpm --filter <app> build
```

This keeps schema creation and SQL backfills out of request handlers. Runtime code trusts that the deployment ran `junior upgrade`; if schema is missing, the deployment is misconfigured and should fail clearly.

## Example output

Typical logs look like this:

```text
Running Junior upgrade migrations...
Running migration migrate-redis-conversation-state...
Finished migration migrate-redis-conversation-state: scanned=2 migrated=1 existing=0 missing=1
Running migration backfill-conversations-sql...
Finished migration backfill-conversations-sql: scanned=2 migrated=2 existing=0 missing=0
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
2. Confirm the migration summary has the expected `scanned` and `migrated` counts.
3. Run `pnpm exec junior check` before building or deploying the app.

## Next step

Run [junior check](/cli/check/) after the upgrade, then continue with [junior snapshot create](/cli/snapshot-create/) if your plugins need sandbox dependencies.
