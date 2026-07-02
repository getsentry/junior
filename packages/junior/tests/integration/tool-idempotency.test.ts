import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createSlackCanvasCreateTool } from "@/chat/tools/slack/canvas-tools";
import { createOperationKey } from "@/chat/tools/idempotency";
import { createSlackListAddItemsTool } from "@/chat/tools/slack/list-tools";
import { SlackActionError } from "@/chat/slack/client";
import type { ToolState } from "@/chat/tools/types";
import type { SlackToolContext } from "@/chat/tools/slack/context";
import {
  canvasesAccessSetOk,
  canvasesCreateOk,
  filesInfoOk,
  slackListsItemsCreateOk,
} from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

function createToolState(
  options: {
    currentListId?: string;
    listColumnMap?: {
      titleColumnId?: string;
      completedColumnId?: string;
      assigneeColumnId?: string;
      dueDateColumnId?: string;
    };
  } = {},
): ToolState {
  const operationResultCache = new Map<string, unknown>();
  const artifactState: Record<string, unknown> = {
    listColumnMap: options.listColumnMap ?? {},
  };

  return {
    artifactState: artifactState as ToolState["artifactState"],
    patchArtifactState: (patch) => {
      Object.assign(artifactState, patch);
    },
    getCurrentListId: () => options.currentListId,
    getOperationResult: <T>(operationKey: string): T | undefined =>
      operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey, result) => {
      operationResultCache.set(operationKey, result);
    },
  };
}

const noopSandbox = {} as any;

function slackContext(channelId: string): SlackToolContext {
  return {
    destination: {
      platform: "slack" as const,
      teamId: "T123",
      channelId,
    },
    source: createSlackSource({
      teamId: "T123",
      channelId,

      type: "priv",
    }),
    destinationChannelId: channelId,
    sourceChannelId: channelId,
    teamId: "T123",
  };
}

