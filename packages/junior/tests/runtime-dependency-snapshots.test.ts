import { beforeEach, describe, expect, it, vi } from "vitest";

const { sandboxCreateMock, getPluginRuntimeDependenciesMock } = vi.hoisted(() => ({
  sandboxCreateMock: vi.fn(),
  getPluginRuntimeDependenciesMock: vi.fn()
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: sandboxCreateMock
  }
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginRuntimeDependencies: getPluginRuntimeDependenciesMock
}));

const store = new Map<string, string>();
let lockHeld = false;

vi.mock("@/chat/state", () => ({
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
    })
  })
}));

import { resolveRuntimeDependencySnapshot } from "@/chat/sandbox/runtime-dependency-snapshots";

function makeSandbox(
  snapshotId: string,
  runCommandImpl?: (params: { cmd: string; args?: string[] }) => Promise<{
    exitCode: number;
    stdout: () => Promise<string>;
    stderr: () => Promise<string>;
  }>
) {
  return {
    runCommand: vi.fn(
      runCommandImpl ??
        (async () => ({
          exitCode: 0,
          stdout: async () => "",
          stderr: async () => ""
        }))
    ),
    snapshot: vi.fn(async () => ({ snapshotId })),
    stop: vi.fn(async () => {})
  };
}

describe("runtime dependency snapshots", () => {
  beforeEach(() => {
    store.clear();
    lockHeld = false;
    sandboxCreateMock.mockReset();
    getPluginRuntimeDependenciesMock.mockReset();
    delete process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH;
    delete process.env.SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
  });

  it("rebuilds stale snapshots for floating dependency selectors", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" }
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_1"))
      .mockResolvedValueOnce(makeSandbox("snap_2"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(first.snapshotId).toBe("snap_1");

    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

    const second = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(second.snapshotId).toBe("snap_2");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when rebuild epoch changes", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" }
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_epoch_a"))
      .mockResolvedValueOnce(makeSandbox("snap_epoch_b"));

    process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH = "epoch-a";
    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(first.snapshotId).toBe("snap_epoch_a");

    process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH = "epoch-b";
    const second = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(second.snapshotId).toBe("snap_epoch_b");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("reuses cached rebuilt snapshot during force rebuild when stale id differs", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" }
    ]);
    sandboxCreateMock.mockResolvedValueOnce(makeSandbox("snap_new"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(first.snapshotId).toBe("snap_new");

    const forced = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      forceRebuild: true,
      staleSnapshotId: "snap_old"
    });
    expect(forced.snapshotId).toBe("snap_new");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("stops the build sandbox after snapshot creation succeeds", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" }
    ]);
    const sandbox = makeSandbox("snap_stopped");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(snapshot.snapshotId).toBe("snap_stopped");
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("installs system dependencies via dnf", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gh" }
    ]);
    const sandbox = makeSandbox("snap_system");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(snapshot.snapshotId).toBe("snap_system");
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "dnf",
      args: ["install", "-y", "gh"],
      sudo: true
    });
  });

  it("falls back to gh-cli repo bootstrap when dnf cannot resolve gh directly", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gh" }
    ]);
    const sandbox = makeSandbox("snap_system_fallback", async (params) => {
      if (params.cmd !== "dnf") {
        return { exitCode: 1, stdout: async () => "", stderr: async () => "unsupported command" };
      }

      const joined = (params.args ?? []).join(" ");
      if (joined === "install -y gh") {
        return {
          exitCode: 1,
          stdout: async () => "",
          stderr: async () => "Unable to find a match: gh"
        };
      }

      return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
    });
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(snapshot.snapshotId).toBe("snap_system_fallback");
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "dnf",
      args: ["install", "-y", "gh"],
      sudo: true
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "dnf",
      args: ["config-manager", "addrepo", "--from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo"],
      sudo: true
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "dnf",
      args: ["install", "-y", "gh", "--repo", "gh-cli"],
      sudo: true
    });
  });

  it("does not return stale cached snapshot while waiting on force rebuild lock", async () => {
    vi.useRealTimers();
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" }
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_old"))
      .mockResolvedValueOnce(makeSandbox("snap_new"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(first.snapshotId).toBe("snap_old");

    lockHeld = true;
    setTimeout(() => {
      lockHeld = false;
    }, 50);

    const second = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      forceRebuild: true,
      staleSnapshotId: "snap_old"
    });
    expect(second.snapshotId).toBe("snap_new");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when forceRebuild is true without stale snapshot id", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" }
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_initial"))
      .mockResolvedValueOnce(makeSandbox("snap_forced"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(first.snapshotId).toBe("snap_initial");

    const forced = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      forceRebuild: true
    });
    expect(forced.snapshotId).toBe("snap_forced");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a concurrent rebuilt snapshot while waiting on force rebuild lock without stale id", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" }
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_initial"))
      .mockResolvedValueOnce(makeSandbox("snap_forced"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000
    });
    expect(first.snapshotId).toBe("snap_initial");

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
          createdAtMs: Date.now()
        })
      );
    }, 100);
    setTimeout(() => {
      lockHeld = false;
    }, 1_100);

    const concurrent = resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
      forceRebuild: true
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const snapshot = await concurrent;
    expect(snapshot.snapshotId).toBe("snap_from_other_worker");
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });
});
