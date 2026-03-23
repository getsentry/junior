import { describe, expect, it } from "vitest";
import { createSlackListGetItemsTool } from "@/chat/tools/slack-list-tools";
import type { ToolState } from "@/chat/tools/types";
import { slackListsItemsListPage } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

function createToolState(options: { currentListId?: string } = {}): ToolState {
  const operationResultCache = new Map<string, unknown>();
  const artifactState: Record<string, unknown> = {
    listColumnMap: {},
  };
  let turnCreatedCanvasId: string | undefined;

  return {
    artifactState: artifactState as ToolState["artifactState"],
    patchArtifactState: (patch) => Object.assign(artifactState, patch),
    getCurrentCanvasId: () => undefined,
    getTurnCreatedCanvasId: () => turnCreatedCanvasId,
    setTurnCreatedCanvasId: (canvasId: string) => {
      turnCreatedCanvasId = canvasId;
    },
    getCurrentListId: () => options.currentListId,
    getOperationResult: <T>(operationKey: string): T | undefined =>
      operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey, result) => {
      operationResultCache.set(operationKey, result);
    },
  };
}

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("slack list tools", () => {
  it("does not expose model-selectable list_id in schema", () => {
    const tool = createSlackListGetItemsTool(createToolState());
    expect(tool.inputSchema).toMatchObject({
      properties: {
        limit: expect.any(Object),
      },
    });
    expect(
      (tool.inputSchema as { properties?: Record<string, unknown> }).properties
        ?.list_id,
    ).toBeUndefined();
  });

  it("returns an actionable error when list context is unavailable", async () => {
    const tool = createSlackListGetItemsTool(createToolState());

    const result = await executeTool(tool, {
      limit: 10,
    });

    expect(result).toEqual({
      ok: false,
      error: "No active list found in artifact context",
    });
    expect(getCapturedSlackApiCalls("slackLists.items.list")).toHaveLength(0);
  });

  it("paginates slack list item reads up to the requested limit", async () => {
    queueSlackApiResponse("slackLists.items.list", {
      body: slackListsItemsListPage({
        items: [{ id: "ROW_1", fields: [] }],
        nextCursor: "next-list-cursor",
      }),
    });
    queueSlackApiResponse("slackLists.items.list", {
      body: slackListsItemsListPage({
        items: [{ id: "ROW_2", fields: [] }],
      }),
    });
    const tool = createSlackListGetItemsTool(
      createToolState({
        currentListId: "LIST_123",
      }),
    );

    const result = await executeTool(tool, {
      limit: 2,
    });

    expect(result).toMatchObject({
      ok: true,
      list_id: "LIST_123",
      items: [
        { id: "ROW_1", fields: [] },
        { id: "ROW_2", fields: [] },
      ],
    });

    const listCalls = getCapturedSlackApiCalls("slackLists.items.list");
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]?.params).toMatchObject({
      list_id: "LIST_123",
    });
    expect(String(listCalls[0]?.params.limit)).toBe("2");
    expect(listCalls[1]?.params).toMatchObject({
      list_id: "LIST_123",
      cursor: "next-list-cursor",
    });
    expect(String(listCalls[1]?.params.limit)).toBe("2");
  });

  it("propagates missing_scope when Slack list reads fail", async () => {
    queueSlackApiError("slackLists.items.list", {
      error: "missing_scope",
      needed: "lists:read",
      provided: "chat:write",
    });
    const tool = createSlackListGetItemsTool(
      createToolState({
        currentListId: "LIST_123",
      }),
    );

    await expect(
      executeTool(tool, {
        limit: 1,
      }),
    ).rejects.toMatchObject({
      name: "SlackActionError",
      code: "missing_scope",
      needed: "lists:read",
      provided: "chat:write",
    });
  });
});
