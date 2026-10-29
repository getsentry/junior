import { setSpanAttributes } from "@/chat/logging";
import { extractHttpErrorDetails } from "@/chat/sandbox/http-error-details";
import { getWorkspaceSnapshotNotReadyError } from "@/chat/sandbox/snapshot/not-ready-error";

const SANDBOX_ERROR_FIELDS = [
  {
    sourceKey: "sandboxId",
    attributeKey: "sandbox_id",
    summaryKey: "sandboxId",
  },
] as const;

/** Extract HTTP error details from a sandbox error for span data and checks. */
export function getSandboxErrorDetails(error: unknown) {
  return extractHttpErrorDetails(error, {
    attributePrefix: "app.sandbox.api_error",
    extraFields: [...SANDBOX_ERROR_FIELDS],
  });
}

/** Return true when any error in the `cause` chain matches the predicate. */
export function findInErrorChain(
  error: unknown,
  predicate: (candidate: unknown) => boolean,
): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    if (predicate(current)) {
      return true;
    }
    seen.add(current);
    current =
      typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

function getFirstErrorMessage(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    if (current instanceof Error) {
      const message = current.message.trim();
      if (message) {
        return message;
      }
    }
    seen.add(current);
    current =
      typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }

  return undefined;
}

/** Detect sandbox filesystem operations that can safely ignore existing directories. */
export function isAlreadyExistsError(error: unknown): boolean {
  const details = getSandboxErrorDetails(error);
  return (
    details.searchableText.includes("already exists") ||
    details.searchableText.includes("file exists") ||
    details.searchableText.includes("eexist")
  );
}

/** Detect cancellation so a durable builder stays available for check-in. */
export function isAbortError(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    if (
      typeof DOMException !== "undefined" &&
      candidate instanceof DOMException
    ) {
      return candidate.name === "AbortError";
    }
    return candidate instanceof Error && candidate.name === "AbortError";
  });
}

/** Wrap setup failures. Keep WorkspaceSnapshotNotReadyError as-is. */
export function wrapSandboxSetupError(error: unknown): Error {
  const notReady = getWorkspaceSnapshotNotReadyError(error);
  if (notReady) {
    return notReady;
  }

  try {
    const details = getSandboxErrorDetails(error);
    if (details.summary) {
      return new Error(`sandbox setup failed (${details.summary})`, {
        cause: error,
      });
    }
  } catch {
    // Keep fallback message below if detail extraction fails.
  }

  let causeMessage: string | undefined;
  try {
    causeMessage = getFirstErrorMessage(error);
  } catch (cause) {
    causeMessage = cause instanceof Error ? cause.message : undefined;
  }

  if (
    causeMessage &&
    causeMessage.trim() &&
    causeMessage !== "sandbox setup failed"
  ) {
    const oneLine = causeMessage.replace(/\s+/g, " ").trim();
    return new Error(`sandbox setup failed (${oneLine})`, { cause: error });
  }

  return new Error("sandbox setup failed", { cause: error });
}

/** Record span data and throw one stable sandbox operation error. */
export function throwSandboxOperationError(
  action: string,
  error: unknown,
  includeMissingPath = false,
): never {
  const details = getSandboxErrorDetails(error);
  setSpanAttributes({
    ...details.attributes,
    ...(includeMissingPath
      ? {
          "app.sandbox.api_error.missing_path":
            details.searchableText.includes("no such file") ||
            details.searchableText.includes("enoent"),
        }
      : undefined),
    "app.sandbox.success": false,
  });
  throw new Error(
    details.summary
      ? `${action} failed (${details.summary})`
      : `${action} failed`,
    {
      cause: error,
    },
  );
}
