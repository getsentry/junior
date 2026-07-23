---
title: "junior upgrade"
description: "Apply Junior and plugin SQL schema migrations."
type: reference
summary: Bring the configured Junior SQL database up to the installed schema.
prerequisites:
  - /start-here/quickstart/
related:
  - /reference/config-and-env/
  - /cli/check/
  - /cli/snapshot-create/
---

Use `junior upgrade` after installing a new Junior release. The command applies
pending Drizzle migrations to the database configured by `DATABASE_URL`.

## Usage

Run the command from your Junior app:

```bash
pnpm exec junior upgrade
```

The command takes no arguments. It migrates the core Junior schema first, then
the schemas owned by enabled plugins. Already-applied migrations are recognized
as up to date and are not rerun.

## Upgrade bridge for older databases

An existing Junior database without core Drizzle migration history must
complete the `0.107.1` upgrade before upgrading to a later release. Before
starting this bridge, block new ingress, drain active and resumable work, stop
all old workers and queue consumers, and keep them stopped until the later
release is ready. If Junior reports this unsupported database state:

1. Install `@sentry/junior@0.107.1`.
2. Run `pnpm exec junior upgrade` and confirm it completes successfully.
3. Restore the intended Junior version.
4. Run `pnpm exec junior upgrade` again.
5. Deploy the intended version, then restart workers and reopen ingress.

Fresh databases without Junior tables do not require the bridge release.

## Example output

An already-current database reports its migrations as existing:

```text
Checking database migrations...
  junior: up to date (7 migrations)
  junior-github: up to date (4 migrations)
  junior-memory: up to date (5 migrations)
  junior-scheduler: up to date (2 migrations)
Database is up to date (18 migrations).
```

## Failure behavior

The command exits nonzero when it cannot connect to SQL, encounters an
unsupported pre-Drizzle database, or a migration fails. Treat that as a deploy
blocker: correct the reported database or migration error, then rerun the
command.

## Verification

Confirm that the command exits successfully and lists `junior` plus each
enabled plugin that owns migrations. The final line reports whether the
database was already current or how many migrations were applied.

## Next step

Run [junior check](/cli/check/) before deploying, then continue with
[junior snapshot create](/cli/snapshot-create/) if your plugins need sandbox
dependencies.
