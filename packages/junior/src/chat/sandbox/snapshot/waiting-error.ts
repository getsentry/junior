/**
 * Soft deadline hit while a Workspace snapshot is still building.
 * The tool returns timed_out so the host can yield at a tool-result boundary.
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

/** True when a structured tool result is a soft Workspace snapshot wait. */
export function isWorkspaceSnapshotWaitingResult(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return false;
  }
  const record = details as {
    timed_out?: unknown;
    waiting?: unknown;
    workspace?: { name?: unknown };
  };
  return (
    record.timed_out === true &&
    record.waiting === "workspace_snapshot" &&
    typeof record.workspace?.name === "string" &&
    record.workspace.name.length > 0
  );
}

/** Workspace name from a soft-wait tool result, if present. */
export function workspaceNameFromWaitingResult(
  details: unknown,
): string | undefined {
  if (!isWorkspaceSnapshotWaitingResult(details)) return undefined;
  const name = (details as { workspace?: { name?: unknown } }).workspace?.name;
  return typeof name === "string" ? name : undefined;
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
