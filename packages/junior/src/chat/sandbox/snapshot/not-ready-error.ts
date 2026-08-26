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
