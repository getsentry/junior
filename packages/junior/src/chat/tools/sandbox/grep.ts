import path from "node:path";
import {
  MAX_TEXT_CHARS,
  collectFiles,
  isMissingPathError,
  missingPathSearchResult,
  normalizeToLf,
  positiveInteger,
  resolveWorkspacePath,
  truncateText,
  type SandboxFileSystem,
  type TextSearchResultDetails,
  type TextSearchToolResult,
} from "@/chat/tools/sandbox/file-utils";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  juniorToolResultSchema,
  makeStructuredToolResult,
} from "@/chat/tool-support/structured-result";

const DEFAULT_GREP_LIMIT = 100;
const MAX_GREP_LINE_CHARS = 500;

interface GrepResultData {
  context: number;
  glob?: string;
  line_count: number;
  lines: string[];
  match_count: number;
  pattern: string;
  path: string;
  truncation_reasons?: string[];
}

interface GrepSuccessResult {
  content: [{ type: "text"; text: string }];
  details: Extract<TextSearchResultDetails, { ok: true }> & {
    data: GrepResultData;
    line_truncated?: boolean;
    match_limit_reached?: number;
  };
}

type GrepResult = GrepSuccessResult | TextSearchToolResult;

const booleanInput = (description: string) =>
  z
    .preprocess(
      (value) => (value === "true" ? true : value === "false" ? false : value),
      z.boolean(),
    )
    .describe(description);

function truncateGrepLine(value: string): { line: string; truncated: boolean } {
  if (value.length <= MAX_GREP_LINE_CHARS) {
    return { line: value, truncated: false };
  }
  return {
    line: `${value.slice(0, MAX_GREP_LINE_CHARS)}... [line truncated]`,
    truncated: true,
  };
}

function lineMatches(params: {
  ignoreCase?: boolean;
  literal?: boolean;
  line: string;
  pattern: string;
  regex?: RegExp;
}): boolean {
  if (!params.literal) {
    return Boolean(params.regex?.test(params.line));
  }

  if (params.ignoreCase) {
    return params.line.toLowerCase().includes(params.pattern.toLowerCase());
  }
  return params.line.includes(params.pattern);
}

