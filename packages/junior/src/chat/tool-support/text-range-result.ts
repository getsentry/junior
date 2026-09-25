import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const DEFAULT_READ_LIMIT = 1000;
const MAX_READ_CHARS = 60_000;

interface TextRangeResult {
  content: [{ type: "text"; text: string }];
  details: {
    target: string;
    content: string;
    end_line?: number;
    path: string;
    start_line: number;
    total_lines: number;
    truncation_reasons?: string[];
    truncated: boolean;
    character_limit_reached?: number;
    line_truncated?: boolean;
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

interface LegacyTextRangeResult {
  content: string;
  end_line?: number;
  path: string;
  start_line: number;
  total_lines: number;
  truncation_reasons?: string[];
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
  const returnedLines: string[] = [];
  let returnedCharacters = 0;
  let characterLimitReached = false;
  let lineTruncated = false;

  for (const line of selected) {
    const separatorLength = returnedLines.length > 0 ? 1 : 0;
    if (returnedCharacters + separatorLength + line.length <= MAX_READ_CHARS) {
      returnedLines.push(line);
      returnedCharacters += separatorLength + line.length;
      continue;
    }

    characterLimitReached = true;
    if (returnedLines.length === 0) {
      returnedLines.push(line.slice(0, MAX_READ_CHARS));
      lineTruncated = true;
    }
    break;
  }

  const endLine =
    returnedLines.length > 0
      ? startLine + returnedLines.length - 1
      : startLine - 1;
  const truncated =
    startIndex > 0 || endLine < lines.length || characterLimitReached;
  const rangeRequested =
    requestedOffset !== undefined || requestedLimit !== undefined;
  const returnedContent =
    !rangeRequested && !truncated ? params.content : returnedLines.join("\n");
  const truncationReasons: string[] = [];
  if (characterLimitReached) {
    truncationReasons.push(`${MAX_READ_CHARS} character output limit reached.`);
  }
  if (lineTruncated) {
    truncationReasons.push(`Line ${startLine} was truncated.`);
  }
  const range: LegacyTextRangeResult = {
    content: returnedContent,
    end_line: selected.length > 0 ? endLine : undefined,
    path: params.path,
    start_line: startLine,
    total_lines: lines.length,
    ...(truncationReasons.length > 0
      ? { truncation_reasons: truncationReasons }
      : undefined),
    truncated,
  };

  return makeStructuredToolOutput({
    target: params.path,
    ...range,
    truncated,
    ...(characterLimitReached
      ? { character_limit_reached: MAX_READ_CHARS }
      : undefined),
    ...(lineTruncated ? { line_truncated: true } : undefined),
    ...(endLine < lines.length
      ? {
          continuation: {
            arguments: {
              [params.continuationArgumentName ?? "path"]: params.path,
              offset: endLine + 1,
              limit: maxLines,
            },
            reason: characterLimitReached
              ? "character output limit reached; file has more lines"
              : "file has more lines",
          },
        }
      : undefined),
  });
}

/** Reject an expected missing read target through the tool-error channel. */
export function missingFileResult(path: string): never {
  throw new ToolInputError(`File not found: ${path}`);
}
