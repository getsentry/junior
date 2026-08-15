import { createLocalSource } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { Workspace } from "@/chat/workspaces/types";

const { getWorkspaceByName, incrementStat, logWarn, switchWorkspace } =
  vi.hoisted(() => ({
    getWorkspaceByName: vi.fn(),
    incrementStat: vi.fn(),
    logWarn: vi.fn(),
    switchWorkspace: vi.fn(),
  }));

vi.mock("@/chat/db", () => ({
  getDb: () => ({}),
}));

vi.mock("@/chat/logging", () => ({
  logWarn,
}));

vi.mock("@/chat/workspaces/store", () => ({
  getWorkspaceByName,
  listWorkspaces: vi.fn(),
}));

vi.mock("@/stats", () => ({
  incrementStat,
}));

import { createWorkspaceTools } from "@/chat/workspaces/tools";

const workspace: Workspace = {
  id: "workspace-1",
  name: "sentry",
  setupScript: "pnpm install",
  snapshot: null,
  repos: [{ provider: "github", repo: "getsentry/sentry" }],
};

function context(): ToolRuntimeContext {
  return {
    destination: { platform: "local", conversationId: "local:test:workspace-tools" },
    source: createLocalSource("local:test:workspace-tools"),
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    workspace: {} as ToolRuntimeContext["workspace"],
    workspaces: {
      activeWorkspaceId: () => undefined,
      switch: switchWorkspace,
    },
  };
}

describe("workspace tools stats", () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://junior";
    getWorkspaceByName.mockReset();
    getWorkspaceByName.mockResolvedValue(workspace);
    incrementStat.mockReset();
    incrementStat.mockResolvedValue(undefined);
    logWarn.mockReset();
    switchWorkspace.mockReset();
    switchWorkspace.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it("increments a daily workspace_switch counter after a successful switch", async () => {
    const tools = createWorkspaceTools(context());
    const signal = new AbortController().signal;
    const result = await tools.switchWorkspace!.execute!(
      { name: "sentry" },
      { toolCallId: "call-1", signal },
    );

    expect(switchWorkspace).toHaveBeenCalledWith(workspace, signal);
    expect(incrementStat).toHaveBeenCalledWith({
      namespace: "junior",
      metric: "workspace_switch",
      name: "sentry",
    });
    expect(result).toEqual({
      workspace: {
        id: "workspace-1",
        name: "sentry",
        setup_script: "pnpm install",
        repos: [
          {
            provider: "github",
            repo: "getsentry/sentry",
            checkout_path: "repos/sentry",
          },
        ],
      },
    });
  });

  it("does not record a counter when the switch fails", async () => {
    switchWorkspace.mockRejectedValue(new Error("sandbox unavailable"));
    const tools = createWorkspaceTools(context());

    await expect(
      tools.switchWorkspace!.execute!({ name: "sentry" }, {}),
    ).rejects.toThrow("sandbox unavailable");

    expect(incrementStat).not.toHaveBeenCalled();
  });

  it("keeps the tool successful when counter writes fail", async () => {
    incrementStat.mockRejectedValue(new Error("stats unavailable"));
    const tools = createWorkspaceTools(context());

    await expect(
      tools.switchWorkspace!.execute!({ name: "sentry" }, {}),
    ).resolves.toMatchObject({
      workspace: { name: "sentry" },
    });
    expect(logWarn).toHaveBeenCalledWith(
      "workspace.switch.stat.failed",
      expect.objectContaining({
        "app.workspace.id": "workspace-1",
        "app.workspace.name": "sentry",
      }),
    );
  });
});
