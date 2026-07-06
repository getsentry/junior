import path from "node:path";
import {
  MAX_TEXT_CHARS,
  collectFiles,
  missingPathSearchResult,
  positiveInteger,
  resolveWorkspacePath,
  truncateText,
  type SandboxFileSystem,
  type TextSearchResultDetails,
} from "@/chat/tools/sandbox/file-utils";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";

const DEFAULT_FIND_LIMIT = 1000;

interface FindFilesResult {
  content: [{ type: "text"; text: string }];
  details: TextSearchResultDetails & {
    result_limit_reached?: number;
  };
}

/** Find workspace files with structured limits instead of ad hoc shell output. */
export async function findFiles(params: {
  fs: SandboxFileSystem;
  limit?: unknown;
  path?: string;
  pattern: string;
}): Promise<FindFilesResult> {
  if (!params.pattern.trim()) {
    throw new Error("pattern is required");
  }

  const root = resolveWorkspacePath(params.path);
  const limit = positiveInteger(params.limit) ?? DEFAULT_FIND_LIMIT;
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
      truncated: limitReached || bounded.truncated,
      ...(limitReached ? { result_limit_reached: limit } : {}),
    },
  };
}

/** Create the sandbox file discovery tool definition exposed to the agent. */
export function createFindFilesTool() {
  return zodTool({
    description:
      "Find sandbox workspace files by glob pattern. Returns bounded paths relative to the search root and skips dependency/cache directories.",
    annotations: { readOnlyHint: true, destructiveHint: false },
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
        .describe("Maximum number of file paths to return. Defaults to 1000.")
        .optional(),
    }),
    execute: async () => {
      throw new Error(
        "findFiles can only run when sandbox execution is enabled.",
      );
    },
  });
}
