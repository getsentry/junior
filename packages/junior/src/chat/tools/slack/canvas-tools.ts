import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import {
  createCanvas,
  extractCanvasId,
  lookupCanvasSection,
  readCanvas,
  updateCanvas,
} from "@/chat/tools/slack/canvases";
import { isConversationScopedChannel } from "@/chat/slack/client";
import { createOperationKey } from "@/chat/tools/idempotency";
import { logError, logWarn } from "@/chat/logging";
import type { CanvasArtifactSummary } from "@/chat/state/artifacts";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

const MAX_CANVAS_READ_CHARS = 40_000;

const MAX_RECENT_CANVASES = 5;

function mergeRecentCanvases(
  existing: CanvasArtifactSummary[] | undefined,
  created: { id: string; title: string; url?: string },
): CanvasArtifactSummary[] {
  const nextEntry: CanvasArtifactSummary = {
    id: created.id,
    title: created.title,
    url: created.url,
    createdAt: new Date().toISOString(),
  };
  const prior = existing ?? [];
  const deduped = prior.filter((entry) => entry.id !== created.id);
  return [nextEntry, ...deduped].slice(0, MAX_RECENT_CANVASES);
}

/** Create a tool that provisions a new Slack canvas in the active channel. */
export function createSlackCanvasCreateTool(
  context: ToolRuntimeContext,
  state: ToolState,
) {
  return tool({
    description:
      "Create a Slack canvas for long-form output in the active assistant context channel. Use when the answer is better as a reusable document than a thread reply: long-form research, timelines, bios/profiles, structured notes, plans, comparisons, or anything likely to exceed one compact Slack reply. After creating it, keep the thread reply brief and include the canvas link. Do not use for short answers that fit cleanly in one normal thread reply.",
    inputSchema: Type.Object({
      title: Type.String({
        minLength: 1,
        maxLength: 160,
        description: "Canvas title.",
      }),
      markdown: Type.String({
        minLength: 1,
        description: "Canvas markdown body content.",
      }),
    }),
    execute: async ({ title, markdown }) => {
      const targetChannelId = context.channelId;
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
      state.setTurnCreatedCanvasId(created.canvasId);
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

/** Create a tool that updates the active Slack canvas. */
export function createSlackCanvasUpdateTool(
  state: ToolState,
  _context: ToolRuntimeContext,
) {
  return tool({
    description:
      "Update the active Slack canvas tracked in artifact context. Use when continuing or correcting a document already tracked in this thread. Do not use to create a brand-new long-form artifact.",
    inputSchema: Type.Object({
      markdown: Type.String({
        minLength: 1,
        description: "Markdown content to insert or use as replacement text.",
      }),
      operation: Type.Optional(
        Type.Union(
          [
            Type.Literal("insert_at_end"),
            Type.Literal("insert_at_start"),
            Type.Literal("replace"),
          ],
          { description: "Canvas update mode." },
        ),
      ),
      section_id: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Optional section ID required for targeted replace operations.",
        }),
      ),
      section_contains_text: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Optional helper text used to find the target section when section_id is not provided.",
        }),
      ),
    }),
    execute: async ({
      markdown,
      operation,
      section_id,
      section_contains_text,
    }) => {
      const targetCanvasId =
        state.getTurnCreatedCanvasId() ?? state.getCurrentCanvasId();
      const resolvedOperation = operation ?? "insert_at_end";
      if (!targetCanvasId) {
        logWarn(
          "slack_canvas_update_missing_target",
          {},
          {
            "gen_ai.tool.name": "slackCanvasUpdate",
            "app.artifacts.last_canvas_id":
              state.artifactState.lastCanvasId ?? "none",
            "app.artifacts.turn_created_canvas_id":
              state.getTurnCreatedCanvasId() ?? "none",
          },
          "Canvas update rejected because no explicit target canvas was provided",
        );
        return {
          ok: false,
          error: "No active canvas found in artifact context",
        };
      }
      const operationKey = createOperationKey("slackCanvasUpdate", {
        canvas_id: targetCanvasId,
        markdown,
        operation: resolvedOperation,
        section_id: section_id ?? null,
        section_contains_text: section_contains_text ?? null,
      });
      const cached = state.getOperationResult<{
        ok: true;
        canvas_id: string;
        operation: "insert_at_end" | "insert_at_start" | "replace";
        section_id?: string;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true,
        };
      }

      const sectionId =
        section_id ??
        (section_contains_text
          ? await lookupCanvasSection(targetCanvasId, section_contains_text)
          : undefined);

      await updateCanvas({
        canvasId: targetCanvasId,
        markdown,
        operation: resolvedOperation,
        sectionId,
      });
      await state.patchArtifactState({ lastCanvasId: targetCanvasId });

      const response = {
        ok: true,
        canvas_id: targetCanvasId,
        operation: resolvedOperation,
        section_id: sectionId,
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}

/**
 * Create a tool that reads a Slack canvas the bot has access to. Accepts
 * either a canvas/file ID (`F...`) or a Slack canvas/docs URL and returns the
 * canvas body downloaded via the bot's file access.
 */
export function createSlackCanvasReadTool() {
  return tool({
    description:
      "Read a Slack canvas the bot has access to (including canvases the bot created) by canvas ID or Slack canvas/docs URL. Use when the user shares a Slack canvas link (https://*.slack.com/docs/... or /canvas/...) or references a canvas ID and you need its contents. Do not use for generic web pages — use webFetch for those.",
    inputSchema: Type.Object({
      canvas: Type.String({
        minLength: 1,
        description:
          "Canvas/file ID (e.g. `F0ABCDEF`) or Slack canvas/docs URL (e.g. `https://team.slack.com/docs/T.../F...`).",
      }),
    }),
    execute: async ({ canvas }) => {
      const canvasId = extractCanvasId(canvas);
      if (!canvasId) {
        return {
          ok: false,
          error:
            "Could not parse a Slack canvas/file ID from input. Provide an F-prefixed ID or a Slack canvas/docs URL.",
        };
      }

      try {
        const result = await readCanvas(canvas);
        const truncated = result.content.length > MAX_CANVAS_READ_CHARS;
        const content = truncated
          ? result.content.slice(0, MAX_CANVAS_READ_CHARS)
          : result.content;

        return {
          ok: true,
          canvas_id: result.canvasId,
          title: result.title,
          permalink: result.permalink,
          mimetype: result.mimetype,
          filetype: result.filetype,
          original_byte_length: result.byteLength,
          truncated,
          content,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "canvas read failed";
        logWarn(
          "slack_canvas_read_failed",
          {},
          {
            "gen_ai.tool.name": "slackCanvasRead",
            "app.slack.canvas.canvas_id_prefix": canvasId.slice(0, 1),
          },
          message,
        );
        return {
          ok: false,
          canvas_id: canvasId,
          error: message,
        };
      }
    },
  });
}
