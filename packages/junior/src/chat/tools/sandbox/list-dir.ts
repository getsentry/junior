import path from "node:path";
import {
  isMissingPathError,
  missingPathSearchResult,
  positiveInteger,
  resolveWorkspacePath,
  type SandboxFileSystem,
  type TextSearchResultDetails,
  type TextSearchToolResult,
} from "@/chat/tools/sandbox/file-utils";
import * as z from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  juniorToolOutputSchema,
  makeStructuredToolOutput,
} from "@/chat/tool-support/structured-result";
import { SANDBOX_TOOL_SOURCE } from "@/chat/sandbox/tool-source";

const DEFAULT_LIST_LIMIT = 500;

interface ListDirResultData {
  entries: string[];
  entry_count: number;
  path: string;
  total_entries: number;
  truncation_reasons?: string[];
}

interface ListDirSuccessResult {
  content: [{ type: "text"; text: string }];
  details: TextSearchResultDetails &
    ListDirResultData & {
      entry_limit_reached?: number;
    };
}

type ListDirResult = ListDirSuccessResult | TextSearchToolResult;

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

  const body = output.length > 0 ? output.join("\n") : "(empty directory)";
  const notices: string[] = [];
  if (entryLimitReached) {
    notices.push(
      `${limit} entries limit reached. Use a higher limit to continue.`,
    );
  }

  return makeStructuredToolOutput({
    target: params.path ?? ".",
    path: params.path ?? ".",
    truncated: entryLimitReached,
    entries: body === "(empty directory)" ? [] : body.split("\n"),
    entry_count: output.length,
    total_entries: entries.length,
    ...(notices.length > 0 ? { truncation_reasons: notices } : undefined),
    ...(entryLimitReached ? { entry_limit_reached: limit } : undefined),
  });
}

/** Create the sandbox directory listing tool definition exposed to the agent. */
export function createListDirTool() {
  return zodTool({
    exposure: "deferred",
    source: SANDBOX_TOOL_SOURCE,
    description:
      "List a sandbox workspace directory. Returns sorted entries with '/' suffixes for directories and bounded truncation notices.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
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
    outputSchema: juniorToolOutputSchema,
    execute: async () => {
      throw new Error(
        "listDir can only run when sandbox execution is enabled.",
      );
    },
  });
}
