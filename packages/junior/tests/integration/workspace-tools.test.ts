import {
  createLocalSource,
  defineJuniorPlugin,
} from "@sentry/junior-plugin-api";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/chat/db";
import { normalizeLocalConversationId } from "@/chat/local/conversation";
import {
  runLocalAgentTurn,
  type LocalAgentReply,
  type LocalToolResult,
} from "@/chat/local/runner";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { juniorWorkspaceRepos, juniorWorkspaces } from "@/db/schema";
import { createModelAgentRunner } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createWorkspaceTools } from "@/chat/workspaces/tools";
import { listWorkspaceNamesByRepository } from "@/chat/workspaces/store";
import { readStats } from "@/stats";

describe("Workspace tools", () => {
  it("runs Workspace tools through the real agent tool path", async () => {
    const previousPlugins = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "github",
          displayName: "GitHub",
          description: "GitHub",
        },
        hooks: {
          async workspacePrepare() {},
        },
      }),
    ]);
    try {
      const now = new Date("2026-08-13T12:00:00.000Z");
      const workspace = {
        id: "11111111-1111-4111-8111-111111111111",
        name: "sentry",
        setupScript: "pnpm install",
        repos: [
          {
            provider: "github",
            repo: "getsentry/sentry",
          },
        ],
      };
      const db = getDb();
      await db.insert(juniorWorkspaces).values({
        id: workspace.id,
        name: workspace.name,
        setupScript: workspace.setupScript,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(juniorWorkspaceRepos).values({
        workspaceId: workspace.id,
        ...workspace.repos[0]!,
      });
      await expect(
        listWorkspaceNamesByRepository(db, {
          provider: "github",
          repo: "getsentry/sentry",
        }),
      ).resolves.toEqual(["sentry"]);
      await expect(
        listWorkspaceNamesByRepository(db, {
          provider: "GitHub",
          repo: "GetSentry/Sentry",
        }),
      ).resolves.toEqual(["sentry"]);
      const conversationId = normalizeLocalConversationId({
        alias: "workspace-tools",
        cwd: "/tmp/local-agent-workspace-tools",
      });
      expect(conversationId).toBeDefined();
      const destination = {
        platform: "local",
        conversationId: conversationId!,
      } as const;
      const workspaceTools = createWorkspaceTools({
        destination,
        egress: { fetch: async () => new Response("ok") },
        source: createLocalSource(destination.conversationId),
        workspace: {} as ToolRuntimeContext["workspace"],
        workspaces: {
          activeWorkspaceId: () => undefined,
          switch: async () => undefined,
        },
      });
      const createTool = workspaceTools.createWorkspace!;
      const updateTool = workspaceTools.updateWorkspace!;
      const deleteTool = workspaceTools.deleteWorkspace!;
      expect(createTool.description).toContain("`github`");
      expect(updateTool.description).toContain("`github`");
      const createInput = createTool.prepareArguments!({
        name: "relay",
        setup_script: "cargo fetch",
        repos: [
          {
            provider: "github",
            repo: "getsentry/relay",
          },
        ],
      });
      const updateInput = updateTool.prepareArguments!({
        id: workspace.id,
        name: "sentry-web",
        setup_script: "pnpm install",
        repos: [
          {
            provider: "github",
            repo: "getsentry/sentry",
          },
        ],
      });

      expect(createTool.approvalMode).toBe("review");
      expect(createTool.describeProposal?.(createInput)).toBe(
        "Create Workspace relay (1 repository; includes a setup script).",
      );
      expect(updateTool.approvalMode).toBe("review");
      expect(updateTool.describeProposal?.(updateInput)).toBe(
        "Replace Workspace sentry-web (1 repository; includes a setup script).",
      );
      expect(deleteTool.approvalMode).toBe("review");
      expect(deleteTool.describeProposal?.({ id: workspace.id })).toBe(
        `Delete Workspace ${workspace.id}.`,
      );
      expect(
        createTool.prepareArguments!({
          name: "relay",
          setup_script: null,
          repos: [
            {
              provider: "github",
              repo: "getsentry/relay",
            },
          ],
        }),
      ).toEqual({
        name: "relay",
        repos: [
          {
            provider: "github",
            repo: "getsentry/relay",
          },
        ],
      });
      expect(
        createTool.describeProposal?.(
          createTool.prepareArguments!({
            name: "relay",
            setup_script: null,
            repos: [
              {
                provider: "github",
                repo: "getsentry/relay",
              },
            ],
          }),
        ),
      ).toBe("Create Workspace relay (1 repository).");
      expect(() =>
        createTool.prepareArguments!({
          name: "broken",
          repos: [
            {
              provider: "missing",
              repo: "getsentry/relay",
            },
          ],
        }),
      ).toThrow(/Invalid tool arguments/);
      expect(() =>
        updateTool.prepareArguments!({
          id: workspace.id,
          name: "sentry-web",
          repos: [
            {
              provider: "github",
              repo: "getsentry/sentry",
            },
          ],
          extra: true,
        }),
      ).toThrow(/Invalid tool arguments/);
      await expect(
        createTool.execute!(createInput, { toolCallId: "create-workspace" }),
      ).resolves.toMatchObject({ workspace: { name: "relay" } });
      await expect(
        updateTool.execute!(updateInput, { toolCallId: "update-workspace" }),
      ).resolves.toMatchObject({ workspace: { name: "sentry-web" } });

      const delivered: LocalAgentReply[] = [];
      const results: LocalToolResult[] = [];

      await runLocalAgentTurn(
        {
          conversationId: conversationId!,
          message: "List the available Workspaces.",
        },
        {
          agentRunner: createModelAgentRunner(
            createModelStream([
              { type: "toolCall", name: "listWorkspaces", arguments: {} },
              {
                type: "toolCall",
                name: "switchWorkspace",
                arguments: { name: "missing" },
              },
              { type: "text", text: "The missing Workspace was not found." },
            ]),
          ),
          deliverReply: async (reply) => {
            delivered.push(reply);
          },
          onToolResult: async (result) => {
            results.push(result);
          },
        },
      );

      expect(results).toEqual([
        expect.objectContaining({
          ok: true,
          toolCallId: expect.any(String),
          toolName: "listWorkspaces",
          params: {},
          result: {
            active_workspace_id: null,
            workspaces: [
              {
                id: expect.any(String),
                name: "relay",
                setup_script: "cargo fetch",
                repos: [
                  {
                    provider: "github",
                    repo: "getsentry/relay",
                    checkout_path: "repos/relay",
                  },
                ],
              },
              {
                id: workspace.id,
                name: "sentry-web",
                setup_script: "pnpm install",
                repos: [
                  {
                    provider: "github",
                    repo: "getsentry/sentry",
                    checkout_path: "repos/sentry",
                  },
                ],
              },
            ],
          },
        }),
        expect.objectContaining({
          error: "Workspace not found: missing",
          ok: false,
          toolCallId: expect.any(String),
          toolName: "switchWorkspace",
          params: { name: "missing" },
        }),
      ]);
      expect(delivered).toEqual([
        { text: "The missing Workspace was not found." },
      ]);
      await expect(
        deleteTool.execute!(
          { id: workspace.id },
          { toolCallId: "delete-workspace" },
        ),
      ).resolves.toEqual({ deleted: true });
    } finally {
      setPlugins(previousPlugins);
    }
  });

  it("records successful Workspace switches in daily stats", async () => {
    const now = new Date();
    const workspace = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "sentry",
      setupScript: "",
      snapshot: null,
      snapshotBuild: null,
      repos: [{ provider: "github", repo: "getsentry/sentry" }],
    };
    const db = getDb();
    await db.insert(juniorWorkspaces).values({
      id: workspace.id,
      name: workspace.name,
      setupScript: workspace.setupScript,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(juniorWorkspaceRepos).values({
      workspaceId: workspace.id,
      ...workspace.repos[0]!,
    });
    const switchWorkspace = vi.fn().mockResolvedValue(undefined);
    const context = {
      destination: {
        platform: "local",
        conversationId: "local:test:workspace-stats",
      },
      source: createLocalSource("local:test:workspace-stats"),
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
    } satisfies ToolRuntimeContext;

    const tools = createWorkspaceTools(context);
    await expect(
      tools.switchWorkspace!.execute!({ name: workspace.name }, {}),
    ).resolves.toMatchObject({
      workspace: { id: workspace.id },
    });

    expect(switchWorkspace).toHaveBeenCalledWith(workspace, undefined);
    const date = now.toISOString().slice(0, 10);
    await expect(readStats(date, date)).resolves.toContainEqual({
      count: 1,
      date,
      metric: "workspace_switch",
      name: workspace.id,
      namespace: "junior",
    });
  });

  it("returns timed_out building when the snapshot wait soft-yields", async () => {
    const { WorkspaceSnapshotWaitingError } = await import(
      "@/chat/sandbox/snapshot/waiting-error"
    );
    const now = new Date();
    const workspace = {
      id: "22222222-2222-4222-8222-222222222222",
      name: "sentry-building",
      setupScript: "devenv sync",
      snapshot: null,
      snapshotBuild: null,
      repos: [{ provider: "github", repo: "getsentry/sentry" }],
    };
    const db = getDb();
    await db.insert(juniorWorkspaces).values({
      id: workspace.id,
      name: workspace.name,
      setupScript: workspace.setupScript,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(juniorWorkspaceRepos).values({
      workspaceId: workspace.id,
      ...workspace.repos[0]!,
    });
    const switchWorkspace = vi
      .fn()
      .mockRejectedValue(new WorkspaceSnapshotWaitingError(workspace.name));
    const context = {
      destination: {
        platform: "local",
        conversationId: "local:test:workspace-building",
      },
      source: createLocalSource("local:test:workspace-building"),
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
    } satisfies ToolRuntimeContext;

    const tools = createWorkspaceTools(context);
    await expect(
      tools.switchWorkspace!.execute!({ name: workspace.name }, {}),
    ).resolves.toMatchObject({
      workspace: { id: workspace.id },
      timed_out: true,
    });
  });
});
