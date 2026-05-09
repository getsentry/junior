import path from "node:path";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";

export const MAX_TEXT_CHARS = 60_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

interface SandboxFileStat {
  isDirectory(): boolean;
}

export interface SandboxFileSystem {
  readFile(
    filePath: string,
    options: { encoding: BufferEncoding },
  ): Promise<string>;
  writeFile(
    filePath: string,
    content: string,
    options?: { encoding?: BufferEncoding },
  ): Promise<void>;
  readdir(filePath: string): Promise<string[]>;
  stat(filePath: string): Promise<SandboxFileStat>;
}

export interface TextSearchResultDetails {
  ok: true;
  path: string;
  truncated: boolean;
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
    throw new Error(
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
}): Promise<{ files: string[]; limitReached: boolean }> {
  const files: string[] = [];
  let limitReached = false;

  const visit = async (dirPath: string): Promise<void> => {
    const entries = (await params.fs.readdir(dirPath)).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    for (const entry of entries) {
      const fullPath = path.posix.join(dirPath, entry);
      const stat = await params.fs.stat(fullPath);
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

  const stat = await params.fs.stat(params.root);
  if (!stat.isDirectory()) {
    const relativePath = path.posix.basename(params.root);
    return {
      files:
        !params.pattern || matchesGlob(relativePath, params.pattern)
          ? [params.root]
          : [],
      limitReached: false,
    };
  }

  await visit(params.root);
  return { files, limitReached };
}
