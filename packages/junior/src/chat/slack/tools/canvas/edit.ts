import { readCanvas, writeCanvasMarkdown } from "@/chat/slack/tool-support/canvas/api";
import {
  resolveCanvasTarget,
  slackCanvasRefParam,
} from "@/chat/slack/tool-support/canvas/context";
import { normalizeCanvasMarkdown } from "@/chat/slack/tool-support/canvas/markdown";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { createOperationKey } from "@/chat/tools/idempotency";
import { normalizeToLf } from "@/chat/tools/sandbox/file-utils";
import {
  buildCompactDiff,
  prepareTextReplacementArguments,
  validateAndApplyTextEdits,
  type TextReplacement,
} from "@/chat/tools/sandbox/text-edits";
import type { ToolState } from "@/chat/tools/types";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

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

const slackCanvasEditOutputSchema = juniorToolOutputSchema
  .extend({
    canvas_id: z.string().optional(),
    title: z.string().optional(),
    permalink: z.string().optional(),
    diff: z.string().optional(),
    first_changed_line: z.number().int().positive().optional(),
    replacements: z.number().int().nonnegative().optional(),
    normalized_heading_count: z.number().int().nonnegative().optional(),
    summary: z.string().optional(),
    deduplicated: z.boolean().optional(),
  })
  .strict();

/** Create a tool that edits a Slack canvas like a markdown file. */
export function createSlackCanvasEditTool(state: ToolState) {
  return zodTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Edit a Slack canvas with exact markdown replacements. Returns a diff.",
    prepareArguments: prepareCanvasEditArguments,
    executionMode: "sequential",
    inputSchema: z.object({
      canvas: slackCanvasRefParam,
      edits: z
        .array(editReplacementSchema)
        .min(1)
        .describe(
          "Exact replacements matched against the current Canvas body, not incrementally.",
        ),
    }),
    outputSchema: slackCanvasEditOutputSchema,
    execute: async ({ canvas, edits }) => {
      const target = resolveCanvasTarget(canvas);
      if (!target.ok) {
        throw new ToolInputError(target.error);
      }

      const operationKey = createOperationKey("slackCanvasEdit", {
        canvas_id: target.canvasId,
        edits,
      });
      const cached = state.getOperationResult<{
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
      const diff = buildCompactDiff(
        normalizeCanvasMarkdown(baseContent).markdown,
        written.markdown,
      );
      const response = {
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
    },
  });
}
