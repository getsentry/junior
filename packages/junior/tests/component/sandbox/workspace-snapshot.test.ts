import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  sandboxCreateMock,
  sandboxGetMock,
  getWorkspaceMock,
  getCachedSnapshotMock,
  setCachedSnapshotMock,
  setWorkspaceSnapshotBuildMock,
  setWorkspaceSnapshotMock,
  installDependenciesMock,
  installPostinstallMock,
  prepareRepositoriesMock,
} = vi.hoisted(() => ({
  sandboxCreateMock: vi.fn(),
  sandboxGetMock: vi.fn(),
  getWorkspaceMock: vi.fn(),
  getCachedSnapshotMock: vi.fn(),
  setCachedSnapshotMock: vi.fn(),
  setWorkspaceSnapshotBuildMock: vi.fn(),
  setWorkspaceSnapshotMock: vi.fn(),
  installDependenciesMock: vi.fn(),
  installPostinstallMock: vi.fn(),
  prepareRepositoriesMock: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    create: sandboxCreateMock,
    get: sandboxGetMock,
  },
}));
vi.mock("@/chat/db", () => ({ getDb: () => ({}) }));
vi.mock("@/chat/sandbox/credentials", () => ({
  getVercelSandboxCredentials: () => undefined,
}));
vi.mock("@/chat/sandbox/resources", () => ({
  getSandboxResources: () => undefined,
}));
vi.mock("@/chat/sandbox/prepare-workspace", () => ({
  prepareWorkspaceRepositories: prepareRepositoriesMock,
  workspaceSetupCommand: () => ({
    cmd: "bash",
    args: ["-c", "devenv sync"],
    cwd: "/vercel/sandbox",
    env: {},
  }),
}));
vi.mock("@/chat/sandbox/snapshot/install", () => ({
  dependencies: installDependenciesMock,
  postinstall: installPostinstallMock,
}));
vi.mock("@/chat/sandbox/snapshot/profile", () => ({
  create: () => ({
    hash: "profile-sentry",
    dependencyCount: 0,
    floating: false,
    dependencies: [],
    postinstall: [],
  }),
  isStale: () => false,
}));
vi.mock("@/chat/sandbox/snapshot/resolve", () => ({
  getCachedSnapshot: getCachedSnapshotMock,
  setCachedSnapshot: setCachedSnapshotMock,
}));
vi.mock("@/chat/sandbox/workspace", () => ({
  createSandboxSession: (sandbox: unknown) => sandbox,
}));

const lock = { threadId: "workspace-snapshot", lockId: "lock" };
vi.mock("@/chat/state/adapter", () => ({
  getStateAdapter: () => ({
    connect: vi.fn(async () => {}),
    acquireLock: vi.fn(async () => lock),
    extendLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => {}),
  }),
}));
vi.mock("@/chat/workspaces/store", () => ({
  getWorkspace: getWorkspaceMock,
  setWorkspaceSnapshotBuild: setWorkspaceSnapshotBuildMock,
  setWorkspaceSnapshot: setWorkspaceSnapshotMock,
}));

import {
  resolveWorkspaceSnapshot,
  WorkspaceSnapshotBuildingError,
} from "@/chat/sandbox/workspace-snapshot";
import type { Workspace } from "@/chat/workspaces/types";

const workspace: Workspace = {
  id: "workspace-sentry",
  name: "sentry",
  setupScript: "devenv sync",
  repos: [{ provider: "github", repo: "getsentry/sentry" }],
  snapshot: null,
  snapshotBuild: null,
};

function resolve() {
  return resolveWorkspaceSnapshot({
    workspace,
    runtime: "node22",
    applyNetworkPolicy: vi.fn(async () => undefined),
    removeCredentialRoute: false,
  });
}

