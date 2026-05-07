# Sandbox Snapshots Spec

## Metadata

- Created: 2026-03-06
- Last Edited: 2026-03-06

## Changelog

- 2026-03-06: Added canonical snapshot lifecycle contract for plugin runtime dependencies.
- 2026-03-06: Added snapshot resolve outcome/rebuild reason telemetry and clarified cache-hit semantics.

## Status

Active

## Purpose

Define how Junior builds, caches, invalidates, and uses sandbox filesystem snapshots derived from plugin-declared runtime dependencies.

## Scope

- Runtime dependency declarations from plugin manifests.
- Runtime post-install command declarations from plugin manifests.
- Dependency profile hashing and snapshot cache-key generation.
- Redis-backed snapshot registry and build locking.
- Sandbox creation behavior for cache hit/miss/stale snapshot paths.
- Rebuild controls for floating dependency selectors.

## Non-Goals

- Per-skill or per-plugin isolated snapshots (v1 uses a whole-runtime profile).
- CI/predeploy snapshot publishing pipeline.
- Multi-region snapshot replication policy.

## Contracts

### Runtime Dependency Source of Truth

- Plugin manifests may declare `runtime-dependencies` in `plugin.yaml`.
- Plugin manifests may declare `runtime-postinstall` commands in `plugin.yaml`.
- Supported dependency types:
  - `npm` (`package`, optional `version`; omitted means `latest`)
  - `system` (`package`) or (`url` + `sha256`)
- Runtime declarations are parsed and validated in:
  - `packages/junior/src/chat/plugins/registry.ts`
  - `packages/junior/src/chat/plugins/types.ts`
- Runtime computes one merged, de-duplicated dependency profile from all loaded plugins via `getPluginRuntimeDependencies()`.
- Runtime computes one ordered post-install command list via `getPluginRuntimePostinstall()`.

### Profile Hash Contract

- Snapshot cache identity is a SHA-256 hash over:
  - hash schema version constant
  - sandbox runtime (`node22`)
  - merged dependency declarations
  - ordered runtime post-install command declarations
  - optional manual rebuild epoch (`SANDBOX_SNAPSHOT_REBUILD_EPOCH`)
- Any change in those inputs must produce a new `profileHash` and trigger a fresh snapshot build.

### Snapshot Registry Contract

- Snapshot entries are stored in Redis via `StateAdapter` in `packages/junior/src/chat/sandbox/runtime-dependency-snapshots.ts`.
- Registry maps `profileHash -> snapshot metadata` (including `snapshotId`, creation timestamp, dependency count, runtime).
- Build concurrency is serialized per `profileHash` with Redis lock keys to avoid duplicate snapshot builds.

### Build and Install Contract

- On cache miss (or forced rebuild), runtime:
  1. Creates a base sandbox.
  2. Installs system dependencies.
  3. Installs npm global dependencies under `/vercel/sandbox/.junior`.
  4. Executes plugin `runtime-postinstall` commands.
  5. Captures snapshot with `sandbox.snapshot()`.
  6. Stores resulting `snapshotId` in registry.
- Sandbox base image is Amazon Linux 2023.
- System dependency install uses package name via `dnf install -y` and must run with `sudo: true`.
- System URL dependencies are downloaded with `curl`, verified with `sha256sum`, then installed via `dnf install -y <local-rpm>` with `sudo: true`.
- Npm dependency install uses `<package>@<version>`. Omitted manifest versions are normalized to `latest` before install.
- Runtime post-install commands run in declaration order and fail snapshot build on non-zero exit.

### Sandbox Create Contract

- Fresh sandbox acquisition attempts snapshot-backed creation first when `snapshotId` is available:
  - `Sandbox.create({ source: { type: "snapshot", snapshotId } })`
- If snapshot is missing/stale, runtime rebuilds once and retries with rebuilt `snapshotId`.
- Existing in-memory and `sandboxId` reuse behavior remains unchanged and takes precedence over fresh create.

### Rebuild Policy Contract

- Manual rebuild control:
  - `SANDBOX_SNAPSHOT_REBUILD_EPOCH` participates in hash input; changing value forces new profile hash.
- Floating-version refresh:
  - Dependencies with non-exact selectors are treated as floating.
  - Cached snapshot with floating deps is rebuilt when older than `SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS`.
  - Default max age: 7 days.
  - `SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS=0` means always rebuild for floating selectors.

## Failure Model and Invariants

- If dependency profile is empty, runtime falls back to base sandbox creation.
- If snapshot build/install fails, sandbox setup fails; runtime must not silently continue with partial installs.
- If cached snapshot is unreadable/missing, runtime must invalidate by rebuilding instead of reusing the bad entry.
- Snapshot registry state must be deterministic for the same profile hash.

## Observability

- Sandbox spans annotate snapshot source and profile metadata in `packages/junior/src/chat/sandbox/sandbox.ts`.
- Required attributes include:
  - `app.sandbox.source` (`created|snapshot|memory|id_hint`)
  - `app.sandbox.snapshot.cache_hit` (boolean, true only when the resolver reused an existing cached snapshot)
  - `app.sandbox.snapshot.resolve_outcome` (`no_profile|cache_hit|cache_hit_after_lock_wait|rebuilt|forced_rebuild`)
  - `app.sandbox.snapshot.rebuild_reason` (`cache_miss|floating_stale|force_rebuild|snapshot_missing`) when rebuilt/forced paths run
  - `app.sandbox.snapshot.profile_hash` (when available)
  - `app.sandbox.snapshot.dependency_count`
  - `app.sandbox.snapshot.rebuild_after_missing` (when stale/missing path is taken)
  - `app.sandbox.snapshot.install.system_count` / `app.sandbox.snapshot.install.npm_count` (when install phases run)
- No secret or token material is emitted in snapshot attributes or logs.

## Verification

- Type and validation coverage:
  - `packages/junior/tests/unit/plugins/plugin-registry.test.ts`
- Sandbox snapshot acquisition/rebuild paths:
  - `packages/junior/tests/unit/misc/sandbox-executor.test.ts`
- Required checks for behavior changes:
  - `pnpm --filter @sentry/junior typecheck`
  - `pnpm --filter @sentry/junior exec vitest run tests/unit/plugins/plugin-registry.test.ts tests/unit/misc/sandbox-executor.test.ts`
  - `pnpm --filter @sentry/junior skills:check`

## Related

- [Plugin Architecture Spec](./plugin-spec.md)
- [Security Policy](./security-policy.md)
- [Tracing Spec](./logging/tracing-spec.md)
