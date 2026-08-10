import { describe, expect, it } from "vitest";
import { createSlackListGetItemsTool } from "@/chat/slack/tools/list/get-items";
import type { ToolState } from "@/chat/tools/types";
import { slackListsItemsListPage } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

function createToolState(): ToolState {
  const operationResultCache = new Map<string, unknown>();
  return {
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
  it("requires list_id in the schema", () => {
    const tool = createSlackListGetItemsTool(createToolState());
    expect(tool.inputSchema).toMatchObject({
      properties: {
        list_id: expect.any(Object),
        limit: expect.any(Object),
      },
      required: expect.arrayContaining(["list_id"]),
    });
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
    const tool = createSlackListGetItemsTool(createToolState());

    const result = await executeTool(tool, {
      list_id: "LIST_123",
      limit: 2,
    });

    expect(result).toMatchObject({
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
    const tool = createSlackListGetItemsTool(createToolState());

    await expect(
      executeTool(tool, {
        list_id: "LIST_123",
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
