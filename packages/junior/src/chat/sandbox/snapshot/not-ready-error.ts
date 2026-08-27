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

/** Plain copy for a Workspace that is still preparing. */
export function workspaceSnapshotNotReadyUserMessage(
  error: WorkspaceSnapshotNotReadyError,
): string {
  return (
    `The ${error.workspaceName} workspace is still preparing its sandbox. ` +
    "Wait for that preparation to finish, then try again."
  );
}
