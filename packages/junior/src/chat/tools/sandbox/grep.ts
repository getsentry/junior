import path from "node:path";
import {
  DEFAULT_SEARCH_COMMAND_TIMEOUT_MS,
  MAX_TEXT_CHARS,
  RIPGREP_EXCLUDED_GLOBS,
  collectFiles,
  getRipgrepSearchLocation,
  isMissingPathError,
  missingPathSearchResult,
  normalizeToLf,
  positiveInteger,
  resolveWorkspacePath,
  truncateText,
  type SandboxCommandRunner,
  type SandboxFileSystem,
  type SandboxSearchTelemetry,
  type TextSearchResultDetails,
  type TextSearchToolResult,
} from "@/chat/tools/sandbox/file-utils";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  juniorToolOutputSchema,
  makeStructuredToolOutput,
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
  details: TextSearchResultDetails &
    GrepResultData & {
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
  onTelemetry?: (telemetry: SandboxSearchTelemetry) => void;
  path?: string;
  pattern: string;
  runCommand?: SandboxCommandRunner;
}): Promise<GrepResult> {
  if (!params.pattern) {
    throw new ToolInputError("pattern is required");
  }

  const root = resolveWorkspacePath(params.path);
  const limit = positiveInteger(params.limit) ?? DEFAULT_GREP_LIMIT;
  const context = positiveInteger(params.context) ?? 0;
  if (params.runCommand) {
    return await grepFilesWithRipgrep({
      context,
      fs: params.fs,
      glob: params.glob,
      ignoreCase: params.ignoreCase,
      limit,
      literal: params.literal,
      onTelemetry: params.onTelemetry,
      path: params.path,
      pattern: params.pattern,
      root,
      runCommand: params.runCommand,
    });
  }
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

  return makeStructuredToolOutput({
    target: params.path ?? ".",
    path: params.path ?? ".",
    truncated: matchLimitReached || lineTruncated || bounded.truncated,
    context,
    ...(params.glob ? { glob: params.glob } : {}),
    line_count: output.length,
    lines:
      bounded.content === "No matches found" ? [] : bounded.content.split("\n"),
    match_count: matchCount,
    pattern: params.pattern,
    ...(notices.length > 0 ? { truncation_reasons: notices } : {}),
    ...(matchLimitReached ? { match_limit_reached: limit } : {}),
    ...(lineTruncated ? { line_truncated: true } : {}),
  });
}

interface RipgrepText {
  bytes?: string;
  text?: string;
}

interface RipgrepRecord {
  type?: string;
  data?: {
    line_number?: number;
    lines?: RipgrepText;
    path?: RipgrepText;
  };
}

function decodeRipgrepText(value: RipgrepText | undefined): string {
  if (typeof value?.text === "string") {
    return value.text;
  }
  if (typeof value?.bytes === "string") {
    return Buffer.from(value.bytes, "base64").toString("utf8");
  }
  return "";
}

