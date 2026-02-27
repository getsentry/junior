import { describe, expect, it, vi } from "vitest";
import { createSlackCanvasUpdateTool } from "@/chat/tools/slack-canvas-update";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

const lookupCanvasSectionMock = vi.fn();
const updateCanvasMock = vi.fn();

vi.mock("@/chat/slack-actions/canvases", () => ({
  lookupCanvasSection: (...args: unknown[]) => lookupCanvasSectionMock(...args),
  updateCanvas: (...args: unknown[]) => updateCanvasMock(...args)
}));

function createState(options: { currentCanvasId?: string; turnCreatedCanvasId?: string } = {}): ToolState {
  const operationResultCache = new Map<string, unknown>();
  let turnCreatedCanvasId = options.turnCreatedCanvasId;
  return {
    artifactState: {},
    patchArtifactState: vi.fn(),
    getCurrentCanvasId: () => options.currentCanvasId,
    getTurnCreatedCanvasId: () => turnCreatedCanvasId,
    setTurnCreatedCanvasId: (canvasId: string) => {
      turnCreatedCanvasId = canvasId;
    },
    getCurrentListId: () => undefined,
    getOperationResult: <T>(operationKey: string) => operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey: string, result: unknown) => {
      operationResultCache.set(operationKey, result);
    }
  };
}

function createContext(userText: string): ToolRuntimeContext {
  return {
    userText,
    sandbox: {} as never
  };
}

describe("createSlackCanvasUpdateTool", () => {
  it("does not default to prior-thread canvas when canvas_id is omitted", async () => {
    const state = createState({ currentCanvasId: "F_PREVIOUS" });
    const tool = createSlackCanvasUpdateTool(state, createContext("/brief Sunil Pai"));

    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasUpdate execute function missing");
    }

    const result = await tool.execute(
      {
        markdown: "new content"
      },
      {} as never
    );

    expect(result).toEqual({
      ok: false,
      error: "No canvas_id provided. For cross-turn updates, provide explicit canvas_id."
    });
    expect(updateCanvasMock).not.toHaveBeenCalled();
  });

  it("allows implicit same-turn updates to a canvas created in this turn", async () => {
    updateCanvasMock.mockResolvedValueOnce(undefined);
    const state = createState({ currentCanvasId: "F_OLD", turnCreatedCanvasId: "F_NEW" });
    const tool = createSlackCanvasUpdateTool(state, createContext("append this section"));

    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasUpdate execute function missing");
    }

    const result = await tool.execute(
      {
        markdown: "new section"
      },
      {} as never
    );

    expect(updateCanvasMock).toHaveBeenCalledWith({
      canvasId: "F_NEW",
      markdown: "new section",
      operation: "insert_at_end",
      sectionId: undefined
    });
    expect(result).toEqual({
      ok: true,
      canvas_id: "F_NEW",
      operation: "insert_at_end",
      section_id: undefined
    });
  });
});
