import path from "node:path";
import { Type } from "@sinclair/typebox";
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
} from "@/chat/tools/sandbox/file-utils";
import { tool } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const DEFAULT_GREP_LIMIT = 100;
const MAX_GREP_LINE_CHARS = 500;

interface GrepResult {
  content: [{ type: "text"; text: string }];
  details: TextSearchResultDetails & {
    line_truncated?: boolean;
    match_limit_reached?: number;
  };
}

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

  return {
    content: [
      {
        type: "text",
        text:
          notices.length > 0
            ? `${bounded.content}\n\n[${notices.join(" ")}]`
            : bounded.content,
      },
    ],
    details: {
      ok: true,
      path: params.path ?? ".",
      truncated: matchLimitReached || lineTruncated || bounded.truncated,
      ...(matchLimitReached ? { match_limit_reached: limit } : {}),
      ...(lineTruncated ? { line_truncated: true } : {}),
    },
  };
}

/** Create the sandbox grep tool definition exposed to the agent. */
export function createGrepTool() {
  return tool({
    description:
      "Search sandbox workspace file contents. Returns bounded matching lines with file paths and line numbers. Respects path/glob filters and includes truncation notices.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object(
      {
        pattern: Type.String({
          minLength: 1,
          description: "Regex pattern or literal text to search for.",
        }),
        path: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Directory or file path in the sandbox workspace. Defaults to the workspace root.",
          }),
        ),
        glob: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Optional glob filter such as '*.ts' or '**/*.test.ts'.",
          }),
        ),
        ignoreCase: Type.Optional(
          Type.Boolean({
            description: "Whether matching should ignore case.",
          }),
        ),
        literal: Type.Optional(
          Type.Boolean({
            description: "Treat pattern as literal text instead of regex.",
          }),
        ),
        context: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Number of surrounding context lines to include.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Maximum matches to return. Defaults to 100.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new Error("grep can only run when sandbox execution is enabled.");
    },
  });
}
