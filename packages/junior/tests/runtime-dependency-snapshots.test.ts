import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  sandboxCreateMock,
  getPluginRuntimeDependenciesMock,
  getPluginRuntimePostinstallMock,
} = vi.hoisted(() => ({
  sandboxCreateMock: vi.fn(),
  getPluginRuntimeDependenciesMock: vi.fn(),
  getPluginRuntimePostinstallMock: vi.fn(),
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
  Sandbox: {
    create: sandboxCreateMock,
  },
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginRuntimeDependencies: getPluginRuntimeDependenciesMock,
  getPluginRuntimePostinstall: getPluginRuntimePostinstallMock,
}));
vi.mock("@/chat/observability", () => ({
  withSpan: withSpanMock,
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
    }),
  }),
}));

import { resolveRuntimeDependencySnapshot } from "@/chat/sandbox/runtime-dependency-snapshots";

function makeSandbox(
  snapshotId: string,
  runCommandImpl?: (params: { cmd: string; args?: string[] }) => Promise<{
    exitCode: number;
    stdout: () => Promise<string>;
    stderr: () => Promise<string>;
  }>,
) {
  return {
    runCommand: vi.fn(
      runCommandImpl ??
        (async () => ({
          exitCode: 0,
          stdout: async () => "",
          stderr: async () => "",
        })),
    ),
    snapshot: vi.fn(async () => ({ snapshotId })),
    stop: vi.fn(async () => {}),
  };
}

