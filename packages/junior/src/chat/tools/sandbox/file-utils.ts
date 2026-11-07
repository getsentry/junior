import path from "node:path";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type {
  SandboxCommandInput,
  SandboxCommandResult,
  SandboxFileSystem,
} from "@/chat/sandbox/workspace";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export type { SandboxFileSystem };
export type SandboxCommandRunner = (
  input: SandboxCommandInput,
) => Promise<SandboxCommandResult>;

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

// Models write scratch files to /tmp by habit. `bash` can already write
// there, so the file tools allow it too.
const SANDBOX_FILE_ROOTS = [SANDBOX_WORKSPACE_ROOT, "/tmp"];

/** Keep sandbox filesystem tools scoped to the workspace root and /tmp. */
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
    !SANDBOX_FILE_ROOTS.some(
      (root) => normalized === root || normalized.startsWith(`${root}/`),
    )
  ) {
    throw new ToolInputError(
      `Path must stay within ${SANDBOX_FILE_ROOTS.join(" or ")}: ${requested}`,
    );
  }
  return normalized;
}
