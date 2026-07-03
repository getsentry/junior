---
title: Sandbox Snapshots
description: How Junior prepares sandbox runtime dependencies declared by plugins.
type: reference
summary: Understand when snapshot warmup runs, what invalidates a snapshot, and how to verify rebuilds.
prerequisites:
  - /extend/
related:
  - /cli/snapshot-create/
  - /operate/observability/
  - /operate/reliability-runbooks/
---

Junior plugins can declare sandbox runtime dependencies such as npm CLIs, system packages, and postinstall commands. Junior turns those declarations into a single runtime dependency profile and stores the resolved Vercel Sandbox snapshot in Redis.

## When snapshots are used

Snapshots are used only when loaded plugins declare runtime dependencies or runtime postinstall commands. If the dependency profile is empty, Junior creates a base sandbox without snapshot warmup.

The common deploy path runs snapshot warmup during build:

```json title="package.json"
{
  "scripts": {
    "build": "junior snapshot create && nitro build"
  }
}
```

## Snapshot profile

Junior computes the snapshot profile from loaded plugin declarations:

| Input                | Source                                                     |
| -------------------- | ---------------------------------------------------------- |
| Runtime              | Junior sandbox runtime, currently `node22`.                |
| npm dependencies     | Plugin `runtime-dependencies` entries with `type: npm`.    |
| system dependencies  | Plugin `runtime-dependencies` entries with `type: system`. |
| postinstall commands | Plugin `runtime-postinstall` entries.                      |
| manual rebuild epoch | `SANDBOX_SNAPSHOT_REBUILD_EPOCH`, when set.                |

Any change to those inputs produces a new profile hash and a new snapshot.

## Cache and rebuild behavior

Snapshot metadata is stored in Redis by profile hash. Junior serializes rebuilds for the same profile so concurrent builds do not create duplicate snapshots.

Rebuilds happen when:

- the profile hash is new
- the cached snapshot is missing or stale
- `SANDBOX_SNAPSHOT_REBUILD_EPOCH` changes
- floating dependency selectors are older than `SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS`

The default floating dependency max age is seven days. Set `SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS=0` only when you intentionally want floating dependencies rebuilt every time.

## Failure behavior

Snapshot build failures are deploy blockers. Junior must not silently continue with partially installed dependencies.

Check these first:

| Symptom                          | First check                                                    |
| -------------------------------- | -------------------------------------------------------------- |
| `OIDC missing`                   | Vercel OIDC is available during build.                         |
| Redis registry errors            | `REDIS_URL` is available during build.                         |
| CLI not found in turns           | Plugin runtime dependency declaration and snapshot build logs. |
| Browser or binary launch failure | Runtime postinstall command ran successfully.                  |

## Verify

Run snapshot warmup directly:

```bash
pnpm exec junior snapshot create
```

Confirm the final line includes `Sandbox snapshot create complete` and that dependency counts match the enabled plugins.

## Next step

Use [junior snapshot create](/cli/snapshot-create/) for command details, then monitor snapshot behavior from [Observability](/operate/observability/).
