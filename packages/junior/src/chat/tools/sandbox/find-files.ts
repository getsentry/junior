import path from "node:path";
import {
  DEFAULT_SEARCH_COMMAND_TIMEOUT_MS,
  MAX_TEXT_CHARS,
  RIPGREP_EXCLUDED_GLOBS,
  collectFiles,
  getRipgrepSearchLocation,
  isMissingPathError,
  missingPathSearchResult,
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
import {
  juniorToolOutputSchema,
  makeStructuredToolOutput,
  type JuniorToolOutputEnvelope,
} from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const DEFAULT_FIND_LIMIT = 100;

interface FindFilesSuccessResult {
  content: JuniorToolOutputEnvelope["content"];
  details: TextSearchResultDetails & {
    files: string[];
    file_count: number;
    truncation_reasons?: string[];
    result_limit_reached?: number;
  };
}

type FindFilesResult = FindFilesSuccessResult | TextSearchToolResult;

/** Find workspace files with structured limits instead of ad hoc shell output. */
export async function findFiles(params: {
  fs: SandboxFileSystem;
  limit?: unknown;
  onTelemetry?: (telemetry: SandboxSearchTelemetry) => void;
  path?: string;
  pattern: string;
  runCommand?: SandboxCommandRunner;
}): Promise<FindFilesResult> {
  if (!params.pattern.trim()) {
    throw new ToolInputError("pattern is required");
  }

  const root = resolveWorkspacePath(params.path);
  const limit = positiveInteger(params.limit) ?? DEFAULT_FIND_LIMIT;
  if (params.runCommand) {
    return await findFilesWithRipgrep({
      fs: params.fs,
      limit,
      onTelemetry: params.onTelemetry,
      path: params.path,
      pattern: params.pattern,
      root,
      runCommand: params.runCommand,
    });
  }
  const { files, limitReached, missingPath, missingRoot } = await collectFiles({
    fs: params.fs,
    root,
    pattern: params.pattern,
    limit,
  });
  if (missingPath) {
    return missingPathSearchResult({
      path: params.path ?? ".",
      ...(missingRoot ? { displayPath: params.path ?? "." } : { missingPath }),
    });
  }
  const relativePaths = files.map((filePath) =>
    path.posix.relative(root, filePath),
  );
  const bounded = truncateText(
    relativePaths.length > 0
      ? relativePaths.join("\n")
      : "No files found matching pattern",
  );
  const notices: string[] = [];
  if (limitReached) {
    notices.push(
      `${limit} results limit reached. Refine pattern or raise limit.`,
    );
  }
  if (bounded.truncated) {
    notices.push(`${MAX_TEXT_CHARS} character output limit reached.`);
  }

  const text =
    notices.length > 0
      ? `${bounded.content}\n\n[${notices.join(" ")}]`
      : bounded.content;

  return makeStructuredToolOutput(
    {
      target: params.path ?? ".",
      path: params.path ?? ".",
      truncated: limitReached || bounded.truncated,
      files: relativePaths,
      file_count: relativePaths.length,
      ...(notices.length > 0 ? { truncation_reasons: notices } : {}),
      ...(limitReached ? { result_limit_reached: limit } : {}),
    },
    { content: [{ type: "text", text }] },
  ) as FindFilesResult;
}

async function findFilesWithRipgrep(params: {
  fs: SandboxFileSystem;
  limit: number;
  onTelemetry?: (telemetry: SandboxSearchTelemetry) => void;
  path?: string;
  pattern: string;
  root: string;
  runCommand: SandboxCommandRunner;
}): Promise<FindFilesResult> {
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
  const ripgrepArgs = [
    "--files",
    "--null",
    "--hidden",
    "--glob",
    params.pattern,
  ];
  for (const excludedGlob of RIPGREP_EXCLUDED_GLOBS) {
    ripgrepArgs.push("--glob", excludedGlob);
  }
  ripgrepArgs.push("--", location.target);
  const result = await params.runCommand({
    cmd: "bash",
    args: [
      "-c",
      [
        `rg "$@" | head -z -n ${params.limit + 1}`,
        'statuses=("${PIPESTATUS[@]}")',
        "if (( statuses[1] != 0 )); then",
        '  exit "${statuses[1]}"',
        "fi",
        "if (( statuses[0] == 0 || statuses[0] == 1 || statuses[0] == 141 )); then",
        "  exit 0",
        "fi",
        'exit "${statuses[0]}"',
      ].join("\n"),
      "find-files",
      ...ripgrepArgs,
    ],
    cwd: location.cwd,
    timeoutMs: DEFAULT_SEARCH_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "command failed";
    if (/error parsing glob|invalid glob/i.test(detail)) {
      throw new ToolInputError(`Invalid glob pattern: ${params.pattern}`, {
        cause: new Error(detail),
      });
    }
    throw new Error(`ripgrep file search failed: ${detail}`);
  }

  const allPaths = result.stdout
    .split("\0")
    .filter(Boolean)
    .map((filePath) => {
      const absolute = filePath.startsWith("/")
        ? path.posix.normalize(filePath)
        : path.posix.resolve(location.cwd, filePath);
      return rootIsDirectory
        ? path.posix.relative(params.root, absolute)
        : path.posix.basename(absolute);
    });
  const limitReached = allPaths.length > params.limit;
  const relativePaths = allPaths.slice(0, params.limit);
  const bounded = truncateText(
    relativePaths.length > 0
      ? relativePaths.join("\n")
      : "No files found matching pattern",
  );
  const notices: string[] = [];
  if (limitReached) {
    notices.push(
      `${params.limit} results limit reached. Refine pattern or raise limit.`,
    );
  }
  if (bounded.truncated) {
    notices.push(`${MAX_TEXT_CHARS} character output limit reached.`);
  }
  const text =
    notices.length > 0
      ? `${bounded.content}\n\n[${notices.join(" ")}]`
      : bounded.content;

  const response = makeStructuredToolOutput(
    {
      target: params.path ?? ".",
      path: params.path ?? ".",
      truncated: limitReached || bounded.truncated,
      files: relativePaths,
      file_count: relativePaths.length,
      ...(notices.length > 0 ? { truncation_reasons: notices } : {}),
      ...(limitReached ? { result_limit_reached: params.limit } : {}),
    },
    { content: [{ type: "text", text }] },
  ) as FindFilesResult;
  params.onTelemetry?.({
    emittedLineCount: relativePaths.length,
    limit: params.limit,
    limitReached,
    parsedRecordCount: allPaths.length,
    rawOutputBytes: Buffer.byteLength(result.stdout, "utf8"),
    resultBytes: response.content.reduce(
      (total, item) =>
        total +
        (item.type === "text" ? Buffer.byteLength(item.text, "utf8") : 0),
      0,
    ),
    resultCount: relativePaths.length,
  });
  return response;
}

/** Create the sandbox file discovery tool definition exposed to the agent. */
export function createFindFilesTool() {
  return zodTool({
    description:
      "Find sandbox workspace files by glob pattern. Returns bounded paths relative to the search root and skips dependency/cache directories.",
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
        .describe(
          "Glob pattern to match, for example '*.ts', '**/*.json', or 'src/**/*.test.ts'.",
        ),
      path: z
        .string()
        .min(1)
        .describe(
          "Directory or file path in the sandbox workspace. Defaults to the workspace root.",
        )
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .describe("Maximum number of file paths to return. Defaults to 100.")
        .optional(),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async () => {
      throw new Error(
        "findFiles can only run when sandbox execution is enabled.",
      );
    },
  });
}
