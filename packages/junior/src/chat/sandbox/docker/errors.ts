import { findInErrorChain } from "@/chat/sandbox/errors";
import { DockerApiError } from "@/chat/sandbox/docker/api";
import type { SandboxErrorChecks } from "@/chat/sandbox/provider";

// Module overview: sort Docker Engine API errors into the cases that shared
// sandbox code handles.

function apiError(
  error: unknown,
  match: (candidate: DockerApiError) => boolean,
): boolean {
  return findInErrorChain(
    error,
    (candidate) => candidate instanceof DockerApiError && match(candidate),
  );
}

function isMissingContainer(candidate: DockerApiError): boolean {
  return (
    (candidate.statusCode === 404 &&
      /no such container/i.test(candidate.message)) ||
    // A stopped auto-remove container is about to go away.
    (candidate.statusCode === 409 &&
      /marked for removal|removal .*in progress/i.test(candidate.message))
  );
}

function isUnavailable(error: unknown): boolean {
  return apiError(
    error,
    (candidate) =>
      isMissingContainer(candidate) ||
      (candidate.statusCode === 409 &&
        /is not running|is paused|restarting/i.test(candidate.message)),
  );
}

function isMissing(error: unknown): boolean {
  return apiError(error, isMissingContainer);
}

function isSnapshotMissing(error: unknown): boolean {
  return apiError(
    error,
    (candidate) =>
      candidate.statusCode === 404 && /no such image/i.test(candidate.message),
  );
}

function isTransient(error: unknown): boolean {
  // Docker also returns 5xx for errors that do not go away, so only a lost
  // connection to the daemon counts as short.
  return findInErrorChain(error, (candidate) => {
    const code = (candidate as NodeJS.ErrnoException | null)?.code;
    return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE";
  });
}

/** Map Docker Engine API errors to the shared sandbox error cases. */
export const dockerSandboxErrors: SandboxErrorChecks = {
  isUnavailable,
  isMissing,
  isSnapshotMissing,
  // `docker commit` finishes before it returns, so a snapshot is never still
  // being captured when a sandbox boots from it.
  isSnapshotting: () => false,
  isTransient,
  // Exec output streams end only when the command ends.
  isCommandStreamInterrupted: () => false,
};
