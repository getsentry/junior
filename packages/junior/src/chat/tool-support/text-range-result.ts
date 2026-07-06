import { makeStructuredToolResult } from "@/chat/tool-support/structured-result";

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
      arguments: {
        offset: number;
        limit: number;
        [key: string]: string | number;
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

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function normalizeToLf(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Return a bounded line window so large files can be read incrementally. */
export function sliceFileContent(params: {
  content: string;
  continuationArgumentName?: string;
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
            arguments: {
              [params.continuationArgumentName ?? "path"]: params.path,
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
