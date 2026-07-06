import path from "node:path";
import {
  MAX_TEXT_CHARS,
  isMissingPathError,
  missingPathSearchResult,
  positiveInteger,
  resolveWorkspacePath,
  truncateText,
  type SandboxFileSystem,
  type TextSearchResultDetails,
} from "@/chat/tools/sandbox/file-utils";
import { z } from "zod";
import { zodTool } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const DEFAULT_LIST_LIMIT = 500;

interface ListDirResult {
  content: [{ type: "text"; text: string }];
  details: TextSearchResultDetails & {
    entry_limit_reached?: number;
  };
}

/** List workspace directories without forcing the model through shell output. */
export async function listDir(params: {
  fs: SandboxFileSystem;
  limit?: unknown;
  path?: string;
}): Promise<ListDirResult> {
  const dirPath = resolveWorkspacePath(params.path);
  const limit = positiveInteger(params.limit) ?? DEFAULT_LIST_LIMIT;
  let stat: Awaited<ReturnType<SandboxFileSystem["stat"]>>;
  try {
    stat = await params.fs.stat(dirPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return missingPathSearchResult({ path: params.path ?? "." });
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new ToolInputError(`Not a directory: ${params.path ?? "."}`);
  }

  let entries: string[];
  try {
    entries = (await params.fs.readdir(dirPath)).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
  } catch (error) {
    if (isMissingPathError(error)) {
      return missingPathSearchResult({ path: params.path ?? "." });
    }
    throw error;
  }
  const output: string[] = [];
  let entryLimitReached = false;
  for (const entry of entries) {
    if (output.length >= limit) {
      entryLimitReached = true;
      break;
    }
    const entryPath = path.posix.join(dirPath, entry);
    try {
      const entryStat = await params.fs.stat(entryPath);
      output.push(`${entry}${entryStat.isDirectory() ? "/" : ""}`);
    } catch (error) {
      if (isMissingPathError(error)) {
        return missingPathSearchResult({
          path: params.path ?? ".",
          missingPath: entryPath,
        });
      }
      throw error;
    }
  }

  const bounded = truncateText(
    output.length > 0 ? output.join("\n") : "(empty directory)",
  );
  const notices: string[] = [];
  if (entryLimitReached) {
    notices.push(
      `${limit} entries limit reached. Use a higher limit to continue.`,
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
      truncated: entryLimitReached || bounded.truncated,
      ...(entryLimitReached ? { entry_limit_reached: limit } : {}),
    },
  };
}

/** Create the sandbox directory listing tool definition exposed to the agent. */
export function createListDirTool() {
  return zodTool({
    description:
      "List a sandbox workspace directory. Returns sorted entries with '/' suffixes for directories and bounded truncation notices.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .describe(
          "Directory path in the sandbox workspace. Defaults to the workspace root.",
        )
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .describe("Maximum entries to return. Defaults to 500.")
        .optional(),
    }),
    execute: async () => {
      throw new Error(
        "listDir can only run when sandbox execution is enabled.",
      );
    },
  });
}
