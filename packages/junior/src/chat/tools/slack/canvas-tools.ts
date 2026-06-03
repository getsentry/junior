import { tool } from "@/chat/tools/definition";
import { Type } from "@sinclair/typebox";
import {
  createCanvas,
  extractCanvasId,
  normalizeCanvasMarkdown,
  readCanvas,
  writeCanvasMarkdown,
} from "@/chat/tools/slack/canvases";
import { isConversationScopedChannel } from "@/chat/slack/client";
import { createOperationKey } from "@/chat/tools/idempotency";
import { logError, logWarn } from "@/chat/logging";
import { sliceFileContent } from "@/chat/tools/sandbox/read-file";
import { normalizeToLf } from "@/chat/tools/sandbox/file-utils";
import {
  buildCompactDiff,
  prepareTextReplacementArguments,
  validateAndApplyTextEdits,
  type TextReplacement,
} from "@/chat/tools/sandbox/text-edits";
import type { CanvasArtifactSummary } from "@/chat/state/artifacts";
import type { ToolRuntimeContext, ToolState } from "@/chat/tools/types";

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

function prepareCanvasEditArguments(input: unknown): {
  canvas: string;
  edits: TextReplacement[];
} {
  return prepareTextReplacementArguments(input);
}

function storedCanvasUrl(
  state: ToolState,
  canvasId: string,
): string | undefined {
  const lastCanvasUrl = state.artifactState.lastCanvasUrl;
  if (lastCanvasUrl && extractCanvasId(lastCanvasUrl) === canvasId) {
    return lastCanvasUrl;
  }
  for (const canvas of state.artifactState.recentCanvases ?? []) {
    if (extractCanvasId(canvas.id) === canvasId) {
      return canvas.url;
    }
    if (canvas.url && extractCanvasId(canvas.url) === canvasId) {
      return canvas.url;
    }
  }
  return undefined;
}

function resolveCanvasTarget(
  canvas: string,
): { ok: true; canvasId: string } | { ok: false; error: string } {
  const canvasId = extractCanvasId(canvas);
  if (!canvasId) {
    return {
      ok: false,
      error:
        "Could not parse a Slack canvas/file ID from input. Provide an F-prefixed ID or a Slack canvas/docs URL.",
    };
  }
  return { ok: true, canvasId };
}

const editReplacementSchema = Type.Object(
  {
    oldText: Type.String({
      minLength: 1,
      description:
        "Exact Canvas markdown to replace. It must be unique in the current Canvas body and must not overlap another edit.",
    }),
    newText: Type.String({
      description: "Replacement Canvas markdown for this edit.",
    }),
  },
  { additionalProperties: false },
);

