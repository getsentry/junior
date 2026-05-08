import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  MAX_TEXT_CHARS,
  positiveInteger,
  resolveWorkspacePath,
  truncateText,
  type SandboxFileSystem,
  type TextSearchResultDetails,
} from "@/chat/tools/sandbox/file-utils";
import { tool } from "@/chat/tools/definition";

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
  const stat = await params.fs.stat(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${params.path ?? "."}`);
  }

  const entries = (await params.fs.readdir(dirPath)).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
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
    } catch {
      continue;
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
  return tool({
    description:
      "List a sandbox workspace directory. Returns sorted entries with '/' suffixes for directories and bounded truncation notices.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object(
      {
        path: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Directory path in the sandbox workspace. Defaults to the workspace root.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Maximum entries to return. Defaults to 500.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new Error(
        "listDir can only run when sandbox execution is enabled.",
      );
    },
  });
}
