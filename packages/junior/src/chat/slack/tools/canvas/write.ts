import { logWarn } from "@/chat/logging";
import { writeCanvasMarkdown } from "@/chat/slack/tools/canvas/api";
import {
  resolveCanvasTarget,
  storedCanvasUrl,
} from "@/chat/slack/tools/canvas/context";
import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

/** Create a tool that deliberately replaces a Slack canvas body. */
export function createSlackCanvasWriteTool(state: ToolState) {
  return zodTool({
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
    outputSchema: juniorToolResultSchema,
    execute: async ({ canvas, content }) => {
      const target = resolveCanvasTarget(canvas);
      if (!target.ok) {
        return { ...target, status: "error" as const };
      }

      const operationKey = createOperationKey("slackCanvasWrite", {
        canvas_id: target.canvasId,
        content,
      });
      const cached = state.getOperationResult<{
        ok: true;
        status: "success";
        canvas_id: string;
        normalized_heading_count: number;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true,
        };
      }

      try {
        const written = await writeCanvasMarkdown({
          canvasId: target.canvasId,
          markdown: content,
        });
        await state.patchArtifactState({
          lastCanvasId: target.canvasId,
          lastCanvasUrl: storedCanvasUrl(state, target.canvasId),
        });
        const response = {
          ok: true,
          status: "success" as const,
          canvas_id: target.canvasId,
          normalized_heading_count: written.normalizedHeadingCount,
          summary: `Wrote canvas ${target.canvasId}`,
        };
        state.setOperationResult(operationKey, response);
        return response;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "canvas write failed";
        logWarn(
          "slack_canvas_write_failed",
          {},
          {
            "gen_ai.tool.name": "slackCanvasWrite",
            "app.slack.canvas.canvas_id_prefix": target.canvasId.slice(0, 1),
          },
          message,
        );
        return {
          ok: false,
          status: "error" as const,
          canvas_id: target.canvasId,
          error: message,
        };
      }
    },
  });
}