describe("Workspace snapshot check-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorkspaceMock.mockResolvedValue(workspace);
    getCachedSnapshotMock.mockResolvedValue(null);
    installDependenciesMock.mockResolvedValue(undefined);
    installPostinstallMock.mockResolvedValue(undefined);
    prepareRepositoriesMock.mockResolvedValue(undefined);
  });

  it("creates the builder first, preps on the next check-in, then snapshots", async () => {
    sandboxCreateMock.mockResolvedValue({ name: "junior-ws-1" });

    let recordedBuild: Workspace["snapshotBuild"];
    setWorkspaceSnapshotBuildMock.mockImplementation(async (_id, build) => {
      recordedBuild = build;
    });

    // Check-in 1: create builder only.
    await expect(resolve()).rejects.toBeInstanceOf(
      WorkspaceSnapshotBuildingError,
    );
    expect(sandboxCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        persistent: true,
        timeout: 24 * 60 * 60 * 1000,
      }),
    );
    expect(installDependenciesMock).not.toHaveBeenCalled();
    expect(setWorkspaceSnapshotBuildMock).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        status: "building",
        sandboxName: expect.any(String),
        commandId: null,
      }),
    );

    // Check-in 2: install/clone, detach setup.
    const detachedCommand = { cmdId: "cmd-1" };
    const builder = {
      extendTimeout: vi.fn(async () => undefined),
      runCommand: vi.fn(async () => detachedCommand),
    };
    sandboxGetMock.mockResolvedValue(builder);
    getWorkspaceMock.mockResolvedValue({
      ...workspace,
      snapshotBuild: recordedBuild!,
    });

    await expect(resolve()).rejects.toBeInstanceOf(
      WorkspaceSnapshotBuildingError,
    );
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(installDependenciesMock).toHaveBeenCalledTimes(1);
    expect(prepareRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(builder.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        detached: true,
        timeoutMs: 24 * 60 * 60 * 1000,
      }),
    );
    expect(recordedBuild!.commandId).toBe("cmd-1");

    // Check-in 3: setup still running.
    const command: {
      exitCode: number | null;
      stderr: ReturnType<typeof vi.fn>;
    } = {
      exitCode: null,
      stderr: vi.fn(),
    };
    const stopMock = vi.fn(async () => undefined);
    const resumed = {
      extendTimeout: vi.fn(async () => undefined),
      getCommand: vi.fn(async () => command),
      snapshot: vi.fn(async () => ({ snapshotId: "snap-sentry" })),
      stop: stopMock,
    };
    sandboxGetMock.mockResolvedValue(resumed);
    getWorkspaceMock.mockResolvedValue({
      ...workspace,
      snapshotBuild: recordedBuild!,
    });

    await expect(resolve()).rejects.toBeInstanceOf(
      WorkspaceSnapshotBuildingError,
    );
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(installDependenciesMock).toHaveBeenCalledTimes(1);

    // Check-in 4: setup done → snapshot + stop builder.
    command.exitCode = 0;
    const snapshot = await resolve();
    expect(snapshot.snapshotId).toBe("snap-sentry");
    expect(resumed.snapshot).toHaveBeenCalledTimes(1);
    expect(setCachedSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileHash: "profile-sentry",
        snapshotId: "snap-sentry",
      }),
    );
    expect(setWorkspaceSnapshotMock).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        id: "snap-sentry",
        runtime: "node22",
        dependencyCount: 0,
      }),
    );
    expect(stopMock).toHaveBeenCalled();
  });

  it("boots from a SQL ready row when Redis misses", async () => {
    getWorkspaceMock.mockResolvedValue({
      ...workspace,
      snapshot: {
        id: "snap-sql",
        generatedAt: new Date("2026-03-01T00:00:00.000Z"),
        buildDurationMs: 12_000,
        profileHash: "profile-sentry",
        runtime: "node22",
        dependencyCount: 0,
      },
    });

    const snapshot = await resolve();
    expect(snapshot.snapshotId).toBe("snap-sql");
    expect(snapshot.cacheHit).toBe(true);
    expect(setCachedSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileHash: "profile-sentry",
        snapshotId: "snap-sql",
      }),
    );
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });
});
