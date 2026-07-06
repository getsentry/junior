import {
  normalizeToLf,
  positiveInteger,
} from "@/chat/tools/sandbox/file-utils";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";

const DEFAULT_READ_LIMIT = 1000;

interface TextRangeResult {
  content: string;
  end_line?: number;
  path: string;
  start_line: number;
  success: true;
  total_lines: number;
  truncated: boolean;
  continuation?: string;
}

interface TextRangeMissingPathResult {
  content: "";
  error: "not_found";
  path: string;
  success: false;
}

/** Return a bounded line window so large files can be read incrementally. */
export function sliceFileContent(params: {
  content: string;
  limit?: unknown;
  offset?: unknown;
  path: string;
}): TextRangeResult {
  const normalized = normalizeToLf(params.content);
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  const requestedOffset = positiveInteger(params.offset);
  const requestedLimit = positiveInteger(params.limit);
  const startLine = requestedOffset ?? 1;
  const maxLines = requestedLimit ?? DEFAULT_READ_LIMIT;
  const startIndex = Math.min(lines.length, startLine - 1);
  const selected = lines.slice(startIndex, startIndex + maxLines);
  const endLine =
    selected.length > 0 ? startLine + selected.length - 1 : startLine - 1;
  const truncated = startIndex > 0 || endLine < lines.length;
  const rangeRequested =
    requestedOffset !== undefined || requestedLimit !== undefined;

  return {
    content:
      !rangeRequested && !truncated ? params.content : selected.join("\n"),
    end_line: selected.length > 0 ? endLine : undefined,
    path: params.path,
    start_line: startLine,
    success: true,
    total_lines: lines.length,
    truncated,
    ...(endLine < lines.length
      ? {
          continuation: `Read more with offset=${endLine + 1} and limit=${maxLines}.`,
        }
      : {}),
  };
}

/** Return a model-visible result for expected missing read targets. */
export function missingFileResult(path: string): TextRangeMissingPathResult {
  return {
    content: "",
    error: "not_found",
    path,
    success: false,
  };
}

/** Create the sandbox read tool definition exposed to the agent. */
export function createReadFileTool() {
  return zodTool({
    description:
      "Read a bounded line range from a file in the sandbox workspace. Use when you need exact file contents to verify facts or make edits safely. Prefer grep/findFiles/listDir for broad discovery.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .describe("Path to the file in the sandbox workspace."),
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
    execute: async () => {
      throw new Error(
        "readFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
