/** Report that a Workspace snapshot is not ready to use. */
export class WorkspaceSnapshotNotReadyError extends Error {
  readonly workspaceName: string;

  constructor(workspaceName: string) {
    super(`Workspace ${workspaceName} snapshot is not ready`);
    this.name = "WorkspaceSnapshotNotReadyError";
    this.workspaceName = workspaceName;
  }
}

/** Return WorkspaceSnapshotNotReadyError from this error or its causes. */
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

/** True when this error or a cause is WorkspaceSnapshotNotReadyError. */
export function isWorkspaceSnapshotNotReadyError(error: unknown): boolean {
  return getWorkspaceSnapshotNotReadyError(error) !== undefined;
}

/** User message when a Workspace sandbox is still preparing. */
export function workspaceSnapshotNotReadyUserMessage(
  error: WorkspaceSnapshotNotReadyError,
): string {
  return (
    `The ${error.workspaceName} workspace is still preparing its sandbox. ` +
    "Wait for that preparation to finish, then try again."
  );
}
