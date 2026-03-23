import { describe, expect, it } from "vitest";
import { createSlackCanvasUpdateTool } from "@/chat/tools/slack/canvas-tools";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";
import { canvasesEditOk } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

function createState(
  options: { currentCanvasId?: string; turnCreatedCanvasId?: string } = {},
): ToolState {
  const operationResultCache = new Map<string, unknown>();
  const artifactState: Record<string, unknown> = {};
  let turnCreatedCanvasId = options.turnCreatedCanvasId;
  return {
    artifactState: artifactState as ToolState["artifactState"],
    patchArtifactState: (patch) => Object.assign(artifactState, patch),
    getCurrentCanvasId: () => options.currentCanvasId,
    getTurnCreatedCanvasId: () => turnCreatedCanvasId,
    setTurnCreatedCanvasId: (canvasId: string) => {
      turnCreatedCanvasId = canvasId;
    },
    getCurrentListId: () => undefined,
    getOperationResult: <T>(operationKey: string) =>
      operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey: string, result: unknown) => {
      operationResultCache.set(operationKey, result);
    },
  };
}

function createContext(userText: string): ToolRuntimeContext {
  return {
    userText,
    sandbox: {} as never,
  };
}

describe("createSlackCanvasUpdateTool", () => {
  it("uses active artifact-state canvas when no same-turn canvas exists", async () => {
    queueSlackApiResponse("canvases.edit", {
      body: canvasesEditOk(),
    });
    const state = createState({ currentCanvasId: "F_PREVIOUS" });
    const tool = createSlackCanvasUpdateTool(
      state,
      createContext("append this to the doc"),
    );

    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasUpdate execute function missing");
    }

    const result = await tool.execute(
      {
        markdown: "new content",
      },
      {} as never,
    );

    const editCalls = getCapturedSlackApiCalls("canvases.edit");
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.params).toMatchObject({
      canvas_id: "F_PREVIOUS",
      changes: [
        {
          operation: "insert_at_end",
          document_content: {
            type: "markdown",
            markdown: "new content",
          },
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      canvas_id: "F_PREVIOUS",
      operation: "insert_at_end",
      section_id: undefined,
    });
    expect(state.artifactState.lastCanvasId).toBe("F_PREVIOUS");
  });

  it("allows implicit same-turn updates to a canvas created in this turn", async () => {
    queueSlackApiResponse("canvases.edit", {
      body: canvasesEditOk(),
    });
    const state = createState({
      currentCanvasId: "F_OLD",
      turnCreatedCanvasId: "F_NEW",
    });
    const tool = createSlackCanvasUpdateTool(
      state,
      createContext("append this section"),
    );

    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasUpdate execute function missing");
    }

    const result = await tool.execute(
      {
        markdown: "new section",
      },
      {} as never,
    );

    const editCalls = getCapturedSlackApiCalls("canvases.edit");
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.params).toMatchObject({
      canvas_id: "F_NEW",
      changes: [
        {
          operation: "insert_at_end",
          document_content: {
            type: "markdown",
            markdown: "new section",
          },
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      canvas_id: "F_NEW",
      operation: "insert_at_end",
      section_id: undefined,
    });
    expect(state.artifactState.lastCanvasId).toBe("F_NEW");
  });
});
