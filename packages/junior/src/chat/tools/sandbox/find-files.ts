import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  MAX_TEXT_CHARS,
  collectFiles,
  positiveInteger,
  resolveWorkspacePath,
  truncateText,
  type SandboxFileSystem,
  type TextSearchResultDetails,
} from "@/chat/tools/sandbox/file-utils";
import { tool } from "@/chat/tools/definition";

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
  const { files, limitReached } = await collectFiles({
    fs: params.fs,
    root,
    pattern: params.pattern,
    limit,
  });
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
  return tool({
    description:
      "Find sandbox workspace files by glob pattern. Returns bounded paths relative to the search root and skips dependency/cache directories.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object(
      {
        pattern: Type.String({
          minLength: 1,
          description:
            "Glob pattern to match, for example '*.ts', '**/*.json', or 'src/**/*.test.ts'.",
        }),
        path: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Directory or file path in the sandbox workspace. Defaults to the workspace root.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "Maximum number of file paths to return. Defaults to 1000.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new Error(
        "findFiles can only run when sandbox execution is enabled.",
      );
    },
  });
}
