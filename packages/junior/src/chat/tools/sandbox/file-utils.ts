import path from "node:path";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type { SandboxFileSystem } from "@/chat/sandbox/workspace";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export type { SandboxFileSystem };

export const MAX_TEXT_CHARS = 60_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

export type TextSearchResultDetails =
  | {
      ok: true;
      path: string;
      truncated: boolean;
    }
  | {
      ok: false;
      error: "not_found";
      path: string;
      missing_path?: string;
      truncated: false;
    };

export interface TextSearchToolResult {
  content: [{ type: "text"; text: string }];
  details: TextSearchResultDetails;
}

/** Normalize model-supplied numeric knobs before they reach filesystem tools. */
export function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

/** Compare and slice text in one line-ending space while preserving callers' output rules. */
export function normalizeToLf(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Keep tool output inside the model-facing budget with an explicit notice. */
export function truncateText(
  value: string,
  maxChars = MAX_TEXT_CHARS,
): { content: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { content: value, truncated: false };
  }

  const removed = value.length - maxChars;
  return {
    content: `${value.slice(0, maxChars)}\n\n[output truncated: ${removed} characters removed]`,
    truncated: true,
  };
}

/** Detect model-facing missing paths without swallowing sandbox lifecycle/API failures. */
export function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === "ENOENT") {
    return true;
  }
  return (
    typeof candidate.message === "string" &&
    candidate.message.startsWith("File not found:")
  );
}

/** Build the shared model-visible result for expected missing search/list paths. */
export function missingPathSearchResult(params: {
  path: string;
  displayPath?: string;
  missingPath?: string;
}): TextSearchToolResult {
  const textPath = params.displayPath ?? params.missingPath ?? params.path;
  return {
    content: [{ type: "text", text: `Path not found: ${textPath}` }],
    details: {
      ok: false,
      error: "not_found",
      path: params.path,
      ...(params.missingPath ? { missing_path: params.missingPath } : {}),
      truncated: false,
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
        continue;
      }
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

function matchesGlob(relativePath: string, pattern: string): boolean {
  const matcher = globToRegExp(pattern);
  if (matcher.test(relativePath)) {
    return true;
  }
  if (
    pattern.startsWith("**/") &&
    matchesGlob(relativePath, pattern.slice(3))
  ) {
    return true;
  }
  return (
    !pattern.includes("/") && matcher.test(path.posix.basename(relativePath))
  );
}

/** Keep sandbox filesystem tools scoped to the mounted workspace root. */
export function resolveWorkspacePath(
  input: string | undefined,
  fallback = ".",
): string {
  const requested = (input ?? "").trim() || fallback;
  const absolute = requested.startsWith("/")
    ? requested
    : path.posix.join(SANDBOX_WORKSPACE_ROOT, requested);
  const normalized = path.posix.normalize(absolute);
  if (
    normalized !== SANDBOX_WORKSPACE_ROOT &&
    !normalized.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`)
  ) {
    throw new ToolInputError(
      `Path must stay within ${SANDBOX_WORKSPACE_ROOT}: ${requested}`,
    );
  }
  return normalized;
}

/** Share bounded workspace traversal across search tools so their skip rules stay aligned. */
export async function collectFiles(params: {
  fs: SandboxFileSystem;
  root: string;
  limit?: number;
  pattern?: string;
}): Promise<{
  files: string[];
  limitReached: boolean;
  missingPath?: string;
  missingRoot: boolean;
}> {
  const files: string[] = [];
  let limitReached = false;
  let missingPath: string | undefined;

  const visit = async (dirPath: string): Promise<void> => {
    if (missingPath) {
      return;
    }
    let entries: string[];
    try {
      entries = (await params.fs.readdir(dirPath)).sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      );
    } catch (error) {
      if (isMissingPathError(error)) {
        missingPath = dirPath;
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.posix.join(dirPath, entry);
      let stat: Awaited<ReturnType<SandboxFileSystem["stat"]>>;
      try {
        stat = await params.fs.stat(fullPath);
      } catch (error) {
        if (isMissingPathError(error)) {
          missingPath = fullPath;
          return;
        }
        throw error;
      }
      if (stat.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry)) {
          await visit(fullPath);
        }
        if (limitReached) return;
        continue;
      }

      const relativePath = path.posix.relative(params.root, fullPath);
      if (!params.pattern || matchesGlob(relativePath, params.pattern)) {
        files.push(fullPath);
        if (params.limit && files.length >= params.limit) {
          limitReached = true;
          return;
        }
      }
    }
  };

  let stat: Awaited<ReturnType<SandboxFileSystem["stat"]>>;
  try {
    stat = await params.fs.stat(params.root);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        files,
        limitReached: false,
        missingPath: params.root,
        missingRoot: true,
      };
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    const relativePath = path.posix.basename(params.root);
    return {
      files:
        !params.pattern || matchesGlob(relativePath, params.pattern)
          ? [params.root]
          : [],
      limitReached: false,
      missingRoot: false,
    };
  }

  await visit(params.root);
  return {
    files,
    limitReached,
    missingPath,
    missingRoot: missingPath === params.root,
  };
}
