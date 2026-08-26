/** Report that a Workspace snapshot is not ready to use. */
export class WorkspaceSnapshotNotReadyError extends Error {
  readonly workspaceName: string;

  constructor(workspaceName: string) {
    super(`Workspace ${workspaceName} snapshot is not ready`);
    this.name = "WorkspaceSnapshotNotReadyError";
    this.workspaceName = workspaceName;
  }
}

/** Return the typed not-ready error from an error chain, if any. */
export function getWorkspaceSnapshotNotReadyError(
  error: unknown,
): WorkspaceSnapshotNotReadyError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof WorkspaceSnapshotNotReadyError) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

/** Check an error and its causes for a snapshot that is not ready. */
export function isWorkspaceSnapshotNotReadyError(error: unknown): boolean {
  return getWorkspaceSnapshotNotReadyError(error) !== undefined;
}

/** Explain a not-ready Workspace snapshot in plain language. */
export function getWorkspaceSnapshotNotReadyUserMessage(
  error: unknown,
): string | undefined {
  const notReady = getWorkspaceSnapshotNotReadyError(error);
  if (!notReady) return undefined;
  return (
    `The ${notReady.workspaceName} workspace is still preparing its sandbox. ` +
    "Wait for that preparation to finish, then try again."
  );
}

/** Build the user-facing turn reply for a not-ready Workspace snapshot. */
export function buildWorkspaceSnapshotNotReadyResponse(
  error: unknown,
  eventId: string,
): string | undefined {
  const message = getWorkspaceSnapshotNotReadyUserMessage(error);
  if (!message) return undefined;
  return `${message} Reference: \`event_id=${eventId}\`.`;
}
