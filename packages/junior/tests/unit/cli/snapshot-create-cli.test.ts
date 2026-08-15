import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getProvidersMock,
  getRuntimeDependenciesMock,
  getRuntimePostinstallMock,
  resolveMock,
} = vi.hoisted(() => ({
  getProvidersMock: vi.fn(),
  getRuntimeDependenciesMock: vi.fn(),
  getRuntimePostinstallMock: vi.fn(),
  resolveMock: vi.fn(),
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getProviders: getProvidersMock,
    getRuntimeDependencies: getRuntimeDependenciesMock,
    getRuntimePostinstall: getRuntimePostinstallMock,
  },
}));

vi.mock("@/chat/sandbox/snapshot/resolve", () => ({
  resolve: resolveMock,
}));

vi.mock("@/chat/sandbox/runtime-dependencies", () => ({
  GLOBAL_RUNTIME_DEPENDENCIES: [],
  GLOBAL_RUNTIME_POSTINSTALL: [],
}));

vi.mock("@/chat/config", () => ({
  getChatConfig: () => ({
    state: {
      adapter: process.env.JUNIOR_STATE_ADAPTER === "memory" ? "memory" : "redis",
      redisUrl: process.env.REDIS_URL,
    },
  }),
}));

import { runSnapshotCreate } from "@/cli/snapshot-create";

describe("snapshot create cli", () => {
  const originalAdapter = process.env.JUNIOR_STATE_ADAPTER;
  const originalRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    getProvidersMock.mockReset();
    getRuntimeDependenciesMock.mockReset();
    getRuntimePostinstallMock.mockReset();
    resolveMock.mockReset();

    getProvidersMock.mockReturnValue([]);
    getRuntimeDependenciesMock.mockReturnValue([]);
    getRuntimePostinstallMock.mockReturnValue([]);
    delete process.env.JUNIOR_STATE_ADAPTER;
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  afterEach(() => {
    if (originalAdapter === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = originalAdapter;
    }
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("uses default runtime and timeout", async () => {
    resolveMock.mockResolvedValue({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile",
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line));

    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock).toHaveBeenCalledWith({
      runtime: "node22",
      timeoutMs: 10 * 60 * 1000,
      onProgress: expect.any(Function),
    });
    expect(logs).toContain("Loaded plugins (0): none");
    expect(logs).toContain(
      "Sandbox snapshot inputs: plugins=0 system_dependencies=0 npm_dependencies=0 postinstall_commands=0",
    );
    await resolveMock.mock.calls[0][0].onProgress("resolve_start");
    expect(logs).toContain("Resolving sandbox snapshot profile...");
    expect(
      logs.some((line) => line.includes("resolve_outcome=no_profile")),
    ).toBe(true);
  });

  it("logs plugin and dependency inputs before snapshot resolution", async () => {
    getProvidersMock.mockReturnValue([
      {
        manifest: {
          name: "agent-browser",
          displayName: "Agent Browser",
          runtimeDependencies: [
            { type: "npm", package: "agent-browser", version: "latest" },
            { type: "system", package: "gtk3" },
          ],
          runtimePostinstall: [{ cmd: "agent-browser", args: ["install"] }],
        },
      },
      {
        manifest: {
          name: "notion",
          displayName: "Notion",
        },
      },
    ]);
    getRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gtk3" },
      { type: "npm", package: "agent-browser", version: "latest" },
    ]);
    getRuntimePostinstallMock.mockReturnValue([
      { cmd: "agent-browser", args: ["install"] },
    ]);
    resolveMock.mockResolvedValue({
      snapshotId: "snap_123",
      profileHash: "abc",
      dependencyCount: 2,
      cacheHit: false,
      resolveOutcome: "rebuilt",
      rebuildReason: "cache_miss",
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line));

    expect(logs).toContain("Loaded plugins (2): agent-browser, notion");
    expect(logs).toContain(
      "Sandbox snapshot inputs: plugins=1 system_dependencies=1 npm_dependencies=1 postinstall_commands=1",
    );
    expect(logs).toContain("Snapshot plugins (1): agent-browser");
    expect(logs).toContain("System dependencies (1): gtk3");
    expect(logs).toContain("NPM dependencies (1): agent-browser@latest");
    expect(logs).toContain("Runtime postinstall (1): agent-browser install");
  });

  it("logs cache hit metadata", async () => {
    resolveMock.mockResolvedValue({
      snapshotId: "snap_123",
      profileHash: "abc",
      dependencyCount: 3,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line));

    const summary = logs[logs.length - 1];
    expect(summary).toContain("resolve_outcome=cache_hit");
    expect(summary).toContain("cache_hit=true");
    expect(summary).toContain("dependency_count=3");
    expect(summary).toContain("profile_hash=abc");
    expect(summary).toContain("snapshot_id=snap_123");
  });

  it("rethrows resolver errors", async () => {
    resolveMock.mockRejectedValue(new Error("OIDC missing"));

    await expect(runSnapshotCreate()).rejects.toThrow("OIDC missing");
  });

  it("fails when state is not durable redis", async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    delete process.env.REDIS_URL;

    await expect(runSnapshotCreate()).rejects.toThrow(
      /requires durable Redis state/,
    );
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