/** Search workspace file contents with bounded, line-numbered output. */
export async function grepFiles(params: {
  context?: unknown;
  fs: SandboxFileSystem;
  glob?: string;
  ignoreCase?: boolean;
  limit?: unknown;
  literal?: boolean;
  path?: string;
  pattern: string;
}): Promise<GrepResult> {
  if (!params.pattern) {
    throw new Error("pattern is required");
  }

  const root = resolveWorkspacePath(params.path);
  const limit = positiveInteger(params.limit) ?? DEFAULT_GREP_LIMIT;
  const context = positiveInteger(params.context) ?? 0;
  let regex: RegExp | undefined;
  if (!params.literal) {
    try {
      regex = new RegExp(params.pattern, params.ignoreCase ? "i" : "");
    } catch (error) {
      throw new ToolInputError(`Invalid regex pattern: ${params.pattern}`, {
        cause: error,
      });
    }
  }
  const { files, missingPath, missingRoot } = await collectFiles({
    fs: params.fs,
    root,
    pattern: params.glob,
  });
  if (missingPath) {
    return missingPathSearchResult({
      path: params.path ?? ".",
      ...(missingRoot ? { displayPath: params.path ?? "." } : { missingPath }),
    });
  }
  const output: string[] = [];
  let matchCount = 0;
  let matchLimitReached = false;
  let lineTruncated = false;

  for (const filePath of files) {
    if (matchLimitReached) break;
    let content: string;
    try {
      content = await params.fs.readFile(filePath, { encoding: "utf8" });
    } catch (error) {
      if (isMissingPathError(error)) {
        return missingPathSearchResult({
          path: params.path ?? ".",
          missingPath: filePath,
        });
      }
      throw error;
    }
    if (content.includes("\u0000")) {
      continue;
    }

    const lines = normalizeToLf(content).split("\n");
    const relativePath =
      files.length === 1 && filePath === root
        ? path.posix.basename(filePath)
        : path.posix.relative(root, filePath);
    const matchedLines: number[] = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (
        !lineMatches({
          ignoreCase: params.ignoreCase,
          line: lines[lineIndex],
          literal: params.literal,
          pattern: params.pattern,
          regex,
        })
      ) {
        continue;
      }
      if (matchCount >= limit) {
        matchLimitReached = true;
        break;
      }
      matchCount += 1;
      matchedLines.push(lineIndex);
    }

    const matchedLineSet = new Set(matchedLines);
    const emittedLines = new Set<number>();
    for (const lineIndex of matchedLines) {
      const start = Math.max(0, lineIndex - context);
      const end = Math.min(lines.length - 1, lineIndex + context);
      for (let current = start; current <= end; current += 1) {
        if (emittedLines.has(current)) {
          continue;
        }
        emittedLines.add(current);
        const truncated = truncateGrepLine(lines[current]);
        lineTruncated ||= truncated.truncated;
        const separator = matchedLineSet.has(current) ? ":" : "-";
        output.push(
          `${relativePath}${separator}${current + 1}${separator} ${truncated.line}`,
        );
      }
    }
  }

  const bounded = truncateText(
    output.length > 0 ? output.join("\n") : "No matches found",
  );
  const notices: string[] = [];
  if (matchLimitReached) {
    notices.push(
      `${limit} matches limit reached. Refine pattern or raise limit.`,
    );
  }
  if (lineTruncated) {
    notices.push(
      `Some lines were truncated to ${MAX_GREP_LINE_CHARS} characters.`,
    );
  }
  if (bounded.truncated) {
    notices.push(`${MAX_TEXT_CHARS} character output limit reached.`);
  }

  return makeStructuredToolResult({
    ok: true,
    status: "success",
    target: params.path ?? ".",
    path: params.path ?? ".",
    truncated: matchLimitReached || lineTruncated || bounded.truncated,
    data: {
      context,
      ...(params.glob ? { glob: params.glob } : {}),
      line_count: output.length,
      lines:
        bounded.content === "No matches found"
          ? []
          : bounded.content.split("\n"),
      match_count: matchCount,
      pattern: params.pattern,
      path: params.path ?? ".",
      ...(notices.length > 0 ? { truncation_reasons: notices } : {}),
    },
    ...(matchLimitReached ? { match_limit_reached: limit } : {}),
    ...(lineTruncated ? { line_truncated: true } : {}),
  });
}

/** Create the sandbox grep tool definition exposed to the agent. */
export function createGrepTool() {
  return zodTool({
    description:
      "Search sandbox workspace file contents. Returns bounded matching lines with file paths and line numbers. Respects path/glob filters and includes truncation notices.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({
      pattern: z
        .string()
        .min(1)
        .describe("Regex pattern or literal text to search for."),
      path: z
        .string()
        .min(1)
        .describe(
          "Directory or file path in the sandbox workspace. Defaults to the workspace root.",
        )
        .optional(),
      glob: z
        .string()
        .min(1)
        .describe("Optional glob filter such as '*.ts' or '**/*.test.ts'.")
        .optional(),
      ignoreCase: booleanInput(
        "Whether matching should ignore case.",
      ).optional(),
      literal: booleanInput(
        "Treat pattern as literal text instead of regex.",
      ).optional(),
      context: z.coerce
        .number()
        .int()
        .min(0)
        .describe("Number of surrounding context lines to include.")
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .describe("Maximum matches to return. Defaults to 100.")
        .optional(),
    }),
    outputSchema: juniorToolResultSchema,
    execute: async () => {
      throw new Error("grep can only run when sandbox execution is enabled.");
    },
  });
}
