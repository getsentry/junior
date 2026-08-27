/** Report that a Workspace snapshot is not ready to use. */
export class WorkspaceSnapshotNotReadyError extends Error {
  readonly workspaceName: string;

  constructor(workspaceName: string) {
    super(`Workspace ${workspaceName} snapshot is not ready`);
    this.name = "WorkspaceSnapshotNotReadyError";
    this.workspaceName = workspaceName;
  }
}

/** Find WorkspaceSnapshotNotReadyError in an error cause chain. */
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

/** True when the error chain includes WorkspaceSnapshotNotReadyError. */
export function isWorkspaceSnapshotNotReadyError(error: unknown): boolean {
  return getWorkspaceSnapshotNotReadyError(error) !== undefined;
}

/** Plain user copy for a Workspace that is still preparing. */
export function workspaceSnapshotNotReadyUserMessage(
  error: WorkspaceSnapshotNotReadyError,
): string {
  return (
    `The ${error.workspaceName} workspace is still preparing its sandbox. ` +
    "Wait for that preparation to finish, then try again."
  );
}

/** Plain user copy when a not-ready Workspace error is present. */
export function getWorkspaceSnapshotNotReadyUserMessage(
  error: unknown,
): string | undefined {
  const notReady = getWorkspaceSnapshotNotReadyError(error);
  return notReady ? workspaceSnapshotNotReadyUserMessage(notReady) : undefined;
}

/** User-facing turn reply for a still-preparing Workspace. */
export function buildWorkspaceSnapshotNotReadyResponse(
  error: unknown,
  eventId: string,
): string | undefined {
  const message = getWorkspaceSnapshotNotReadyUserMessage(error);
  if (!message) return undefined;
  return `${message} Reference: \`event_id=${eventId}\`.`;
}