describe("runtime dependency snapshots", () => {
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
    getPluginRuntimeDependenciesMock.mockReset();
    getPluginRuntimePostinstallMock.mockReset();
    getPluginRuntimePostinstallMock.mockReturnValue([]);
    delete process.env.SANDBOX_SNAPSHOT_REBUILD_EPOCH;
    delete process.env.SANDBOX_SNAPSHOT_FLOATING_MAX_AGE_MS;
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
  });

  it("rebuilds stale snapshots for floating dependency selectors", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_1"))
      .mockResolvedValueOnce(makeSandbox("snap_2"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_1");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");
    expect(first.rebuildReason).toBe("cache_miss");

    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

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
    getPluginRuntimeDependenciesMock.mockReturnValue([]);
    getPluginRuntimePostinstallMock.mockReturnValue([
      { cmd: "agent-browser", args: ["install"] },
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_post_1"))
      .mockResolvedValueOnce(makeSandbox("snap_post_2"));

    const first = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(first.snapshotId).toBe("snap_post_1");
    expect(first.cacheHit).toBe(false);
    expect(first.resolveOutcome).toBe("rebuilt");
    expect(first.rebuildReason).toBe("cache_miss");

    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

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
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_epoch_a"))
      .mockResolvedValueOnce(makeSandbox("snap_epoch_b"));

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
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock.mockResolvedValueOnce(makeSandbox("snap_new"));

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

  it("stops the build sandbox after snapshot creation succeeds", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    const sandbox = makeSandbox("snap_stopped");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_stopped");
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
  });

  it("passes token-based Vercel Sandbox credentials to snapshot builds", async () => {
    process.env.VERCEL_TOKEN = "sandbox-token";
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "1.0.0" },
    ]);
    const sandbox = makeSandbox("snap_creds");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });

    expect(snapshot.snapshotId).toBe("snap_creds");
    expect(sandboxCreateMock).toHaveBeenCalledWith({
      timeout: 60_000,
      runtime: "node22",
      token: "sandbox-token",
      teamId: "team_123",
      projectId: "prj_123",
    });
  });

  it("installs system dependencies via dnf", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gh" },
    ]);
    const sandbox = makeSandbox("snap_system");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_system");
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "dnf",
      args: ["install", "-y", "gh"],
      sudo: true,
    });
  });

  it("installs system dependencies from URL after sha256 verification", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      {
        type: "system",
        url: "https://example.com/tool.rpm",
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);
    const sandbox = makeSandbox("snap_system_url", async (params) => {
      if (params.cmd === "sha256sum") {
        return {
          exitCode: 0,
          stdout: async () =>
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  /tmp/junior-runtime-dep.rpm",
          stderr: async () => "",
        };
      }
      return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
    });
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_system_url");
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "curl",
      args: [
        "-fsSL",
        "https://example.com/tool.rpm",
        "-o",
        "/tmp/junior-runtime-aaaaaaaaaaaa-tool.rpm",
      ],
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "sha256sum",
      args: ["/tmp/junior-runtime-aaaaaaaaaaaa-tool.rpm"],
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "dnf",
      args: ["install", "-y", "/tmp/junior-runtime-aaaaaaaaaaaa-tool.rpm"],
      sudo: true,
    });
  });

  it("falls back to gh-cli repo bootstrap when dnf cannot resolve gh directly", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gh" },
    ]);
    const sandbox = makeSandbox("snap_system_fallback", async (params) => {
      if (params.cmd !== "dnf") {
        return {
          exitCode: 1,
          stdout: async () => "",
          stderr: async () => "unsupported command",
        };
      }

      const joined = (params.args ?? []).join(" ");
      if (joined === "install -y gh") {
        return {
          exitCode: 1,
          stdout: async () => "",
          stderr: async () => "Unable to find a match: gh",
        };
      }

      return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
    });
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_system_fallback");
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "dnf",
      args: ["install", "-y", "gh"],
      sudo: true,
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "dnf",
      args: [
        "config-manager",
        "addrepo",
        "--from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo",
      ],
      sudo: true,
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "dnf",
      args: ["install", "-y", "gh", "--repo", "gh-cli"],
      sudo: true,
    });
  });

  it("does not return stale cached snapshot while waiting on force rebuild lock", async () => {
    vi.useRealTimers();
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_old"))
      .mockResolvedValueOnce(makeSandbox("snap_new"));

    const first = await resolveRuntimeDependencySnapshot({
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
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_initial"))
      .mockResolvedValueOnce(makeSandbox("snap_forced"));

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
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "sentry", version: "latest" },
    ]);
    sandboxCreateMock
      .mockResolvedValueOnce(makeSandbox("snap_initial"))
      .mockResolvedValueOnce(makeSandbox("snap_forced"));

    const first = await resolveRuntimeDependencySnapshot({
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
    getPluginRuntimeDependenciesMock.mockReturnValue([]);

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

  it("emits lifecycle snapshot spans for build and install", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "system", package: "gh" },
      { type: "npm", package: "sentry-cli", version: "2.0.0" },
    ]);
    sandboxCreateMock.mockResolvedValueOnce(makeSandbox("snap_observability"));

    await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });

    const spanNames = withSpanMock.mock.calls.map((call) => call[0]);
    expect(spanNames).toEqual(
      expect.arrayContaining([
        "sandbox.snapshot.resolve",
        "sandbox.snapshot.build",
        "sandbox.snapshot.install_system",
        "sandbox.snapshot.install_npm",
        "sandbox.snapshot.capture",
      ]),
    );
  });

  it("runs runtime-postinstall commands after dependency install", async () => {
    getPluginRuntimeDependenciesMock.mockReturnValue([
      { type: "npm", package: "example-cli", version: "latest" },
    ]);
    getPluginRuntimePostinstallMock.mockReturnValue([
      { cmd: "example-cli", args: ["install"] },
    ]);
    const sandbox = makeSandbox("snap_postinstall");
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

    const snapshot = await resolveRuntimeDependencySnapshot({
      runtime: "node22",
      timeoutMs: 60_000,
    });
    expect(snapshot.snapshotId).toBe("snap_postinstall");
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "npm",
      args: [
        "install",
        "--global",
        "--prefix",
        "/vercel/sandbox/.junior",
        "example-cli@latest",
      ],
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "bash",
      args: [
        "-lc",
        'export PATH="/vercel/sandbox/.junior/bin:$PATH" && "example-cli" "install"',
      ],
    });
  });
});
