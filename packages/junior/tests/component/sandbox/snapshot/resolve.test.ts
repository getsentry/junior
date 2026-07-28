import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  sandboxCreateMock,
  getRuntimeDependenciesMock,
  getRuntimePostinstallMock,
} = vi.hoisted(() => ({
  sandboxCreateMock: vi.fn(),
  getRuntimeDependenciesMock: vi.fn(),
  getRuntimePostinstallMock: vi.fn(),
}));
const { withSpanMock } = vi.hoisted(() => ({
  withSpanMock: vi.fn(
    async (
      _name: string,
      _op: string,
      _context: unknown,
      callback: () => Promise<unknown>,
    ) => callback(),
  ),
}));

vi.mock("@vercel/sandbox", () => ({
  FileSystem: class {},
  Sandbox: {
    create: sandboxCreateMock,
  },
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getRuntimeDependencies: getRuntimeDependenciesMock,
    getRuntimePostinstall: getRuntimePostinstallMock,
  },
}));
vi.mock("@/chat/sandbox/runtime-dependencies", () => ({
  GLOBAL_RUNTIME_DEPENDENCIES: [],
}));
vi.mock("@/chat/logging", () => ({
  withSpan: withSpanMock,
}));

const store = new Map<string, string>();
let lockHeld = false;

vi.mock("@/chat/state/adapter", () => ({
  getStateAdapter: () => ({
    connect: vi.fn(async () => {}),
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    acquireLock: vi.fn(async () => {
      if (lockHeld) {
        return null;
      }
      lockHeld = true;
      return { key: "lock" };
    }),
    releaseLock: vi.fn(async () => {
      lockHeld = false;
    }),
  }),
}));

import { resolve as resolveSnapshot } from "@/chat/sandbox/snapshot/resolve";

function makeSandbox(snapshotId: string) {
  const runCommand = vi.fn(async () => ({
    exitCode: 0,
    stdout: async () => "",
    stderr: async () => "",
  }));
  const snapshot = vi.fn(async () => ({ snapshotId }));
  const stop = vi.fn(async () => {});
  return {
    name: `sbx_${snapshotId}`,
    currentSession: vi.fn(() => ({
      sessionId: `sbx_${snapshotId}_session`,
      runCommand,
      snapshot,
      stop,
    })),
    runCommand,
    snapshot,
    stop,
  };
}

describe("snapshot resolution", () => {
  beforeEach(() => {
    store.clear();
    lockHeld = false;
    sandboxCreateMock.mockReset();
    withSpanMock.mockReset();
    withSpanMock.mockImplementation(
      async (
        _name: string,
        _op: string,
        _context: unknown,
        callback: () => Promise<unknown>,
      ) => await callback(),
    );
    getRuntimeDependenciesMock.mockReset();
    getRuntimePostinstallMock.mockReset();
    getRuntimePostinstallMock.mockReturnValue([]);
    delete process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH;
    delete process.env.SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS;
    delete process.env.SANDBOX_VCPUS;
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
  });

  it("reuses cached rebuilt snapshot during force rebuild when stale id differs", async () => {
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock.mockResolvedValueOnce(makeSandbox("snap_new"));

    const first = await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_new");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");

    const forced = await resolveSnapshot({
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

  it("stops the build sandbox after snapshot creation succeeds", async () => {
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    const sandbox = makeSandbox("snap_stopped");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_stopped");
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("does not return stale cached snapshot while waiting on force rebuild lock", async () => {
    vi.useRealTimers();
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_old"))
      .mockResolvedValueOnce(makeSandbox("snap_new"));

    const first = await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_old");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");

    lockHeld = true;
    setTimeout(() => {
      lockHeld = false;
    }, 50);

    const second = await resolveSnapshot({
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
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_initial"))
      .mockResolvedValueOnce(makeSandbox("snap_forced"));

    const first = await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_initial");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");

    const forced = await resolveSnapshot({
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
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_initial"))
      .mockResolvedValueOnce(makeSandbox("snap_forced"));

    const first = await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_initial");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");

    const [cacheKey] = [...store.keys()];
    const initialCached = JSON.parse(store.get(cacheKey) ?? "") as {
      profileHash: string;
      snapshotId: string;
      runtime: string;
      createdAtMs: number;
      dependencyCount: number;
    };

    lockHeld = true;
    setTimeout(() => {
      store.set(
        cacheKey,
        JSON.stringify({
          ...initialCached,
          snapshotId: "snap_from_other_worker",
          createdAtMs: Date.now(),
        }),
      );
    }, 100);
    setTimeout(() => {
      lockHeld = false;
    }, 1_100);

    const concurrent = resolveSnapshot({
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
    getRuntimeDependenciesMock.mockReturnValue([]);

    const snapshot = await resolveSnapshot({
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
