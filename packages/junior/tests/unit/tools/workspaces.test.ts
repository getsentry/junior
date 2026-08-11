import { describe, expect, it, vi } from "vitest";
import { createWorkspaceTools } from "@/chat/workspaces/tools";

const { getDbMock, listWorkspacesMock, getWorkspaceByNameMock } = vi.hoisted(
  () => ({
    getDbMock: vi.fn(() => ({})),
    listWorkspacesMock: vi.fn(),
    getWorkspaceByNameMock: vi.fn(),
  }),
);

vi.mock("@/chat/db", () => ({ getDb: getDbMock }));
vi.mock("@/chat/workspaces/store", () => ({
  listWorkspaces: listWorkspacesMock,
  getWorkspaceByName: getWorkspaceByNameMock,
}));

const workspace = {
  id: "workspace-1",
  name: "sentry",
  setupScript: "pnpm install",
  updatedAt: new Date("2026-03-10T00:00:00.000Z"),
  repos: [
    {
      provider: "github",
      repo: "getsentry/sentry",
      checkoutPath: "sentry",
      isPrimary: true,
    },
  ],
};

describe("workspace tools", () => {
  it("lists and switches registered workspaces", async () => {
    listWorkspacesMock.mockResolvedValue([workspace]);
    getWorkspaceByNameMock.mockResolvedValue(workspace);
    const switchWorkspace = vi.fn();
    const tools = createWorkspaceTools({
      workspaces: {
        activeWorkspaceId: () => undefined,
        switch: switchWorkspace,
      },
    } as never);

    const listed = await tools.listWorkspaces!.execute!({}, {});
    expect(listed).toMatchObject({
      active_workspace_id: null,
      workspaces: [{ id: "workspace-1", name: "sentry" }],
    });

    const switched = await tools.switchWorkspace!.execute!({ name: "sentry" }, {});
    expect(switchWorkspace).toHaveBeenCalledWith(workspace, undefined);
    expect(switched).toMatchObject({ workspace: { name: "sentry" } });
  });
});
