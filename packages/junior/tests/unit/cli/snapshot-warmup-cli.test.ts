import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSnapshotCreate } from "@/cli/snapshot-warmup";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import type {
  PluginManifest,
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "@/chat/plugins/types";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { stubTestEnv, useMemoryStateAdapter } from "../../fixtures/vitest";

type SnapshotResolver = NonNullable<
  Parameters<typeof runSnapshotCreate>[1]
>["resolveRuntimeDependencySnapshot"];

function createPluginManifest(
  name: string,
  options: {
    runtimeDependencies?: PluginRuntimeDependency[];
    runtimePostinstall?: PluginRuntimePostinstallCommand[];
  } = {},
): PluginManifest {
  return {
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
  };
}

function configurePlugins(manifests: PluginManifest[]): void {
  setPluginCatalogConfig({
    inlineManifests: manifests.map((manifest) => ({ manifest })),
  });
}

describe("snapshot create cli", () => {
  useMemoryStateAdapter();

  let resolveRuntimeDependencySnapshot: ReturnType<
    typeof vi.fn<SnapshotResolver>
  >;

  beforeEach(async () => {
    stubTestEnv({ JUNIOR_STATE_ADAPTER: "memory" });
    await disconnectStateAdapter();
    configurePlugins([]);
    resolveRuntimeDependencySnapshot = vi.fn<SnapshotResolver>();
  });

  afterEach(async () => {
    setPluginCatalogConfig(undefined);
    await disconnectStateAdapter();
    vi.unstubAllEnvs();
  });

  it("uses default runtime and timeout", async () => {
    resolveRuntimeDependencySnapshot.mockResolvedValue({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile",
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line), {
      resolveRuntimeDependencySnapshot,
    });

    expect(resolveRuntimeDependencySnapshot).toHaveBeenCalledTimes(1);
    expect(resolveRuntimeDependencySnapshot).toHaveBeenCalledWith({
      runtime: "node22",
      timeoutMs: 10 * 60 * 1000,
      onProgress: expect.any(Function),
    });
    expect(logs).toContain("Loaded plugins (0): none");
    expect(logs).toContain(
      "Sandbox snapshot inputs: plugins=0 system_dependencies=0 npm_dependencies=0 postinstall_commands=0",
    );
    const resolveParams = resolveRuntimeDependencySnapshot.mock.calls[0]?.[0];
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
    configurePlugins([
      createPluginManifest("agent-browser", {
        runtimeDependencies: [
          { type: "npm", package: "agent-browser", version: "latest" },
          { type: "system", package: "gtk3" },
        ],
        runtimePostinstall: [{ cmd: "agent-browser", args: ["install"] }],
      }),
      createPluginManifest("notion"),
    ]);
    resolveRuntimeDependencySnapshot.mockResolvedValue({
      snapshotId: "snap_123",
      profileHash: "abc",
      dependencyCount: 2,
      cacheHit: false,
      resolveOutcome: "rebuilt",
      rebuildReason: "cache_miss",
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line), {
      resolveRuntimeDependencySnapshot,
    });

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
    resolveRuntimeDependencySnapshot.mockResolvedValue({
      snapshotId: "snap_123",
      profileHash: "abc",
      dependencyCount: 3,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    const logs: string[] = [];

    await runSnapshotCreate((line) => logs.push(line), {
      resolveRuntimeDependencySnapshot,
    });

    const summary = logs[logs.length - 1];
    expect(summary).toContain("resolve_outcome=cache_hit");
    expect(summary).toContain("cache_hit=true");
    expect(summary).toContain("dependency_count=3");
    expect(summary).toContain("profile_hash=abc");
    expect(summary).toContain("snapshot_id=snap_123");
  });

  it("rethrows resolver errors", async () => {
    resolveRuntimeDependencySnapshot.mockRejectedValue(
      new Error("OIDC missing"),
    );

    await expect(
      runSnapshotCreate(undefined, { resolveRuntimeDependencySnapshot }),
    ).rejects.toThrow("OIDC missing");
  });
});
