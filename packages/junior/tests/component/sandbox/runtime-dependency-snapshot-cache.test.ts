import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRuntimeDependencySnapshotTest,
  configureRuntimeDependencyPlugin,
  getRuntimeSnapshotCacheEntry,
  holdRuntimeSnapshotLock,
  makeRuntimeDependencySandbox,
  releaseRuntimeSnapshotLock,
  resolveRuntimeDependencySnapshot,
  sandboxCreateMock,
  setRuntimeSnapshotCacheEntry,
  setupRuntimeDependencySnapshotTest,
} from "../../fixtures/runtime-dependency-snapshots";
import { mockTestClock } from "../../fixtures/vitest";

describe("runtime dependency snapshot cache", () => {
  beforeEach(setupRuntimeDependencySnapshotTest);
  afterEach(cleanupRuntimeDependencySnapshotTest);

  it("rebuilds stale snapshots for floating dependency selectors", async () => {
    configureRuntimeDependencyPlugin({
      dependencies: [{ type: "npm", package: "sentry", version: "latest" }],
    });
    sandboxCreateMock
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_1"))
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_2"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_1");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");
    expect(first.rebuildReason).toBe("cache_miss");

    mockTestClock("2026-03-10T00:00:00.000Z");

    const second = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(second.snapshotId).toBe("snap_2");
    expect(second.cacheHit).toBe(false);
    expect(second.resolveOutcome).toBe("rebuilt");
    expect(second.rebuildReason).toBe("floating_stale");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("rebuilds stale snapshots for postinstall-only profiles", async () => {
    configureRuntimeDependencyPlugin({
      postinstall: [{ cmd: "agent-browser", args: ["install"] }],
    });
    sandboxCreateMock
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_post_1"))
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_post_2"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_post_1");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");
    expect(first.rebuildReason).toBe("cache_miss");

    mockTestClock("2026-03-10T00:00:00.000Z");

    const second = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(second.snapshotId).toBe("snap_post_2");
    expect(second.cacheHit).toBe(false);
    expect(second.resolveOutcome).toBe("rebuilt");
    expect(second.rebuildReason).toBe("floating_stale");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when rebuild epoch changes", async () => {
    configureRuntimeDependencyPlugin({
      dependencies: [{ type: "npm", package: "sentry", version: "latest" }],
    });
    sandboxCreateMock
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_epoch_a"))
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_epoch_b"));

    process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH = "epoch-a";
    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_epoch_a");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");

    process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH = "epoch-b";
    const second = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(second.snapshotId).toBe("snap_epoch_b");
    expect(second.cacheHit).toBe(false);
    expect(second.resolveOutcome).toBe("rebuilt");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("reuses cached rebuilt snapshot during force rebuild when stale id differs", async () => {
    configureRuntimeDependencyPlugin({
      dependencies: [{ type: "npm", package: "sentry", version: "latest" }],
    });
    sandboxCreateMock.mockResolvedValueOnce(
      makeRuntimeDependencySandbox("snap_new"),
    );

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_new");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");

    const forced = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      forceRebuild: true,
      staleSnapshotId: "snap_old",
    });
    expect(forced.snapshotId).toBe("snap_new");
    expect(forced.cacheHit).toBe(true);
    expect(forced.resolveOutcome).toBe("cache_hit");
    expect(forced.rebuildReason).toBe("snapshot_missing");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("does not return stale cached snapshot while waiting on force rebuild lock", async () => {
    vi.useRealTimers();
    configureRuntimeDependencyPlugin({
      dependencies: [{ type: "npm", package: "sentry", version: "latest" }],
    });
    sandboxCreateMock
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_old"))
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_new"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_old");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");
    if (!first.profileHash) {
      throw new Error("Expected snapshot profile hash");
    }

    await holdRuntimeSnapshotLock(first.profileHash);
    setTimeout(() => {
      void releaseRuntimeSnapshotLock();
    }, 50);

    const second = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      forceRebuild: true,
      staleSnapshotId: "snap_old",
    });
    expect(second.snapshotId).toBe("snap_new");
    expect(second.cacheHit).toBe(false);
    expect(second.resolveOutcome).toBe("forced_rebuild");
    expect(second.rebuildReason).toBe("snapshot_missing");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when forceRebuild is true without stale snapshot id", async () => {
    configureRuntimeDependencyPlugin({
      dependencies: [{ type: "npm", package: "sentry", version: "latest" }],
    });
    sandboxCreateMock
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_initial"))
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_forced"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_initial");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");

    const forced = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      forceRebuild: true,
    });
    expect(forced.snapshotId).toBe("snap_forced");
    expect(forced.cacheHit).toBe(false);
    expect(forced.resolveOutcome).toBe("forced_rebuild");
    expect(forced.rebuildReason).toBe("force_rebuild");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a concurrent rebuilt snapshot while waiting on force rebuild lock without stale id", async () => {
    configureRuntimeDependencyPlugin({
      dependencies: [{ type: "npm", package: "sentry", version: "latest" }],
    });
    sandboxCreateMock
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_initial"))
      .mockResolvedValueOnce(makeRuntimeDependencySandbox("snap_forced"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_initial");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");
    if (!first.profileHash) {
      throw new Error("Expected snapshot profile hash");
    }

    const cacheValue = await getRuntimeSnapshotCacheEntry(first.profileHash);
    if (!cacheValue) {
      throw new Error("Expected cached snapshot entry");
    }
    const initialCached = JSON.parse(cacheValue) as {
      profileHash: string;
      snapshotId: string;
      runtime: string;
      createdAtMs: number;
      dependencyCount: number;
    };

    await holdRuntimeSnapshotLock(first.profileHash);
    setTimeout(() => {
      void setRuntimeSnapshotCacheEntry(
        first.profileHash!,
        JSON.stringify({
          ...initialCached,
          snapshotId: "snap_from_other_worker",
          createdAtMs: Date.now(),
        }),
      );
    }, 100);
    setTimeout(() => {
      void releaseRuntimeSnapshotLock();
    }, 1_100);

    const concurrent = resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      forceRebuild: true,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const snapshot = await concurrent;
    expect(snapshot.snapshotId).toBe("snap_from_other_worker");
    expect(snapshot.cacheHit).toBe(true);
    expect(snapshot.resolveOutcome).toBe("cache_hit_after_lock_wait");
    expect(snapshot.rebuildReason).toBe("force_rebuild");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("returns no_profile metadata when runtime dependency profile is empty", async () => {
    configureRuntimeDependencyPlugin({});

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });

    expect(snapshot).toMatchObject({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile",
    });
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });
});
