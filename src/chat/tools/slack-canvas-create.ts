import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { createCanvas } from "@/chat/slack-actions/canvases";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

export function createSlackCanvasCreateTool(
  context: ToolRuntimeContext,
  state: ToolState
) {
  return tool({
    description: "Create a Slack canvas for long-form output in the current channel.",
    inputSchema: Type.Object({
      title: Type.String({
        minLength: 1,
        maxLength: 160,
        description: "Canvas title."
      }),
      markdown: Type.String({
        minLength: 1,
        description: "Canvas markdown body content."
      }),
      channel_id: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Optional Slack channel ID. Defaults to the current thread channel."
        })
      )
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
    }
  });
}
