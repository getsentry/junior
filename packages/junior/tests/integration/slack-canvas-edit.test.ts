import { describe, expect, it } from "vitest";
import { createSlackCanvasEditTool } from "@/chat/slack/tools/canvas/edit";
import { createSlackCanvasWriteTool } from "@/chat/slack/tools/canvas/write";
import type { ToolState } from "@/chat/tools/types";
import { canvasesEditOk, filesInfoOk } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
  queueSlackPrivateFileDownload,
} from "../msw/handlers/slack-api";

function createState(): ToolState {
  const operationResultCache = new Map<string, unknown>();

  return {
    getOperationResult: <T>(operationKey: string) =>
      operationResultCache.get(operationKey) as T | undefined,
    setOperationResult: (operationKey: string, result: unknown) => {
      operationResultCache.set(operationKey, result);
    },
  };
}

function queueCanvasRead(canvasId: string, body: string): void {
  queueSlackApiResponse("files.info", {
    body: filesInfoOk({
      fileId: canvasId,
      title: "Reference Canvas",
      permalink: `https://sentry.slack.com/docs/T000/${canvasId}`,
      urlPrivate: `https://files.slack.com/files-pri/T000-${canvasId}/canvas.md`,
    }),
  });
  queueSlackPrivateFileDownload({ status: 200, body });
}

describe("Slack canvas file-like tools", () => {
  it("edits a canvas with exact replacements and writes the full next markdown body", async () => {
    queueCanvasRead(
      "F0PREVIOUS",
      "# Section A\n\nOld summary\n\n# Section B\n\nKeep me",
    );
    queueSlackApiResponse("canvases.edit", {
      body: canvasesEditOk(),
    });
    const state = createState();
    const tool = createSlackCanvasEditTool(state);

    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasEdit execute function missing");
    }

    const result = await tool.execute(
      {
        canvas: "F0PREVIOUS",
        edits: [{ oldText: "Old summary", newText: "New summary" }],
      },
      {} as never,
    );

    const editCalls = getCapturedSlackApiCalls("canvases.edit");
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.params).toMatchObject({
      canvas_id: "F0PREVIOUS",
      changes: [
        {
          operation: "replace",
          document_content: {
            type: "markdown",
            markdown: "# Section A\n\nNew summary\n\n# Section B\n\nKeep me",
          },
        },
      ],
    });
    const change = editCalls[0]?.params.changes as
      | Array<Record<string, unknown>>
      | undefined;
    expect(change?.[0]).not.toHaveProperty("section_id");
    expect(result).toMatchObject({
      canvas_id: "F0PREVIOUS",
      replacements: 1,
      first_changed_line: 3,
    });
    expect((result as { diff: string }).diff).toContain("-3 Old summary");
    expect((result as { diff: string }).diff).toContain("+3 New summary");
  });

  it("applies multiple edits against the original canvas content in one write", async () => {
    queueCanvasRead(
      "F0PREVIOUS",
      "# A\n\nAlpha\n\n# B\n\nBeta\n\n# C\n\nGamma",
    );
    queueSlackApiResponse("canvases.edit", {
      body: canvasesEditOk(),
    });
    const state = createState();
    const tool = createSlackCanvasEditTool(state);

    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasEdit execute function missing");
    }

    const result = await tool.execute(
      {
        canvas: "F0PREVIOUS",
        edits: [
          { oldText: "Alpha", newText: "Alpha updated" },
          { oldText: "Gamma", newText: "Gamma updated" },
        ],
      },
      {} as never,
    );

    expect(result).toMatchObject({
      replacements: 2,
    });
    const editCalls = getCapturedSlackApiCalls("canvases.edit");
    expect(editCalls[0]?.params).toMatchObject({
      changes: [
        {
          operation: "replace",
          document_content: {
            markdown:
              "# A\n\nAlpha updated\n\n# B\n\nBeta\n\n# C\n\nGamma updated",
          },
        },
      ],
    });
  });

  it("returns an edit diff without unrelated heading normalization noise", async () => {
    queueCanvasRead(
      "F0PREVIOUS",
      "#### Deep heading\n\nOld summary\n\nKeep me",
    );
    queueSlackApiResponse("canvases.edit", {
      body: canvasesEditOk(),
    });
    const state = createState();
    const tool = createSlackCanvasEditTool(state);

    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasEdit execute function missing");
    }

    const result = await tool.execute(
      {
        canvas: "F0PREVIOUS",
        edits: [{ oldText: "Old summary", newText: "New summary" }],
      },
      {} as never,
    );

    expect(result).toMatchObject({
      first_changed_line: 3,
      normalized_heading_count: 1,
    });
    const diff = (result as { diff: string }).diff;
    expect(diff).toContain(" 1 ### Deep heading");
    expect(diff).toContain("-3 Old summary");
    expect(diff).toContain("+3 New summary");
    expect(diff).not.toContain("#### Deep heading");
  });

  it("rejects missing exact text without writing to Slack", async () => {
    queueCanvasRead("F0PREVIOUS", "# Section\n\nOriginal");
    const state = createState();
    const tool = createSlackCanvasEditTool(state);

    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasEdit execute function missing");
    }

    await expect(
      tool.execute(
        {
          canvas: "F0PREVIOUS",
          edits: [{ oldText: "Missing", newText: "Replacement" }],
        },
        {} as never,
      ),
    ).rejects.toThrow("Could not find");
    expect(getCapturedSlackApiCalls("canvases.edit")).toHaveLength(0);
  });

  it("rejects ambiguous exact text without writing to Slack", async () => {
    queueCanvasRead("F0PREVIOUS", "# A\n\nDuplicate\n\n# B\n\nDuplicate");
    const state = createState();
    const tool = createSlackCanvasEditTool(state);

    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasEdit execute function missing");
    }

    await expect(
      tool.execute(
        {
          canvas: "F0PREVIOUS",
          edits: [{ oldText: "Duplicate", newText: "Replacement" }],
        },
        {} as never,
      ),
    ).rejects.toThrow("occurrences");
    expect(getCapturedSlackApiCalls("canvases.edit")).toHaveLength(0);
  });

  it("writes a full canvas body only through the explicit write tool", async () => {
    queueSlackApiResponse("canvases.edit", {
      body: canvasesEditOk(),
    });
    const state = createState();
    const tool = createSlackCanvasWriteTool(state);

    if (typeof tool.execute !== "function") {
      throw new Error("slackCanvasWrite execute function missing");
    }

    const result = await tool.execute(
      {
        canvas: "F0PREVIOUS",
        content: "# Replacement\n\nNew body",
      },
      {} as never,
    );

    expect(result).toMatchObject({
      canvas_id: "F0PREVIOUS",
    });
    const editCalls = getCapturedSlackApiCalls("canvases.edit");
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.params).toMatchObject({
      canvas_id: "F0PREVIOUS",
      changes: [
        {
          operation: "replace",
          document_content: {
            type: "markdown",
            markdown: "# Replacement\n\nNew body",
          },
        },
      ],
    });
  });
});
