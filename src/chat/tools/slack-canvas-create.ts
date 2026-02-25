import { tool } from "ai";
import { z } from "zod";
import { createCanvas } from "@/chat/slack-actions/canvases";
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
      try {
        const created = await createCanvas({
          title,
          markdown,
          channelId: channel_id ?? context.channelId
        });
        state.patchArtifactState({ lastCanvasId: created.canvasId, lastCanvasUrl: created.permalink });

        return {
          ok: true,
          canvas_id: created.canvasId,
          permalink: created.permalink,
          summary: `Created canvas ${created.canvasId}`
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "canvas create failed"
        };
      }
    }
  });
}
