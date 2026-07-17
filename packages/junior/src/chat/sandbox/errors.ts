import { setSpanAttributes, setSpanStatus } from "@/chat/logging";
import { extractHttpErrorDetails } from "@/chat/sandbox/http-error-details";

const SANDBOX_ERROR_FIELDS = [
  {
    sourceKey: "sandboxId",
    attributeKey: "sandbox_id",
    summaryKey: "sandboxId",
  },
] as const;

function getSandboxErrorDetails(error: unknown) {
  return extractHttpErrorDetails(error, {
    attributePrefix: "app.sandbox.api_error",
    extraFields: [...SANDBOX_ERROR_FIELDS],
  });
}

function findInErrorChain(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInvalidSandboxSessionError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  if (isRecord(error.json) && error.json.invalidToken === true) {
    return true;
  }

  const response = error.response;
  return (
    isRecord(response) &&
    response.status === 403 &&
    typeof response.url === "string" &&
    response.url.includes("/sandboxes/sessions")
  );
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

/** Detect when a cached sandbox can no longer be reused and must be recreated. */
export function isSandboxUnavailableError(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    if (isInvalidSandboxSessionError(candidate)) {
      return true;
    }

    const details = getSandboxErrorDetails(candidate);
    const searchable =
      `${details.searchableText} ${details.summary}`.toLowerCase();
    return (
      searchable.includes("sandbox_stopped") ||
      searchable.includes("status=410") ||
      searchable.includes("status code 410") ||
      searchable.includes("no longer available")
    );
  });
}

/** Detect transient snapshot boot races so sandbox creation can retry. */
export function isSnapshottingError(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    const details = getSandboxErrorDetails(candidate);
    const searchable =
      `${details.searchableText} ${details.summary}`.toLowerCase();
    return (
      searchable.includes("sandbox_snapshotting") ||
      searchable.includes("creating a snapshot") ||
      searchable.includes("stopped shortly")
    );
  });
}

/** Detect interrupted command streams where no reliable exit status is available. */
export function isSandboxCommandStreamInterruptedError(
  error: unknown,
): boolean {
  return findInErrorChain(error, (candidate) => {
    if (!(candidate instanceof Error)) {
      return false;
    }

    return (
      candidate.name === "StreamError" &&
      candidate.message
        .toLowerCase()
        .includes("stream ended before command finished")
    );
  });
}

/** Wrap raw sandbox setup failures into one stable user-facing error contract. */
export function wrapSandboxSetupError(error: unknown): Error {
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
      : {}),
    "app.sandbox.success": false,
  });
  setSpanStatus("error");
  throw new Error(
    details.summary
      ? `${action} failed (${details.summary})`
      : `${action} failed`,
    {
      cause: error,
    },
  );
}
