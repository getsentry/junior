import {
  normalizeToLf,
  positiveInteger,
} from "@/chat/tools/sandbox/file-utils";
import {
  juniorToolResultEnvelopeSchema,
  makeStructuredToolResult,
} from "@/chat/tool-support/structured-result";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";

const DEFAULT_READ_LIMIT = 1000;

interface TextRangeResult {
  content: [{ type: "text"; text: string }];
  details: {
    ok: true;
    status: "success";
    target: string;
    data: {
      content: string;
      end_line?: number;
      path: string;
      start_line: number;
      total_lines: number;
    };
    truncated: boolean;
    continuation?: {
      tool_name: "readFile";
      arguments: {
        path: string;
        offset: number;
        limit: number;
      };
      reason: string;
    };
  };
}

interface TextRangeMissingPathResult {
  content: [{ type: "text"; text: string }];
  details: {
    ok: false;
    status: "error";
    target: string;
    data: {
      content: "";
      path: string;
    };
    error: {
      kind: "not_found";
      message: string;
    };
    truncated: false;
  };
}

interface LegacyTextRangeResult {
  content: string;
  end_line?: number;
  path: string;
  start_line: number;
  total_lines: number;
  truncated: boolean;
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
  const returnedContent =
    !rangeRequested && !truncated ? params.content : selected.join("\n");
  const range: LegacyTextRangeResult = {
    content: returnedContent,
    end_line: selected.length > 0 ? endLine : undefined,
    path: params.path,
    start_line: startLine,
    total_lines: lines.length,
    truncated,
  };

  return makeStructuredToolResult({
    ok: true,
    status: "success",
    target: params.path,
    data: range,
    truncated,
    ...(endLine < lines.length
      ? {
          continuation: {
            tool_name: "readFile" as const,
            arguments: {
              path: params.path,
              offset: endLine + 1,
              limit: maxLines,
            },
            reason: "file has more lines",
          },
        }
      : {}),
  });
}

/** Return a model-visible result for expected missing read targets. */
export function missingFileResult(path: string): TextRangeMissingPathResult {
  return makeStructuredToolResult({
    ok: false,
    status: "error",
    target: path,
    data: {
      content: "",
      path,
    },
    error: {
      kind: "not_found",
      message: `File not found: ${path}`,
    },
    truncated: false,
  });
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
    outputSchema: juniorToolResultEnvelopeSchema,
    execute: async () => {
      throw new Error(
        "readFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
