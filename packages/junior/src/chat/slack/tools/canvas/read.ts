import { readCanvas } from "@/chat/slack/tool-support/canvas/api";
import {
  resolveCanvasTarget,
  slackCanvasRefParam,
} from "@/chat/slack/tool-support/canvas/context";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { normalizeToLf } from "@/chat/tools/sandbox/file-utils";
import { sliceFileContent } from "@/chat/tool-support/text-range-result";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const slackCanvasReadOutputSchema = juniorToolOutputSchema
  .extend({
    canvas_id: z.string().optional(),
    title: z.string().optional(),
    permalink: z.string().optional(),
    mimetype: z.string().optional(),
    filetype: z.string().optional(),
    original_byte_length: z.number().int().nonnegative().optional(),
    content: z.string().optional(),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().nonnegative().optional(),
    total_lines: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Create a tool that reads a Slack canvas the bot has access to. Accepts
 * either a canvas/file ID (`F...`) or a Slack canvas/docs URL and returns the
 * canvas body downloaded via the bot's file access.
 */
export function createSlackCanvasReadTool() {
  return zodTool({
    description:
      "Read a bounded line range from a Slack canvas as markdown. Use when you need exact Canvas contents to verify facts or make edits safely. Do not use for generic web pages — use webFetch for those.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    inputSchema: z.object({
      canvas: slackCanvasRefParam,
      offset: z.coerce
        .number()
        .int()
        .min(1)
        .describe("1-indexed line number to start reading from.")
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .describe("Maximum number of lines to read. Defaults to 1000.")
        .optional(),
    }),
    outputSchema: slackCanvasReadOutputSchema,
    execute: async ({ canvas, offset, limit }) => {
      const target = resolveCanvasTarget(canvas);
      if (!target.ok) {
        throw new ToolInputError(target.error);
      }

      const result = await readCanvas(target.canvasId);
      const range = sliceFileContent({
        content: normalizeToLf(result.content),
        continuationArgumentName: "canvas",
        limit,
        offset,
        path: result.canvasId,
      });
      const rangeData = range.details;

      return {
        canvas_id: result.canvasId,
        title: result.title,
        permalink: result.permalink,
        mimetype: result.mimetype,
        filetype: result.filetype,
        original_byte_length: result.byteLength,
        content: rangeData.content,
        start_line: rangeData.start_line,
        end_line: rangeData.end_line,
        total_lines: rangeData.total_lines,
        truncated: range.details.truncated,
        continuation: range.details.continuation,
      };
    },
  });
}
