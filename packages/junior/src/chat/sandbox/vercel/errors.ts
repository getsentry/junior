import {
  findInErrorChain,
  getSandboxErrorDetails,
} from "@/chat/sandbox/errors";
import type { SandboxErrorChecks } from "@/chat/sandbox/provider";
import * as z from "zod";

const invalidTokenErrorSchema = z.object({
  json: z.object({ invalidToken: z.literal(true) }),
});

const sessionForbiddenErrorSchema = z.object({
  response: z.object({
    status: z.literal(403),
    url: z.string().includes("/sandboxes/sessions"),
  }),
});

const serverErrorResponseSchema = z.object({
  response: z.object({ status: z.number().min(500).lt(600) }),
});

function searchableText(error: unknown): string {
  const details = getSandboxErrorDetails(error);
  return `${details.searchableText} ${details.summary}`.toLowerCase();
}

function isInvalidSandboxSessionError(error: unknown): boolean {
  return (
    invalidTokenErrorSchema.safeParse(error).success ||
    sessionForbiddenErrorSchema.safeParse(error).success
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

    return serverErrorResponseSchema.safeParse(candidate).success;
  });
}

// undici wraps a dropped connection as `TypeError: terminated` (mid-response)
// or `TypeError: fetch failed` (before a response), with the socket error as
// the cause.
const socketFailureCauseSchema = z.object({
  code: z.enum(["ECONNRESET", "UND_ERR_SOCKET"]),
});

function isFetchSocketFailure(error: Error): boolean {
  return (
    error.name === "TypeError" &&
    (error.message === "terminated" || error.message === "fetch failed") &&
    socketFailureCauseSchema.safeParse(error.cause).success
  );
}

function isCommandStreamInterrupted(error: unknown): boolean {
  return findInErrorChain(error, (candidate) => {
    if (!(candidate instanceof Error)) {
      return false;
    }

    return (
      (candidate.name === "StreamError" &&
        candidate.message
          .toLowerCase()
          .includes("stream ended before command finished")) ||
      isFetchSocketFailure(candidate)
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
