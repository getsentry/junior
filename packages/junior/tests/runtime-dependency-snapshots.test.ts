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

function makeSandbox(snapshotId: string) {
  return {
    runCommand: vi.fn(async (params: { cmd: string }) => {
      if (params.cmd === "npm") {
        return {
          exitCode: 0,
          stdout: async () => "",
          stderr: async () => ""
        };
      }
      return {
        exitCode: 0,
        stdout: async () => "",
        stderr: async () => ""
      };
    }),
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
      { type: "npm", package: "sentry", version: "^2" }
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
      { type: "npm", package: "sentry", version: "^2" }
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
});
