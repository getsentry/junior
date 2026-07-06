import { logWarn } from "@/chat/logging";
import { readCanvas } from "@/chat/slack/tools/canvas/api";
import { resolveCanvasTarget } from "@/chat/slack/tools/canvas/context";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { normalizeToLf } from "@/chat/tools/sandbox/file-utils";
import { sliceFileContent } from "@/chat/tools/sandbox/read-file";

/**
 * Create a tool that reads a Slack canvas the bot has access to. Accepts
 * either a canvas/file ID (`F...`) or a Slack canvas/docs URL and returns the
 * canvas body downloaded via the bot's file access.
 */
export function createSlackCanvasReadTool() {
  return zodTool({
    description:
      "Read a bounded line range from a Slack canvas as markdown. Use when you need exact Canvas contents to verify facts or make edits safely. Do not use for generic web pages — use webFetch for those.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({
      canvas: z
        .string()
        .min(1)
        .describe(
          "Canvas/file ID (e.g. `F0ABCDEF`) or Slack canvas/docs URL (e.g. `https://team.slack.com/docs/T.../F...`).",
        ),
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
