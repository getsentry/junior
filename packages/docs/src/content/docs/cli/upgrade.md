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

Use `junior upgrade` after installing a Junior release that includes a one-shot state migration. The command mutates the configured state store, so run it from the same app environment that has `REDIS_URL` and `JUNIOR_STATE_KEY_PREFIX` configured for the deployment you are upgrading.

## Usage

Run it from a project that already has `@sentry/junior` installed:

```bash
pnpm exec junior upgrade
```

The command takes no extra arguments.

## What it does

`junior upgrade` runs registered migrations sequentially. The current migration moves legacy `junior:conversation-work:*` Redis state into the newer conversation record and index state used by the durable worker and dashboard feed.

The migration is idempotent: rerunning it skips records that were already moved and removes stale legacy index entries that no longer have a record.

## Vercel deploys

Run `junior upgrade` as an out-of-band production maintenance command, not as a permanent request-time path. Vercel build jobs can run the command when they have production `REDIS_URL` access, but build-time alone can leave a small cutover window where the old deployment writes more legacy state.

For production deploys that need this migration, use this order:

1. Load the same `REDIS_URL` and `JUNIOR_STATE_KEY_PREFIX` used by the production deployment.
2. Run `pnpm exec junior upgrade`.
3. Build and deploy the new release.
4. Run `pnpm exec junior upgrade` again after the deploy is serving traffic.

The second run is safe because the migration is idempotent, and it catches records written by the old deployment during the Vercel build or promotion window.

## Example output

Typical logs look like this:

```text
Running Junior upgrade migrations...
Running migration migrate-legacy-conversation-work-redis-state...
Finished migration migrate-legacy-conversation-work-redis-state: scanned=2 migrated=1 existing=0 missing=1
Junior upgrade complete.
```

## Failure behavior

If the configured state store is unavailable or a legacy record is malformed, the CLI exits non-zero and prints the underlying error:

```text
junior command failed: Legacy conversation work state is invalid for slack:C123:1712345.0001
```

Treat that as a deploy blocker for the affected environment. Check `REDIS_URL`, `JUNIOR_STATE_KEY_PREFIX`, and the reported legacy record before retrying.

## Verification

After running the command:

1. Confirm the final log line includes `Junior upgrade complete`.
2. Confirm the migration summary has the expected `scanned` and `migrated` counts.
3. Run `pnpm exec junior check` before building or deploying the app.

## Next step

Run [junior check](/cli/check/) after the upgrade, then continue with [junior snapshot create](/cli/snapshot-create/) if your plugins need sandbox dependencies.
