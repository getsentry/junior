import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackCanvasCreateTool } from "@/chat/tools/slack-canvas-create";
import { createOperationKey } from "@/chat/tools/idempotency";
import { createSlackListAddItemsTool } from "@/chat/tools/slack-list-add-items";
import type { ToolState } from "@/chat/tools/types";

const createCanvasMock = vi.fn();
const addListItemsMock = vi.fn();

vi.mock("@/chat/slack-actions/canvases", () => ({
  createCanvas: (...args: unknown[]) => createCanvasMock(...args)
}));

vi.mock("@/chat/slack-actions/lists", () => ({
  addListItems: (...args: unknown[]) => addListItemsMock(...args)
}));

function createToolState(options: {
  currentCanvasId?: string;
  currentListId?: string;
} = {}): ToolState {
  const operationResultCache = new Map<string, unknown>();
  const artifactState: Record<string, unknown> = {
    listColumnMap: {}
  };

  return {
    artifactState: artifactState as ToolState["artifactState"],
    patchArtifactState: (patch) => Object.assign(artifactState, patch),
    getCurrentCanvasId: () => options.currentCanvasId,
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
  beforeEach(() => {
    createCanvasMock.mockReset();
    addListItemsMock.mockReset();
  });

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
    createCanvasMock.mockResolvedValue({
      canvasId: "canvas-1",
      permalink: "https://example.invalid/canvas-1"
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

    expect(createCanvasMock).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      ok: true,
      canvas_id: "canvas-1"
    });
    expect(second).toMatchObject({
      ok: true,
      canvas_id: "canvas-1",
      deduplicated: true
    });
  });

  it("deduplicates repeated slack_list_add_items operations in one turn", async () => {
    addListItemsMock.mockResolvedValue({
      createdItemIds: ["item-1", "item-2"],
      listColumnMap: {
        titleColumnId: "col-title"
      }
    });
    const state = createToolState({ currentListId: "list-1" });
    const tool = createSlackListAddItemsTool(state);

    const first = await executeTool(tool, {
      items: ["Ship patch", "Run test"]
    });
    const second = await executeTool(tool, {
      items: ["Ship patch", "Run test"]
    });

    expect(addListItemsMock).toHaveBeenCalledTimes(1);
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
    createCanvasMock.mockRejectedValue(new Error("slack api unavailable"));
    const state = createToolState();
    const tool = createSlackCanvasCreateTool({ channelId: "C123", sandbox: noopSandbox }, state);

    await expect(
      executeTool(tool, {
        title: "Incident plan",
        markdown: "placeholder"
      })
    ).rejects.toThrow("slack api unavailable");
  });
});
