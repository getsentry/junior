import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listWorkspaces = vi.fn();
const getWorkspace = vi.fn();
const createSandbox = vi.fn();
const createPluginHookRunner = vi.fn(() => ({
  prepareWorkspace: vi.fn(),
}));
const credentialContextForActor = vi.fn(() => ({ mode: "system" }));
const getDb = vi.fn(() => ({ kind: "db" }));

vi.mock("@/chat/db", () => ({
  getDb,
}));
vi.mock("@/chat/credentials/context", () => ({
  credentialContextForActor,
}));
vi.mock("@/chat/plugins/agent-hooks", () => ({
  createPluginHookRunner,
}));
vi.mock("@/chat/sandbox/sandbox", () => ({
  createSandbox,
}));
vi.mock("@/chat/workspaces/store", () => ({
  getWorkspace,
  listWorkspaces,
}));
vi.mock("@/chat/logging", () => ({
  logException: vi.fn(),
  logInfo: vi.fn(),
}));

describe("workspace prebuild scheduling", () => {
  beforeEach(async () => {
    vi.resetModules();
    listWorkspaces.mockReset();
    getWorkspace.mockReset();
    createSandbox.mockReset();
    createPluginHookRunner.mockClear();
    credentialContextForActor.mockClear();
    getDb.mockClear();

    const { resetWorkspacePrebuildScheduleForTests } = await import(
      "@/chat/workspaces/prebuild"
    );
    resetWorkspacePrebuildScheduleForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues one queue message per opted-in Workspace once per process", async () => {
    listWorkspaces.mockResolvedValue([
      { id: "ws_a", prebuild: true },
      { id: "ws_b", prebuild: false },
      { id: "ws_c", prebuild: true },
    ]);
    const send = vi.fn(async () => undefined);
    const { scheduleWorkspacePrebuilds } = await import(
      "@/chat/workspaces/prebuild"
    );

    await scheduleWorkspacePrebuilds({ send });
    await scheduleWorkspacePrebuilds({ send });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({ workspaceId: "ws_a" });
    expect(send).toHaveBeenCalledWith({ workspaceId: "ws_c" });
  });

  it("builds only opted-in Workspaces from queue messages", async () => {
    const stop = vi.fn(async () => undefined);
    const switchWorkspace = vi.fn(async () => undefined);
    createSandbox.mockReturnValue({ stop, switchWorkspace });
    getWorkspace.mockResolvedValue({
      id: "ws_a",
      prebuild: true,
      name: "slow",
      repos: [],
    });

    const { processWorkspacePrebuild } = await import(
      "@/chat/workspaces/prebuild"
    );
    await processWorkspacePrebuild({ workspaceId: "ws_a" });

    expect(switchWorkspace).toHaveBeenCalledWith({
      id: "ws_a",
      prebuild: true,
      name: "slow",
      repos: [],
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("skips disabled Workspaces without building", async () => {
    const stop = vi.fn(async () => undefined);
    const switchWorkspace = vi.fn(async () => undefined);
    createSandbox.mockReturnValue({ stop, switchWorkspace });
    getWorkspace.mockResolvedValue({
      id: "ws_a",
      prebuild: false,
      name: "slow",
      repos: [],
    });

    const { processWorkspacePrebuild } = await import(
      "@/chat/workspaces/prebuild"
    );
    await processWorkspacePrebuild({ workspaceId: "ws_a" });

    expect(createSandbox).not.toHaveBeenCalled();
    expect(switchWorkspace).not.toHaveBeenCalled();
  });
});
