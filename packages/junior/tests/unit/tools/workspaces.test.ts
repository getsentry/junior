import { describe, expect, it, vi } from "vitest";
import { defineJuniorWorkspaces } from "@/chat/workspaces/config";
import { createWorkspaceTools } from "@/chat/workspaces/tools";

const workspace = {
  id: "workspace-1",
  name: "sentry",
  setupScript: "pnpm install",
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
  it("validates install-wide Workspace recipes", () => {
    expect(defineJuniorWorkspaces([workspace])).toEqual([workspace]);
    expect(() => defineJuniorWorkspaces([workspace, { ...workspace }])).toThrow(
      "Duplicate Workspace id: workspace-1",
    );
  });

  it("lists and switches registered workspaces", async () => {
    const switchWorkspace = vi.fn();
    const tools = createWorkspaceTools({
      workspaces: {
        activeWorkspaceId: () => undefined,
        recipes: [workspace],
        switch: switchWorkspace,
      },
    } as never);

    const listed = await tools.listWorkspaces!.execute!({}, {});
    expect(listed).toMatchObject({
      active_workspace_id: null,
      workspaces: [{ id: "workspace-1", name: "sentry" }],
    });

    const switched = await tools.switchWorkspace!.execute!(
      { name: "sentry" },
      {},
    );
    expect(switchWorkspace).toHaveBeenCalledWith(workspace, undefined);
    expect(switched).toMatchObject({ workspace: { name: "sentry" } });
  });
});
