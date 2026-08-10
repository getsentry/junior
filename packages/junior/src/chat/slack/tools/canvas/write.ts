import { writeCanvasMarkdown } from "@/chat/slack/tools/canvas/api";
import { resolveCanvasTarget } from "@/chat/slack/tools/canvas/context";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Create a tool that deliberately replaces a Slack canvas body. */
export function createSlackCanvasWriteTool(state: ToolState) {
  return zodTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Write UTF-8 markdown content to a Slack canvas. Use for deliberate full-Canvas replacement after validation; use slackCanvasEdit for targeted changes to existing canvas content.",
    executionMode: "sequential",
    inputSchema: z.object({
      canvas: z
        .string()
        .min(1)
        .describe("Canvas/file ID (e.g. `F0ABCDEF`) or Slack canvas/docs URL."),
      content: z.string().describe("UTF-8 markdown content to write."),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ canvas, content }) => {
      const target = resolveCanvasTarget(canvas);
      if (!target.ok) {
        throw new ToolInputError(target.error);
      }

      const operationKey = createOperationKey("slackCanvasWrite", {
        canvas_id: target.canvasId,
        content,
      });
      const cached = state.getOperationResult<{
        canvas_id: string;
        normalized_heading_count: number;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true,
        };
      }

      const written = await writeCanvasMarkdown({
        canvasId: target.canvasId,
        markdown: content,
      });
      const response = {
        canvas_id: target.canvasId,
        normalized_heading_count: written.normalizedHeadingCount,
        summary: `Wrote canvas ${target.canvasId}`,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
