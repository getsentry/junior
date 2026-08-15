import { describe, expect, it } from "vitest";
import { getDb } from "@/chat/db";
import { normalizeLocalConversationId } from "@/chat/local/conversation";
import {
  runLocalAgentTurn,
  type LocalAgentReply,
  type LocalToolResult,
} from "@/chat/local/runner";
import { juniorWorkspaceRepos, juniorWorkspaces } from "@/db/schema";
import { createModelAgentRunner } from "../fixtures/agent-runner";
import { createModelStream } from "../fixtures/model-stream";
import { listWorkspaceNamesByRepository } from "@/chat/workspaces/store";

describe("Workspace tools", () => {
  it("runs Workspace tools through the real agent tool path", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const workspace = {
      id: "workspace-1",
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
  });
});
