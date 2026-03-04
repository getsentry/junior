import { describe, expect, it } from "vitest";
import { createSlackCanvasCreateTool } from "@/chat/tools/slack-canvas-create";
import { createOperationKey } from "@/chat/tools/idempotency";
import { createSlackListAddItemsTool } from "@/chat/tools/slack-list-add-items";
import { SlackActionError } from "@/chat/slack-actions/client";
import type { ToolState } from "@/chat/tools/types";
import {
  conversationsCanvasesCreateOk,
  filesInfoOk,
  slackListsItemsCreateOk
} from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse
} from "../msw/handlers/slack-api";

function createToolState(options: {
  currentCanvasId?: string;
  currentListId?: string;
  listColumnMap?: {
    titleColumnId?: string;
    completedColumnId?: string;
    assigneeColumnId?: string;
    dueDateColumnId?: string;
  };
} = {}): ToolState {
  const operationResultCache = new Map<string, unknown>();
  let turnCreatedCanvasId: string | undefined;
  const artifactState: Record<string, unknown> = {
    listColumnMap: options.listColumnMap ?? {}
  };

  return {
    artifactState: artifactState as ToolState["artifactState"],
    patchArtifactState: (patch) => Object.assign(artifactState, patch),
    getCurrentCanvasId: () => options.currentCanvasId,
    getTurnCreatedCanvasId: () => turnCreatedCanvasId,
    setTurnCreatedCanvasId: (canvasId: string) => {
      turnCreatedCanvasId = canvasId;
    },
    getCurrentListId: () => options.currentListId,
    getOperationResult: <T>(operationKey: string): T | undefined => operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey, result) => {
      operationResultCache.set(operationKey, result);
    }
  };
}

const noopSandbox = {} as any;

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("tool idempotency", () => {
  it("creates deterministic operation keys regardless of object key order", () => {
    const a = createOperationKey("slack_canvas_create", {
      title: "Status",
      markdown: "hello",
      channel_id: "C123"
    });
    const b = createOperationKey("slack_canvas_create", {
      channel_id: "C123",
      markdown: "hello",
      title: "Status"
    });

    expect(a).toBe(b);
  });

  it("deduplicates repeated slack_canvas_create operations in one turn", async () => {
    queueSlackApiResponse("conversations.canvases.create", {
      body: conversationsCanvasesCreateOk({ canvasId: "canvas-1" })
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "canvas-1",
        permalink: "https://example.invalid/canvas-1"
      })
    });
    const state = createToolState();
    const tool = createSlackCanvasCreateTool({ channelId: "C123", sandbox: noopSandbox }, state);

    const first = await executeTool(tool, {
      title: "Weekly plan",
      markdown: "- item one"
    });
    const second = await executeTool(tool, {
      title: "Weekly plan",
      markdown: "- item one"
    });

    expect(getCapturedSlackApiCalls("conversations.canvases.create")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("files.info")).toHaveLength(1);
    expect(first).toMatchObject({
      ok: true,
      canvas_id: "canvas-1"
    });
    expect(second).toMatchObject({
      ok: true,
      canvas_id: "canvas-1",
      deduplicated: true
    });
    expect(state.artifactState.lastCanvasId).toBe("canvas-1");
    expect(state.artifactState.recentCanvases?.[0]).toMatchObject({
      id: "canvas-1",
      title: "Weekly plan",
      url: "https://example.invalid/canvas-1"
    });
  });

  it("creates a canvas from DM context using the bound channel", async () => {
    queueSlackApiResponse("conversations.canvases.create", {
      body: conversationsCanvasesCreateOk({ canvasId: "canvas-dm-1" })
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "canvas-dm-1",
        permalink: "https://example.invalid/canvas-dm-1"
      })
    });

    const state = createToolState();
    const tool = createSlackCanvasCreateTool({ channelId: "D123", sandbox: noopSandbox }, state);

    const result = await executeTool(tool, {
      title: "DM brief",
      markdown: "Body"
    });

    expect(result).toMatchObject({
      ok: true,
      canvas_id: "canvas-dm-1"
    });
    expect(getCapturedSlackApiCalls("conversations.canvases.create")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(0);
  });

  it("throws when creating a canvas without assistant channel context", async () => {
    const state = createToolState();
    const tool = createSlackCanvasCreateTool({ sandbox: noopSandbox }, state);

    await expect(
      executeTool(tool, {
        title: "No context",
        markdown: "Body"
      })
    ).rejects.toThrow("Cannot create a canvas without an active assistant channel context (C/G/D).");

    expect(getCapturedSlackApiCalls("conversations.canvases.create")).toHaveLength(0);
    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(0);
  });

  it("deduplicates repeated slack_list_add_items operations in one turn", async () => {
    queueSlackApiResponse("slackLists.items.create", {
      body: slackListsItemsCreateOk({ itemId: "item-1" })
    });
    queueSlackApiResponse("slackLists.items.create", {
      body: slackListsItemsCreateOk({ itemId: "item-2" })
    });
    const state = createToolState({
      currentListId: "list-1",
      listColumnMap: {
        titleColumnId: "col-title"
      }
    });
    const tool = createSlackListAddItemsTool(state);

    const first = await executeTool(tool, {
      items: ["Ship patch", "Run test"]
    });
    const second = await executeTool(tool, {
      items: ["Ship patch", "Run test"]
    });

    const itemCreateCalls = getCapturedSlackApiCalls("slackLists.items.create");
    expect(itemCreateCalls).toHaveLength(2);
    expect(itemCreateCalls[0]?.params).toMatchObject({
      list_id: "list-1"
    });
    expect(itemCreateCalls[1]?.params).toMatchObject({
      list_id: "list-1"
    });
    expect(first).toMatchObject({
      ok: true,
      list_id: "list-1",
      created_count: 2
    });
    expect(second).toMatchObject({
      ok: true,
      list_id: "list-1",
      deduplicated: true
    });
  });

  it("throws operational errors for slack_canvas_create execution failures", async () => {
    queueSlackApiError("conversations.canvases.create", {
      error: "internal_error"
    });
    const state = createToolState();
    const tool = createSlackCanvasCreateTool({ channelId: "C123", sandbox: noopSandbox }, state);

    await expect(
      executeTool(tool, {
        title: "Incident plan",
        markdown: "placeholder"
      })
    ).rejects.toBeInstanceOf(SlackActionError);
  });
});
