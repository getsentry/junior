import { logError } from "@/chat/logging";
import { isConversationScopedChannel } from "@/chat/slack/client";
import { createCanvas } from "@/chat/slack/tool-support/canvas/api";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

/** Create a tool that provisions a new Slack canvas in the active channel. */
export function createSlackCanvasCreateTool(
  context: SlackToolContext,
  state: ToolState,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Create a Slack canvas for long-form output in the active assistant context channel. Use when the answer is better as a reusable document than a thread reply: long-form research, timelines, bios/profiles, structured notes, plans, comparisons, or anything likely to exceed one compact Slack reply. After creating it, reply with one or two short sentences plus the canvas link; do not recap the canvas contents. Do not use for short answers that fit cleanly in one normal thread reply.",
    inputSchema: z.object({
      title: z.string().min(1).max(160).describe("Canvas title."),
      markdown: z.string().min(1).describe("Canvas markdown body content."),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ title, markdown }) => {
      const targetChannelId = context.destinationChannelId;
      if (!isConversationScopedChannel(targetChannelId)) {
        logError("slack.canvas.create.context_invalid", {
          "gen_ai.tool.name": "slackCanvasCreate",
          "messaging.destination.name": targetChannelId ?? "none",
          "app.slack.canvas.has_channel_context": Boolean(targetChannelId),
        });
        throw new Error(
          "Cannot create a canvas without an active assistant channel context (C/G/D).",
        );
      }
      const operationKey = createOperationKey("slackCanvasCreate", {
        title,
        markdown,
        channel_id: targetChannelId ?? null,
      });
      const cached = state.getOperationResult<{
        canvas_id: string;
        permalink: string;
        summary: string;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true,
        };
      }

      const created = await createCanvas({
        title,
        markdown,
        channelId: targetChannelId,
      });
      const response = {
        canvas_id: created.canvasId,
        permalink: created.permalink,
        summary: `Created canvas ${created.canvasId}`,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
