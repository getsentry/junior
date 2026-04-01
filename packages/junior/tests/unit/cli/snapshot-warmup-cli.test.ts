import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getPluginProvidersMock,
  getPluginRuntimeDependenciesMock,
  getPluginRuntimePostinstallMock,
  resolveRuntimeDependencySnapshotMock,
} = vi.hoisted(() => ({
  getPluginProvidersMock: vi.fn(),
  getPluginRuntimeDependenciesMock: vi.fn(),
  getPluginRuntimePostinstallMock: vi.fn(),
  resolveRuntimeDependencySnapshotMock: vi.fn(),
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginProviders: getPluginProvidersMock,
  getPluginRuntimeDependencies: getPluginRuntimeDependenciesMock,
  getPluginRuntimePostinstall: getPluginRuntimePostinstallMock,
}));

vi.mock("@/chat/sandbox/runtime-dependency-snapshots", () => ({
  resolveRuntimeDependencySnapshot: resolveRuntimeDependencySnapshotMock,
}));

vi.mock("@/vercel", () => ({
  writeVercelJson: vi.fn().mockReturnValue("/mock/vercel.json"),
}));

import { runSnapshotCreate } from "@/cli/snapshot-warmup";

describe("snapshot create cli", () => {
  beforeEach(() => {
    getPluginProvidersMock.mockReset();
    getPluginRuntimeDependenciesMock.mockReset();
    getPluginRuntimePostinstallMock.mockReset();
    resolveRuntimeDependencySnapshotMock.mockReset();

    getPluginProvidersMock.mockReturnValue([]);
    getPluginRuntimeDependenciesMock.mockReturnValue([]);
    getPluginRuntimePostinstallMock.mockReturnValue([]);
  });

  it("uses default runtime and timeout", async () => {
    resolveRuntimeDependencySnapshotMock.mockResolvedValue({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile",
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line));

    expect(resolveRuntimeDependencySnapshotMock).toHaveBeenCalledTimes(1);
    expect(resolveRuntimeDependencySnapshotMock).toHaveBeenCalledWith({
      runtime: "node22",
      timeoutMs: 10 * 60 * 1000,
      onProgress: expect.any(Function),
    });
    expect(logs).toContain("Loaded plugins (0): none");
    expect(logs).toContain(
      "Sandbox snapshot inputs: plugins=0 system_dependencies=0 npm_dependencies=0 postinstall_commands=0",
    );
    await resolveRuntimeDependencySnapshotMock.mock.calls[0][0].onProgress(
      "resolve_start",
    );
    expect(logs).toContain("Resolving sandbox snapshot profile...");
    expect(
      logs.some((line) => line.includes("resolve_outcome=no_profile")),
    ).toBe(true);
  });

  it("logs plugin and dependency inputs before snapshot resolution", async () => {
    getPluginProvidersMock.mockReturnValue([
      {
        manifest: {
          name: "agent-browser",
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
        },
      },
    ]);
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gtk3" },
      { type: "npm", package: "agent-browser", version: "latest" },
    ]);
    getPluginRuntimePostinstallMock.mockReturnValue([
      { cmd: "agent-browser", args: ["install"] },
    ]);
    resolveRuntimeDependencySnapshotMock.mockResolvedValue({
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
    resolveRuntimeDependencySnapshotMock.mockResolvedValue({
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
    resolveRuntimeDependencySnapshotMock.mockRejectedValue(
      new Error("OIDC missing"),
    );

    await expect(runSnapshotCreate()).rejects.toThrow("OIDC missing");
  });
});
