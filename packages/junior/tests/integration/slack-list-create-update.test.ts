import { describe, expect, it } from "vitest";
import { createSlackListCreateTool } from "@/chat/tools/slack/list-tools";
import { createSlackListUpdateItemTool } from "@/chat/tools/slack/list-tools";
import type { ToolState } from "@/chat/tools/types";
import { slackListsCreateOk } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
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
    getCurrentCanvasId: () => undefined,
    getTurnCreatedCanvasId: () => undefined,
    setTurnCreatedCanvasId: () => undefined,
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

describe("slack list create/update tools", () => {
  it("creates a list, persists thread artifact state, and deduplicates repeated create calls", async () => {
    queueSlackApiResponse("slackLists.create", {
      body: slackListsCreateOk({ listId: "LIST_ABC" }),
    });
    queueSlackApiResponse("files.info", {
      body: {
        ok: true,
        file: {
          id: "LIST_ABC",
          permalink: "https://example.invalid/files/LIST_ABC",
        },
      },
    });

    const state = createToolState();
    const tool = createSlackListCreateTool(state);

    const first = await executeTool(tool, { name: "Incident checklist" });
    const second = await executeTool(tool, { name: "Incident checklist" });

    expect(first).toMatchObject({
      ok: true,
      list_id: "LIST_ABC",
      permalink: "https://example.invalid/files/LIST_ABC",
    });
    expect(second).toMatchObject({
      ok: true,
      list_id: "LIST_ABC",
      deduplicated: true,
    });
    expect(state.artifactState.lastListId).toBe("LIST_ABC");
    expect(state.artifactState.listColumnMap).toMatchObject({
      titleColumnId: "COL_TITLE",
      completedColumnId: "COL_DONE",
      assigneeColumnId: "COL_ASSIGNEE",
      dueDateColumnId: "COL_DUE",
    });

    expect(getCapturedSlackApiCalls("slackLists.create")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("files.info")).toHaveLength(1);
  });

  it("updates list items using inferred title/completed columns", async () => {
    queueSlackApiResponse("slackLists.items.update", {
      body: { ok: true },
    });

    const state = createToolState({
      currentListId: "LIST_ABC",
      listColumnMap: {
        titleColumnId: "COL_TITLE",
        completedColumnId: "COL_DONE",
      },
    });
    const tool = createSlackListUpdateItemTool(state);

    const result = await executeTool(tool, {
      item_id: "ROW_77",
      completed: true,
      title: "Ship durable workflow rollout",
    });

    expect(result).toEqual({
      ok: true,
      list_id: "LIST_ABC",
      item_id: "ROW_77",
      completed: true,
      title: "Ship durable workflow rollout",
    });

    const updateCalls = getCapturedSlackApiCalls("slackLists.items.update");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.params).toMatchObject({
      list_id: "LIST_ABC",
    });
    expect(updateCalls[0]?.params.cells).toEqual([
      {
        row_id: "ROW_77",
        column_id: "COL_DONE",
        checkbox: true,
      },
      {
        row_id: "ROW_77",
        column_id: "COL_TITLE",
        rich_text: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "Ship durable workflow rollout" },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("fails fast when update fields cannot be mapped to list columns", async () => {
    const state = createToolState({
      currentListId: "LIST_ABC",
      listColumnMap: {},
    });
    const tool = createSlackListUpdateItemTool(state);

    await expect(
      executeTool(tool, {
        item_id: "ROW_77",
        completed: true,
      }),
    ).rejects.toThrow(
      "No updatable fields were provided or inferred for this list item",
    );
    expect(getCapturedSlackApiCalls("slackLists.items.update")).toHaveLength(0);
  });
});
