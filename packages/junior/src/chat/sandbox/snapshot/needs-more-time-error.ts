/** Stop the current job run before its request time ends. */
export class WorkspaceSnapshotNeedsMoreTimeError extends Error {
  readonly code = "workspace_snapshot_needs_more_time";
  readonly workspaceName: string;

  constructor(workspaceName: string) {
    super(`Workspace ${workspaceName} snapshot needs more time`);
    this.name = "WorkspaceSnapshotNeedsMoreTimeError";
    this.workspaceName = workspaceName;
  }
}

/** Check whether a snapshot build stopped because it needs more time. */
export function isWorkspaceSnapshotNeedsMoreTimeError(
  error: unknown,
): error is WorkspaceSnapshotNeedsMoreTimeError {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    if (current instanceof WorkspaceSnapshotNeedsMoreTimeError) return true;
    if (
      current instanceof Error &&
      (current.name === "WorkspaceSnapshotNeedsMoreTimeError" ||
        (current as { code?: string }).code ===
          "workspace_snapshot_needs_more_time")
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
