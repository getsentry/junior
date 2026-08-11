import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  GLOBAL_RUNTIME_POSTINSTALL: [],
}));
vi.mock("@/chat/logging", () => ({
  withSpan: withSpanMock,
}));

const store = new Map<string, string>();
const heldLocks = new Set<string>();
let getError: Error | undefined;
const acquiredLockTtls: number[] = [];

vi.mock("@/chat/state/adapter", () => ({
  getStateAdapter: () => ({
    connect: vi.fn(async () => {}),
    get: vi.fn(async (key: string) => {
      if (getError) {
        throw getError;
      }
      return store.get(key);
    }),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    acquireLock: vi.fn(async (key: string, ttlMs: number) => {
      acquiredLockTtls.push(ttlMs);
      if (heldLocks.has(key)) {
        return null;
      }
      heldLocks.add(key);
      return { key };
    }),
    releaseLock: vi.fn(async (lock: { key: string }) => {
      heldLocks.delete(lock.key);
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
    heldLocks.clear();
    getError = undefined;
    acquiredLockTtls.length = 0;
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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it("lets cache failures reach the caller", async () => {
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    getError = new Error("state unavailable");

    await expect(
      resolveSnapshot({
        runtime: "node22",
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("state unavailable");
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("rejects malformed cache values without exposing their contents", async () => {
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock.mockResolvedValueOnce(makeSandbox("snap_new"));

    const first = await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    const [cacheKey] = [...store.keys()];
    store.set(cacheKey, "private-token-abc");

    await expect(
      resolveSnapshot({
        runtime: "node22",
        timeoutMs: 60_000,
      }),
    ).rejects.toEqual(
      new Error(`Invalid cached sandbox snapshot for ${first.profileHash}`),
    );
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the build lock beyond the sandbox timeout", async () => {
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock.mockResolvedValueOnce(makeSandbox("snap_new"));

    await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });

    expect(acquiredLockTtls).toEqual([90_000]);
  });

  it("stops waiting for a shared build lock when the caller is cancelled", async () => {
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    // Force every acquire attempt to miss so the waiter path runs.
    vi.spyOn(heldLocks, "has").mockReturnValue(true);
    const controller = new AbortController();
    const reason = new Error("turn ended");

    const resolving = resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      signal: controller.signal,
      onProgress: (phase) => {
        if (phase === "waiting_for_lock") {
          controller.abort(reason);
        }
      },
    });

    await expect(resolving).rejects.toBe(reason);
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("passes cancellation into snapshot sandbox creation", async () => {
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    const controller = new AbortController();
    const reason = new Error("turn ended");
    sandboxCreateMock.mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const resolving = resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(sandboxCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );
    });
    controller.abort(reason);

    await expect(resolving).rejects.toBe(reason);
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

    const lockKey = `junior:sandbox_snapshot_lock:${first.profileHash}`;
    heldLocks.add(lockKey);
    setTimeout(() => {
      heldLocks.delete(lockKey);
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
      snapshotId: string;
      createdAtMs: number;
    };
    const lockKey = `junior:sandbox_snapshot_lock:${first.profileHash}`;

    heldLocks.add(lockKey);
    setTimeout(() => {
      store.set(
        cacheKey,
        JSON.stringify({
          ...initialCached,
          snapshotId: "snap_from_other_worker",
        }),
      );
    }, 100);
    setTimeout(() => {
      heldLocks.delete(lockKey);
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

  it("builds workspace snapshots by extending the cached base snapshot", async () => {
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    const baseSandbox = makeSandbox("snap_base");
    const workspaceSandbox = makeSandbox("snap_workspace");
    sandboxCreateMock
      .mockResolvedValueOnce(baseSandbox)
      .mockResolvedValueOnce(workspaceSandbox);
    const prepareWorkspace = vi.fn(async () => {});
    const workspace = {
      id: "workspace-1",
      name: "sentry",
      setupScript: "pnpm install",
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry",
          checkoutPath: "sentry",
          isPrimary: true,
        },
      ],
    };

    const snapshot = await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      workspace,
      prepareWorkspace,
    });

    expect(snapshot.snapshotId).toBe("snap_workspace");
    expect(snapshot.cacheHit).toBe(false);
    expect(snapshot.resolveOutcome).toBe("rebuilt");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runtime: "node22" }),
    );
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        source: { type: "snapshot", snapshotId: "snap_base" },
      }),
    );
    expect(prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(baseSandbox.runCommand).toHaveBeenCalled();
    expect(workspaceSandbox.runCommand).not.toHaveBeenCalled();

    const reused = await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      workspace,
      prepareWorkspace,
    });
    expect(reused.snapshotId).toBe("snap_workspace");
    expect(reused.cacheHit).toBe(true);
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
    expect(prepareWorkspace).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the base snapshot when workspace extend finds it missing", async () => {
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    const baseSandbox = makeSandbox("snap_base");
    const rebuiltBaseSandbox = makeSandbox("snap_base_rebuilt");
    const workspaceSandbox = makeSandbox("snap_workspace");
    sandboxCreateMock
      .mockResolvedValueOnce(baseSandbox)
      .mockRejectedValueOnce(new Error("snapshot not found"))
      .mockResolvedValueOnce(rebuiltBaseSandbox)
      .mockResolvedValueOnce(workspaceSandbox);

    const prepareWorkspace = vi.fn(async () => {});
    const workspace = {
      id: "workspace-1",
      name: "sentry",
      setupScript: "pnpm install",
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry",
          checkoutPath: "sentry",
          isPrimary: true,
        },
      ],
    };

    // Seed a base cache entry first.
    await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });

    // Drop the base provider snapshot while keeping the cache pointer so the
    // workspace build hits the missing-parent retry path.
    const snapshot = await resolveSnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      workspace,
      prepareWorkspace,
    });

    expect(snapshot.snapshotId).toBe("snap_workspace");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(4);
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        source: { type: "snapshot", snapshotId: "snap_base" },
      }),
    );
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ runtime: "node22" }),
    );
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        source: { type: "snapshot", snapshotId: "snap_base_rebuilt" },
      }),
    );
    expect(prepareWorkspace).toHaveBeenCalledTimes(1);
  });
});
