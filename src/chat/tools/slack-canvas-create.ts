import { tool } from "ai";
import { z } from "zod";
import { createCanvas } from "@/chat/slack-actions/canvases";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

export function createSlackCanvasCreateTool(
  context: ToolRuntimeContext,
  state: ToolState
) {
  return tool({
    description: "Create a Slack canvas for long-form output in the current channel.",
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(160)
        .describe("Canvas title."),
      markdown: z
        .string()
        .min(1)
        .describe("Canvas markdown body content."),
      channel_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional Slack channel ID. Defaults to the current thread channel.")
    }),
    execute: async ({ title, markdown, channel_id }) => {
      const targetChannelId = channel_id ?? context.channelId;
      const operationKey = createOperationKey("slack_canvas_create", {
        title,
        markdown,
        channel_id: targetChannelId ?? null
      });
      const cached = state.getOperationResult<{
        ok: true;
        canvas_id: string;
        permalink: string;
        summary: string;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true
        };
      }

      try {
        const created = await createCanvas({
          title,
          markdown,
          channelId: targetChannelId
        });
        state.patchArtifactState({ lastCanvasId: created.canvasId, lastCanvasUrl: created.permalink });

        const response = {
          ok: true,
          canvas_id: created.canvasId,
          permalink: created.permalink,
          summary: `Created canvas ${created.canvasId}`
        };
        state.setOperationResult(operationKey, response);
        return response;
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "canvas create failed");
      }
    }
  });
}
