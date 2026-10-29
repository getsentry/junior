import {
  findInErrorChain,
  getSandboxErrorDetails,
} from "@/chat/sandbox/errors";
import type { SandboxErrorChecks } from "@/chat/sandbox/provider";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function searchableText(error: unknown): string {
  const details = getSandboxErrorDetails(error);
  return `${details.searchableText} ${details.summary}`.toLowerCase();
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

function isUnavailable(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    if (isInvalidSandboxSessionError(candidate)) {
      return true;
    }

    const searchable = searchableText(candidate);
    return (
      searchable.includes("sandbox_stopped") ||
      searchable.includes("status=410") ||
      searchable.includes("status code 410") ||
      searchable.includes("no longer available") ||
      searchable.includes("stream was closed and is not accepting commands")
    );
  });
}

function isMissing(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    const searchable = searchableText(candidate);
    return (
      searchable.includes("status=404") ||
      searchable.includes("status code 404") ||
      searchable.includes("snapshot_not_found")
    );
  });
}

function isSnapshotMissing(error: unknown): boolean {
  const searchable =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    searchable.includes("snapshot") &&
    (searchable.includes("not found") ||
      searchable.includes("unknown") ||
      searchable.includes("404"))
  );
}

function isSnapshotting(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    const searchable = searchableText(candidate);
    return (
      searchable.includes("sandbox_snapshotting") ||
      searchable.includes("creating a snapshot") ||
      searchable.includes("stopped shortly")
    );
  });
}

function isTransient(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    const searchable = searchableText(candidate);
    if (
      searchable.includes("internal_server_error") ||
      searchable.includes("status=500") ||
      searchable.includes("status code 500") ||
      searchable.includes("status=502") ||
      searchable.includes("status code 502") ||
      searchable.includes("status=503") ||
      searchable.includes("status code 503") ||
      searchable.includes("status=504") ||
      searchable.includes("status code 504")
    ) {
      return true;
    }

    if (!isRecord(candidate)) return false;
    const response = candidate.response;
    return (
      isRecord(response) &&
      typeof response.status === "number" &&
      response.status >= 500 &&
      response.status < 600
    );
  });
}

function isCommandStreamInterrupted(error: unknown): boolean {
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

/** Map Vercel Sandbox API and SDK errors to the shared sandbox error cases. */
export const vercelSandboxErrors: SandboxErrorChecks = {
  isUnavailable,
  isMissing,
  isSnapshotMissing,
  isSnapshotting,
  isTransient,
  isCommandStreamInterrupted,
};
