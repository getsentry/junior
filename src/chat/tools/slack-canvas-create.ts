import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import { createCanvas } from "@/chat/slack-actions/canvases";
import { isCanvasChannel } from "@/chat/slack-actions/client";
import { createOperationKey } from "@/chat/tools/idempotency";
import { logError } from "@/chat/observability";
import type { CanvasArtifactSummary } from "@/chat/slack-actions/types";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

const MAX_RECENT_CANVASES = 5;

function mergeRecentCanvases(
  existing: CanvasArtifactSummary[] | undefined,
  created: { id: string; title: string; url?: string }
): CanvasArtifactSummary[] {
  const nextEntry: CanvasArtifactSummary = {
    id: created.id,
    title: created.title,
    url: created.url,
    createdAt: new Date().toISOString()
  };
  const prior = existing ?? [];
  const deduped = prior.filter((entry) => entry.id !== created.id);
  return [nextEntry, ...deduped].slice(0, MAX_RECENT_CANVASES);
}

export function createSlackCanvasCreateTool(
  context: ToolRuntimeContext,
  state: ToolState
) {
  return tool({
    description:
      "Create a Slack canvas for long-form output in the active assistant context channel. Use when content is too long for a thread reply or needs a persistent document. Do not use for short answers that fit in-thread.",
    inputSchema: Type.Object({
      title: Type.String({
        minLength: 1,
        maxLength: 160,
        description: "Canvas title."
      }),
      markdown: Type.String({
        minLength: 1,
        description: "Canvas markdown body content."
      })
    }),
    execute: async ({ title, markdown }) => {
      const targetChannelId = context.channelId;
      if (!isCanvasChannel(targetChannelId)) {
        logError(
          "slack_canvas_create_invalid_context",
          {},
          {
            "gen_ai.tool.name": "slackCanvasCreate",
            "messaging.destination.name": targetChannelId ?? "none",
            "app.slack.canvas.has_channel_context": Boolean(targetChannelId)
          },
          "Canvas create failed due to missing or invalid assistant channel context"
        );
        throw new Error(
          "Cannot create a canvas without an active assistant channel context (C/G/D)."
        );
      }
      const operationKey = createOperationKey("slackCanvasCreate", {
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
      state.setTurnCreatedCanvasId(created.canvasId);
      state.patchArtifactState({
        lastCanvasId: created.canvasId,
        lastCanvasUrl: created.permalink,
        recentCanvases: mergeRecentCanvases(state.artifactState.recentCanvases, {
          id: created.canvasId,
          title,
          url: created.permalink
        })
      });

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
