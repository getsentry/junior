/** Report that a Workspace snapshot is not ready to use. */
export class WorkspaceSnapshotNotReadyError extends Error {
  constructor(workspaceName: string) {
    super(`Workspace ${workspaceName} snapshot is not ready`);
    this.name = "WorkspaceSnapshotNotReadyError";
  }
}

/** Check an error and its causes for a snapshot that is not ready. */
export function isWorkspaceSnapshotNotReadyError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof WorkspaceSnapshotNotReadyError) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}
