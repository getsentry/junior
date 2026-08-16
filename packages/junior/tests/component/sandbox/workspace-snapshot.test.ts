import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  sandboxCreateMock,
  sandboxGetMock,
  getWorkspaceMock,
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
  getCachedSnapshot: vi.fn(async () => null),
  setCachedSnapshot: setCachedSnapshotMock,
}));
vi.mock("@/chat/sandbox/workspace", () => ({
  createSandboxSession: (sandbox: unknown) => sandbox,
  stopSession: vi.fn(async () => {}),
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
    installDependenciesMock.mockResolvedValue(undefined);
    installPostinstallMock.mockResolvedValue(undefined);
    prepareRepositoriesMock.mockResolvedValue(undefined);
  });

  it("starts one detached setup and snapshots it on a later check", async () => {
    const detachedCommand = { cmdId: "cmd-1" };
    const builder = {
      runCommand: vi.fn(async () => detachedCommand),
    };
    sandboxCreateMock.mockResolvedValue(builder);

    let recordedBuild: Workspace["snapshotBuild"];
    setWorkspaceSnapshotBuildMock.mockImplementation(async (_id, build) => {
      recordedBuild = build;
    });

    await expect(resolve()).rejects.toBeInstanceOf(
      WorkspaceSnapshotBuildingError,
    );
    expect(sandboxCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        persistent: true,
        timeout: 24 * 60 * 60 * 1000,
      }),
    );
    expect(builder.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        detached: true,
        timeoutMs: 24 * 60 * 60 * 1000,
      }),
    );

    const command: { exitCode: number | null; stderr: ReturnType<typeof vi.fn> } = {
      exitCode: null,
      stderr: vi.fn(),
    };
    const resumed = {
      getCommand: vi.fn(async () => command),
      snapshot: vi.fn(async () => ({ snapshotId: "snap-sentry" })),
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
  });
});
