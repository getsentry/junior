import { logWarn } from "@/chat/logging";
import {
  normalizeCanvasMarkdown,
  readCanvas,
  writeCanvasMarkdown,
} from "@/chat/slack/tools/canvas/api";
import { resolveCanvasTarget } from "@/chat/slack/tools/canvas/context";
import { z } from "zod";
import { zodTool } from "@/chat/tools/definition";
import { createOperationKey } from "@/chat/tools/idempotency";
import { normalizeToLf } from "@/chat/tools/sandbox/file-utils";
import {
  buildCompactDiff,
  prepareTextReplacementArguments,
  validateAndApplyTextEdits,
  type TextReplacement,
} from "@/chat/tools/sandbox/text-edits";
import type { ToolState } from "@/chat/tools/types";

function prepareCanvasEditArguments(input: unknown): {
  canvas: string;
  edits: TextReplacement[];
} {
  return prepareTextReplacementArguments(input);
}

const editReplacementSchema = z.object({
  oldText: z
    .string()
    .min(1)
    .describe(
      "Exact Canvas markdown to replace. It must be unique in the current Canvas body and must not overlap another edit.",
    ),
  newText: z.string().describe("Replacement Canvas markdown for this edit."),
});

/** Create a tool that edits a Slack canvas like a markdown file. */
export function createSlackCanvasEditTool(state: ToolState) {
  return zodTool({
    description:
      "Edit one Slack canvas with exact markdown replacements. Use for precise changes to existing Canvas content; prefer this over slackCanvasWrite for targeted changes. Each oldText must match exactly, be unique, and not overlap another edit. Returns a diff. Multiple changes to the same canvas: use one edits[] call.",
    prepareArguments: prepareCanvasEditArguments,
    executionMode: "sequential",
    inputSchema: z.object({
      canvas: z
        .string()
        .min(1)
        .describe("Canvas/file ID (e.g. `F0ABCDEF`) or Slack canvas/docs URL."),
      edits: z
        .array(editReplacementSchema)
        .min(1)
        .describe(
          "Exact replacements matched against the current Canvas body, not incrementally.",
        ),
    }),
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