async function grepFilesWithRipgrep(params: {
  context: number;
  fs: SandboxFileSystem;
  glob?: string;
  ignoreCase?: boolean;
  limit: number;
  literal?: boolean;
  onTelemetry?: (telemetry: SandboxSearchTelemetry) => void;
  path?: string;
  pattern: string;
  root: string;
  runCommand: SandboxCommandRunner;
}): Promise<GrepResult> {
  let rootIsDirectory: boolean;
  try {
    rootIsDirectory = (await params.fs.stat(params.root)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) {
      return missingPathSearchResult({
        path: params.path ?? ".",
        displayPath: params.path ?? ".",
      });
    }
    throw error;
  }

  const location = getRipgrepSearchLocation(params.root, rootIsDirectory);
  const args = [
    "--json",
    "--line-number",
    "--hidden",
    "--max-count",
    String(params.limit + 1),
  ];
  if (params.ignoreCase) {
    args.push("--ignore-case");
  }
  if (params.literal) {
    args.push("--fixed-strings");
  }
  if (params.glob) {
    args.push("--glob", params.glob);
  }
  for (const excludedGlob of RIPGREP_EXCLUDED_GLOBS) {
    args.push("--glob", excludedGlob);
  }
  if (params.context > 0) {
    args.push("--context", String(params.context));
  }
  args.push("--", params.pattern, location.target);

  const result = await params.runCommand({
    cmd: "rg",
    args,
    cwd: location.cwd,
    timeoutMs: DEFAULT_SEARCH_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "command failed";
    if (/regex parse error|error parsing regex|error parsing glob/i.test(detail)) {
      throw new ToolInputError(`Invalid pattern: ${params.pattern}`, {
        cause: new Error(detail),
      });
    }
    throw new Error(`ripgrep search failed: ${detail}`);
  }

  const recordsByPath = new Map<
    string,
    Array<{ line: number; matched: boolean; text: string }>
  >();
  const pathOrder: string[] = [];
  let totalMatches = 0;
  let parsedRecordCount = 0;
  for (const rawLine of normalizeToLf(result.stdout).split("\n")) {
    if (!rawLine) {
      continue;
    }
    let record: RipgrepRecord;
    try {
      record = JSON.parse(rawLine) as RipgrepRecord;
    } catch (error) {
      throw new Error("ripgrep returned invalid JSON output", { cause: error });
    }
    parsedRecordCount += 1;
    if (record.type !== "match" && record.type !== "context") {
      continue;
    }
    const line = record.data?.line_number;
    const rawPath = decodeRipgrepText(record.data?.path);
    if (!line || !rawPath) {
      continue;
    }
    const absolutePath = rawPath.startsWith("/")
      ? path.posix.normalize(rawPath)
      : path.posix.resolve(location.cwd, rawPath);
    const displayPath = rootIsDirectory
      ? path.posix.relative(params.root, absolutePath)
      : path.posix.basename(absolutePath);
    let records = recordsByPath.get(displayPath);
    if (!records) {
      records = [];
      recordsByPath.set(displayPath, records);
      pathOrder.push(displayPath);
    }
    const matched = record.type === "match";
    if (matched) {
      totalMatches += 1;
    }
    records.push({
      line,
      matched,
      text: decodeRipgrepText(record.data?.lines).replace(/\r?\n$/, ""),
    });
  }

  let remainingMatches = params.limit;
  const output: string[] = [];
  let lineTruncated = false;
  for (const displayPath of pathOrder) {
    const records = recordsByPath.get(displayPath) ?? [];
    const selectedMatchLines: number[] = [];
    for (const record of records) {
      if (record.matched && remainingMatches > 0) {
        selectedMatchLines.push(record.line);
        remainingMatches -= 1;
      }
    }
    if (selectedMatchLines.length === 0) {
      continue;
    }
    const selectedMatchSet = new Set(selectedMatchLines);
    const emittedLines = new Set<number>();
    for (const record of records) {
      if (emittedLines.has(record.line)) {
        continue;
      }
      const include = selectedMatchLines.some(
        (matchLine) => Math.abs(record.line - matchLine) <= params.context,
      );
      if (!include) {
        continue;
      }
      emittedLines.add(record.line);
      const truncated = truncateGrepLine(record.text);
      lineTruncated ||= truncated.truncated;
      const separator = selectedMatchSet.has(record.line) ? ":" : "-";
      output.push(
        `${displayPath}${separator}${record.line}${separator} ${truncated.line}`,
      );
    }
  }

  const matchCount = Math.min(totalMatches, params.limit);
  const matchLimitReached = totalMatches > params.limit;
  const bounded = truncateText(
    output.length > 0 ? output.join("\n") : "No matches found",
  );
  const notices: string[] = [];
  if (matchLimitReached) {
    notices.push(
      `${params.limit} matches limit reached. Refine pattern or raise limit.`,
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

  const response = makeStructuredToolOutput({
    target: params.path ?? ".",
    path: params.path ?? ".",
    truncated: matchLimitReached || lineTruncated || bounded.truncated,
    context: params.context,
    ...(params.glob ? { glob: params.glob } : {}),
    line_count: output.length,
    lines:
      bounded.content === "No matches found" ? [] : bounded.content.split("\n"),
    match_count: matchCount,
    pattern: params.pattern,
    ...(notices.length > 0 ? { truncation_reasons: notices } : {}),
    ...(matchLimitReached ? { match_limit_reached: params.limit } : {}),
    ...(lineTruncated ? { line_truncated: true } : {}),
  });
  params.onTelemetry?.({
    emittedLineCount: output.length,
    limit: params.limit,
    limitReached: matchLimitReached,
    parsedRecordCount,
    rawOutputBytes: Buffer.byteLength(result.stdout, "utf8"),
    resultBytes: response.content.reduce(
      (total, item) =>
        total +
        (item.type === "text" ? Buffer.byteLength(item.text, "utf8") : 0),
      0,
    ),
    resultCount: matchCount,
  });
  return response;
}

/** Create the sandbox grep tool definition exposed to the agent. */
export function createGrepTool() {
  return zodTool({
    description:
      "Search sandbox workspace file contents. Returns bounded matching lines with file paths and line numbers. Respects path/glob filters and includes truncation notices.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
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
    outputSchema: juniorToolOutputSchema,
    execute: async () => {
      throw new Error("grep can only run when sandbox execution is enabled.");
    },
  });
}
