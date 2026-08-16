/**
 * Soft deadline hit while a Workspace snapshot is still building.
 * Complete the tool with timed_out so the agent can yield at a
 * continuable boundary and requeue. Do not throw CooperativeTurnYieldError
 * mid-tool: that parks a non-continuable assistant toolCall and fails.
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