const LOCAL_CONTEXT = {
  destination: {
    platform: "local",
    conversationId: "local:test:tool-idempotency",
  },
  sandbox: noopSandbox,
} as const;

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
      channel_id: "C123",
    });
    const b = createOperationKey("slack_canvas_create", {
      channel_id: "C123",
      markdown: "hello",
      title: "Status",
    });

    expect(a).toBe(b);
  });

  it("deduplicates repeated slack_canvas_create operations in one turn", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "canvas-1" }),
    });
    queueSlackApiResponse("canvases.access.set", {
      body: canvasesAccessSetOk(),
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "canvas-1",
        permalink: "https://example.invalid/canvas-1",
      }),
    });
    const state = createToolState();
    const tool = createSlackCanvasCreateTool(slackContext("C123"), state);

    const first = await executeTool(tool, {
      title: "Weekly plan",
      markdown: "- item one",
    });
    const second = await executeTool(tool, {
      title: "Weekly plan",
      markdown: "- item one",
    });

    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("canvases.access.set")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("files.info")).toHaveLength(1);
    expect(first).toMatchObject({
      ok: true,
      canvas_id: "canvas-1",
    });
    expect(second).toMatchObject({
      ok: true,
      canvas_id: "canvas-1",
      deduplicated: true,
    });
    expect(state.artifactState.lastCanvasId).toBe("canvas-1");
    expect(state.artifactState.recentCanvases?.[0]).toMatchObject({
      id: "canvas-1",
      title: "Weekly plan",
      url: "https://example.invalid/canvas-1",
    });
  });

  it("creates a canvas from DM context using canvases.create and grants DM access", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "canvas-dm-1" }),
    });
    queueSlackApiResponse("canvases.access.set", {
      body: canvasesAccessSetOk(),
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "canvas-dm-1",
        permalink: "https://example.invalid/canvas-dm-1",
      }),
    });

    const state = createToolState();
    const tool = createSlackCanvasCreateTool(slackContext("D123"), state);

    const result = await executeTool(tool, {
      title: "DM brief",
      markdown: "Body",
    });

    expect(result).toMatchObject({
      ok: true,
      canvas_id: "canvas-dm-1",
    });
    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(1);

    const accessCalls = getCapturedSlackApiCalls("canvases.access.set");
    expect(accessCalls).toHaveLength(1);
    expect(accessCalls[0]?.params).toMatchObject({
      canvas_id: "canvas-dm-1",
      access_level: "write",
      channel_ids: ["D123"],
    });
    expect(
      getCapturedSlackApiCalls("conversations.canvases.create"),
    ).toHaveLength(0);
  });

  it("creates a canvas from assistant context channel during DM turns", async () => {
    queueSlackApiResponse("canvases.create", {
      body: canvasesCreateOk({ canvasId: "canvas-shared-1" }),
    });
    queueSlackApiResponse("canvases.access.set", {
      body: canvasesAccessSetOk(),
    });
    queueSlackApiResponse("files.info", {
      body: filesInfoOk({
        fileId: "canvas-shared-1",
        permalink: "https://example.invalid/canvas-shared-1",
      }),
    });

    const tool = createSlackCanvasCreateTool(
      {
        ...slackContext("D123"),
        destination: {
          platform: "slack" as const,
          teamId: "T123",
          channelId: "C_SHARED",
        },
        destinationChannelId: "C_SHARED",
      },
      createToolState(),
    );

    const result = await executeTool(tool, {
      title: "Shared brief",
      markdown: "Body",
    });

    expect(result).toMatchObject({
      ok: true,
      canvas_id: "canvas-shared-1",
    });
    expect(
      getCapturedSlackApiCalls("canvases.access.set")[0]?.params,
    ).toMatchObject({
      canvas_id: "canvas-shared-1",
      access_level: "write",
      channel_ids: ["C_SHARED"],
    });
  });

  it("throws when creating a canvas without assistant channel context", async () => {
    const state = createToolState();
    const tool = createSlackCanvasCreateTool(
      LOCAL_CONTEXT as unknown as SlackToolContext,
      state,
    );

    await expect(
      executeTool(tool, {
        title: "No context",
        markdown: "Body",
      }),
    ).rejects.toThrow(
      "Cannot create a canvas without an active assistant channel context (C/G/D).",
    );

    expect(getCapturedSlackApiCalls("canvases.create")).toHaveLength(0);
    expect(
      getCapturedSlackApiCalls("conversations.canvases.create"),
    ).toHaveLength(0);
  });

  it("deduplicates repeated slack_list_add_items operations in one turn", async () => {
    queueSlackApiResponse("slackLists.items.create", {
      body: slackListsItemsCreateOk({ itemId: "item-1" }),
    });
    queueSlackApiResponse("slackLists.items.create", {
      body: slackListsItemsCreateOk({ itemId: "item-2" }),
    });
    const state = createToolState({
      currentListId: "list-1",
      listColumnMap: {
        titleColumnId: "col-title",
      },
    });
    const tool = createSlackListAddItemsTool(state);

    const first = await executeTool(tool, {
      items: ["Ship patch", "Run test"],
    });
    const second = await executeTool(tool, {
      items: ["Ship patch", "Run test"],
    });

    const itemCreateCalls = getCapturedSlackApiCalls("slackLists.items.create");
    expect(itemCreateCalls).toHaveLength(2);
    expect(itemCreateCalls[0]?.params).toMatchObject({
      list_id: "list-1",
    });
    expect(itemCreateCalls[1]?.params).toMatchObject({
      list_id: "list-1",
    });
    expect(first).toMatchObject({
      ok: true,
      list_id: "list-1",
      created_count: 2,
    });
    expect(second).toMatchObject({
      ok: true,
      list_id: "list-1",
      deduplicated: true,
    });
  });

  it("throws operational errors for slack_canvas_create execution failures", async () => {
    queueSlackApiError("canvases.create", {
      error: "internal_error",
    });
    const state = createToolState();
    const tool = createSlackCanvasCreateTool(slackContext("C123"), state);

    await expect(
      executeTool(tool, {
        title: "Incident plan",
        markdown: "placeholder",
      }),
    ).rejects.toBeInstanceOf(SlackActionError);
  });
});