/** Create a tool that provisions a new Slack canvas in the active channel. */
export function createSlackCanvasCreateTool(
  context: ToolRuntimeContext,
  state: ToolState,
) {
  return tool({
    description:
      "Create a Slack canvas for long-form output in the active assistant context channel. Use when the answer is better as a reusable document than a thread reply: long-form research, timelines, bios/profiles, structured notes, plans, comparisons, or anything likely to exceed one compact Slack reply. After creating it, reply with one or two short sentences plus the canvas link; do not recap the canvas contents. Do not use for short answers that fit cleanly in one normal thread reply.",
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

/**
 * Create a tool that reads a Slack canvas the bot has access to. Accepts
 * either a canvas/file ID (`F...`) or a Slack canvas/docs URL and returns the
 * canvas body downloaded via the bot's file access.
 */
export function createSlackCanvasReadTool() {
  return tool({
    description:
      "Read a bounded line range from a Slack canvas as markdown. Use when you need exact Canvas contents to verify facts or make edits safely. Do not use for generic web pages — use webFetch for those.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object(
      {
        canvas: Type.String({
          minLength: 1,
          description:
            "Canvas/file ID (e.g. `F0ABCDEF`) or Slack canvas/docs URL (e.g. `https://team.slack.com/docs/T.../F...`).",
        }),
        offset: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "1-indexed line number to start reading from.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Maximum number of lines to read. Defaults to 1000.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async ({ canvas, offset, limit }) => {
      const target = resolveCanvasTarget(canvas);
      if (!target.ok) {
        return target;
      }

      try {
        const result = await readCanvas(target.canvasId);
        const range = sliceFileContent({
          content: normalizeToLf(result.content),
          limit,
          offset,
          path: result.canvasId,
        });

        return {
          ok: true,
          canvas_id: result.canvasId,
          title: result.title,
          permalink: result.permalink,
          mimetype: result.mimetype,
          filetype: result.filetype,
          original_byte_length: result.byteLength,
          content: range.content,
          start_line: range.start_line,
          end_line: range.end_line,
          total_lines: range.total_lines,
          truncated: range.truncated,
          continuation: range.continuation,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "canvas read failed";
        logWarn(
          "slack_canvas_read_failed",
          {},
          {
            "gen_ai.tool.name": "slackCanvasRead",
            "app.slack.canvas.canvas_id_prefix": target.canvasId.slice(0, 1),
          },
          message,
        );
        return {
          ok: false,
          canvas_id: target.canvasId,
          error: message,
        };
      }
    },
  });
}

/** Create a tool that edits a Slack canvas like a markdown file. */
export function createSlackCanvasEditTool(state: ToolState) {
  return tool({
    description:
      "Edit one Slack canvas with exact markdown replacements. Use for precise changes to existing Canvas content; prefer this over slackCanvasWrite for targeted changes. Each oldText must match exactly, be unique, and not overlap another edit. Returns a diff. Multiple changes to the same canvas: use one edits[] call.",
    prepareArguments: prepareCanvasEditArguments,
    executionMode: "sequential",
    inputSchema: Type.Object(
      {
        canvas: Type.String({
          minLength: 1,
          description:
            "Canvas/file ID (e.g. `F0ABCDEF`) or Slack canvas/docs URL.",
        }),
        edits: Type.Array(editReplacementSchema, {
          minItems: 1,
          description:
            "Exact replacements matched against the current Canvas body, not incrementally.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async ({ canvas, edits }) => {
      const target = resolveCanvasTarget(canvas);
      if (!target.ok) {
        return target;
      }

      const operationKey = createOperationKey("slackCanvasEdit", {
        canvas_id: target.canvasId,
        edits,
      });
      const cached = state.getOperationResult<{
        ok: true;
        canvas_id: string;
        diff: string;
        first_changed_line?: number;
        replacements: number;
      }>(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true,
        };
      }

      try {
        const current = await readCanvas(target.canvasId);
        const normalizedContent = normalizeToLf(current.content);
        const { baseContent, newContent } = validateAndApplyTextEdits(
          normalizedContent,
          edits,
          target.canvasId,
        );
        const written = await writeCanvasMarkdown({
          canvasId: target.canvasId,
          markdown: newContent,
        });
        await state.patchArtifactState({
          lastCanvasId: target.canvasId,
          lastCanvasUrl: current.permalink ?? state.artifactState.lastCanvasUrl,
        });

        const diff = buildCompactDiff(
          normalizeCanvasMarkdown(baseContent).markdown,
          written.markdown,
        );
        const response = {
          ok: true,
          canvas_id: target.canvasId,
          title: current.title,
          permalink: current.permalink,
          diff: diff.diff,
          first_changed_line: diff.firstChangedLine,
          replacements: edits.length,
          normalized_heading_count: written.normalizedHeadingCount,
          summary: `Edited canvas ${target.canvasId}`,
        };
        state.setOperationResult(operationKey, response);
        return response;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "canvas edit failed";
        logWarn(
          "slack_canvas_edit_failed",
          {},
          {
            "gen_ai.tool.name": "slackCanvasEdit",
            "app.slack.canvas.canvas_id_prefix": target.canvasId.slice(0, 1),
          },
          message,
        );
        return {
          ok: false,
          canvas_id: target.canvasId,
          error: message,
        };
      }
    },
  });
}

/** Create a tool that deliberately replaces a Slack canvas body. */
export function createSlackCanvasWriteTool(state: ToolState) {
  return tool({
    description:
      "Write UTF-8 markdown content to a Slack canvas. Use for deliberate full-Canvas replacement after validation; use slackCanvasEdit for targeted changes to existing canvas content.",
    executionMode: "sequential",
    inputSchema: Type.Object(
      {
        canvas: Type.String({
          minLength: 1,
          description:
            "Canvas/file ID (e.g. `F0ABCDEF`) or Slack canvas/docs URL.",
        }),
        content: Type.String({
          description: "UTF-8 markdown content to write.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async ({ canvas, content }) => {
      const target = resolveCanvasTarget(canvas);
      if (!target.ok) {
        return target;
      }

      const operationKey = createOperationKey("slackCanvasWrite", {
        canvas_id: target.canvasId,
        content,
      });
      const cached = state.getOperationResult<{
        ok: true;
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
          canvas_id: target.canvasId,
          error: message,
        };
      }
    },
  });
}
