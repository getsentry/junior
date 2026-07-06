import { logError } from "@/chat/logging";
import { isConversationScopedChannel } from "@/chat/slack/client";
import { createCanvas } from "@/chat/slack/tools/canvas/api";
import { mergeRecentCanvases } from "@/chat/slack/tools/canvas/context";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import { z } from "zod";
import { zodTool } from "@/chat/tools/definition";
import { createOperationKey } from "@/chat/tools/idempotency";
import type { ToolState } from "@/chat/tools/types";

/** Create a tool that provisions a new Slack canvas in the active channel. */
export function createSlackCanvasCreateTool(
  context: SlackToolContext,
  state: ToolState,
) {
  return zodTool({
    description:
      "Create a Slack canvas for long-form output in the active assistant context channel. Use when the answer is better as a reusable document than a thread reply: long-form research, timelines, bios/profiles, structured notes, plans, comparisons, or anything likely to exceed one compact Slack reply. After creating it, reply with one or two short sentences plus the canvas link; do not recap the canvas contents. Do not use for short answers that fit cleanly in one normal thread reply.",
    inputSchema: z.object({
      title: z.string().min(1).max(160).describe("Canvas title."),
      markdown: z.string().min(1).describe("Canvas markdown body content."),
    }),
    execute: async ({ title, markdown }) => {
      const targetChannelId = context.destinationChannelId;
      if (!isConversationScopedChannel(targetChannelId)) {
        logError(
          "slack_canvas_create_invalid_context",
          {},
          {
            "gen_ai.tool.name": "slackCanvasCreate",
            "messaging.destination.name": targetChannelId ?? "none",
            "app.slack.canvas.has_channel_context": Boolean(targetChannelId),
          },
          "Canvas create failed due to missing or invalid assistant channel context",
        );
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
        ok: true;
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
      await state.patchArtifactState({
        lastCanvasId: created.canvasId,
        lastCanvasUrl: created.permalink,
        recentCanvases: mergeRecentCanvases(
          state.artifactState.recentCanvases,
          {
            id: created.canvasId,
            title,
            url: created.permalink,
          },
        ),
      });

      const response = {
        ok: true,
        canvas_id: created.canvasId,
        permalink: created.permalink,
        summary: `Created canvas ${created.canvasId}`,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
