import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSnapshotCreate } from "@/cli/snapshot-warmup";
import type {
  PluginDefinition,
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "@/chat/plugins/types";

type SnapshotCreateDeps = NonNullable<Parameters<typeof runSnapshotCreate>[1]>;

function createPluginDefinition(
  name: string,
  options: {
    runtimeDependencies?: PluginRuntimeDependency[];
    runtimePostinstall?: PluginRuntimePostinstallCommand[];
  } = {},
): PluginDefinition {
  return {
    dir: `/tmp/${name}-plugin`,
    manifest: {
      name,
      description: `${name} plugin`,
      capabilities: [],
      configKeys: [],
      ...(options.runtimeDependencies
        ? { runtimeDependencies: options.runtimeDependencies }
        : {}),
      ...(options.runtimePostinstall
        ? { runtimePostinstall: options.runtimePostinstall }
        : {}),
    },
  };
}

function createSnapshotCreateDeps() {
  return {
    disconnectStateAdapter: vi.fn<SnapshotCreateDeps["disconnectStateAdapter"]>(
      async () => undefined,
    ),
    getPluginProviders: vi.fn<SnapshotCreateDeps["getPluginProviders"]>(
      () => [],
    ),
    getPluginRuntimeDependencies: vi.fn<
      SnapshotCreateDeps["getPluginRuntimeDependencies"]
    >(() => []),
    getPluginRuntimePostinstall: vi.fn<
      SnapshotCreateDeps["getPluginRuntimePostinstall"]
    >(() => []),
    resolveRuntimeDependencySnapshot:
      vi.fn<SnapshotCreateDeps["resolveRuntimeDependencySnapshot"]>(),
  } satisfies SnapshotCreateDeps;
}

describe("snapshot create cli", () => {
  let deps: ReturnType<typeof createSnapshotCreateDeps>;

  beforeEach(() => {
    deps = createSnapshotCreateDeps();
  });

  it("uses default runtime and timeout", async () => {
    deps.resolveRuntimeDependencySnapshot.mockResolvedValue({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile",
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line), deps);

    expect(deps.resolveRuntimeDependencySnapshot).toHaveBeenCalledTimes(1);
    expect(deps.resolveRuntimeDependencySnapshot).toHaveBeenCalledWith({
      runtime: "node22",
      timeoutMs: 10 * 60 * 1000,
      onProgress: expect.any(Function),
    });
    expect(logs).toContain("Loaded plugins (0): none");
    expect(logs).toContain(
      "Sandbox snapshot inputs: plugins=0 system_dependencies=0 npm_dependencies=0 postinstall_commands=0",
    );
    const resolveParams =
      deps.resolveRuntimeDependencySnapshot.mock.calls[0]?.[0];
    if (!resolveParams?.onProgress) {
      throw new Error("Expected snapshot resolver to be called");
    }
    await resolveParams.onProgress("resolve_start");
    expect(logs).toContain("Resolving sandbox snapshot profile...");
    expect(
      logs.some((line) => line.includes("resolve_outcome=no_profile")),
    ).toBe(true);
  });

  it("logs plugin and dependency inputs before snapshot resolution", async () => {
    deps.getPluginProviders.mockReturnValue([
      createPluginDefinition("agent-browser", {
        runtimeDependencies: [
          { type: "npm", package: "agent-browser", version: "latest" },
          { type: "system", package: "gtk3" },
        ],
        runtimePostinstall: [{ cmd: "agent-browser", args: ["install"] }],
      }),
      createPluginDefinition("notion"),
    ]);
    deps.getPluginRuntimeDependencies.mockReturnValue([
      { type: "system", package: "gtk3" },
      { type: "npm", package: "agent-browser", version: "latest" },
    ]);
    deps.getPluginRuntimePostinstall.mockReturnValue([
      { cmd: "agent-browser", args: ["install"] },
    ]);
    deps.resolveRuntimeDependencySnapshot.mockResolvedValue({
      snapshotId: "snap_123",
      profileHash: "abc",
      dependencyCount: 2,
      cacheHit: false,
      resolveOutcome: "rebuilt",
      rebuildReason: "cache_miss",
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line), deps);

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
    deps.resolveRuntimeDependencySnapshot.mockResolvedValue({
      snapshotId: "snap_123",
      profileHash: "abc",
      dependencyCount: 3,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line), deps);

    const summary = logs[logs.length - 1];
    expect(summary).toContain("resolve_outcome=cache_hit");
    expect(summary).toContain("cache_hit=true");
    expect(summary).toContain("dependency_count=3");
    expect(summary).toContain("profile_hash=abc");
    expect(summary).toContain("snapshot_id=snap_123");
  });

  it("rethrows resolver errors", async () => {
    deps.resolveRuntimeDependencySnapshot.mockRejectedValue(
      new Error("OIDC missing"),
    );

    await expect(runSnapshotCreate(undefined, deps)).rejects.toThrow(
      "OIDC missing",
    );
    expect(deps.disconnectStateAdapter).toHaveBeenCalledTimes(1);
  });
});
