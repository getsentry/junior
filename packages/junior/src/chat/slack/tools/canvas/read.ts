import { readCanvas } from "@/chat/slack/tool-support/canvas/api";
import {
  resolveCanvasTarget,
  slackCanvasRefParam,
} from "@/chat/slack/tool-support/canvas/context";
import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { normalizeToLf } from "@/chat/tools/sandbox/file-utils";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { SLACK_TOOL_SOURCE } from "@/chat/slack/tool-support/tool-source";

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

/** Pick the requested lines. With no range, keep the whole canvas. */
function canvasLines(content: string, offset?: number, limit?: number) {
  const lines = content.length === 0 ? [] : content.split("\n");
  const startLine = offset ?? 1;
  const selected = lines.slice(
    startLine - 1,
    limit === undefined ? undefined : startLine - 1 + limit,
  );
  return {
    content: selected.join("\n"),
    startLine,
    endLine: startLine - 1 + selected.length,
    totalLines: lines.length,
  };
}

/**
 * Create a tool that reads a Slack canvas the bot has access to. Accepts
 * either a canvas/file ID (`F...`) or a Slack canvas/docs URL and returns the
 * canvas body downloaded via the bot's file access.
 *
 * Each read downloads the whole canvas, so the default returns all of it.
 * The tool pipeline cuts a long canvas for the model and saves the full text
 * to a Sandbox file.
 */
export function createSlackCanvasReadTool() {
  return zodTool({
    exposure: "deferred",
    source: SLACK_TOOL_SOURCE,
    description:
      "Read a Slack canvas as markdown. Returns the whole canvas unless you set offset or limit.",
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
        .describe("Maximum number of lines to read. Defaults to all lines.")
        .optional(),
    }),
    outputSchema: slackCanvasReadOutputSchema,
    execute: async ({ canvas, offset, limit }) => {
      const target = resolveCanvasTarget(canvas);
      if (!target.ok) {
        throw new ToolInputError(target.error);
      }

      const result = await readCanvas(target.canvasId);
      const range = canvasLines(normalizeToLf(result.content), offset, limit);

      return {
        canvas_id: result.canvasId,
        title: result.title,
        permalink: result.permalink,
        mimetype: result.mimetype,
        filetype: result.filetype,
        original_byte_length: result.byteLength,
        content: range.content,
        start_line: range.startLine,
        end_line: range.endLine,
        total_lines: range.totalLines,
        truncated: range.startLine > 1 || range.endLine < range.totalLines,
        ...(range.endLine < range.totalLines
          ? {
              continuation: {
                arguments: {
                  canvas: result.canvasId,
                  offset: range.endLine + 1,
                  ...(limit === undefined ? undefined : { limit }),
                },
                reason: "canvas has more lines",
              },
            }
          : undefined),
      };
    },
  });
}
