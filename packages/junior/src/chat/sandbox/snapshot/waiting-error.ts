/**
 * Soft deadline hit while a Workspace snapshot is still building.
 * Used by the background job to requeue; not a tool-facing contract.
 */
export class WorkspaceSnapshotWaitingError extends Error {
  readonly code = "workspace_snapshot_waiting";
  readonly workspaceName: string;

  constructor(workspaceName: string) {
    super(
      `Workspace ${workspaceName} snapshot is still building; yielded for requeue`,
    );
    this.name = "WorkspaceSnapshotWaitingError";
    this.workspaceName = workspaceName;
  }
}

/** True when an error chain contains the Workspace snapshot wait signal. */
export function isWorkspaceSnapshotWaitingError(
  error: unknown,
): error is WorkspaceSnapshotWaitingError {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    if (current instanceof WorkspaceSnapshotWaitingError) return true;
    if (
      current instanceof Error &&
      (current.name === "WorkspaceSnapshotWaitingError" ||
        (current as { code?: string }).code === "workspace_snapshot_waiting")
    ) {
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
