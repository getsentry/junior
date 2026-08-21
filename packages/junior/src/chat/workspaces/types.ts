/** Provider-owned repository included in one Workspace recipe. */
export interface WorkspaceRepo {
  provider: string;
  repo: string;
}

/** Ready Sandbox snapshot artifact owned by one Workspace recipe. */
export interface WorkspaceSnapshot {
  id: string;
  generatedAt: Date;
  buildDurationMs: number;
  profileHash: string;
}

export type WorkspaceSnapshotBuildStatus = "building" | "failed";
export type WorkspaceSnapshotStatus = WorkspaceSnapshotBuildStatus | "ready";
export type WorkspaceSnapshotBuildPhase =
  | "created"
  | "dependencies_installed"
  | "repositories_prepared";

/** Current snapshot build for one Workspace recipe. */
export interface WorkspaceSnapshotBuild {
  id: string;
  status: WorkspaceSnapshotBuildStatus;
  phase: WorkspaceSnapshotBuildPhase;
  profileHash: string;
  startedAt: Date;
  sandboxName: string | null;
  commandId: string | null;
  error: string | null;
}

/** Named recipe used to prepare reusable sandbox contents. */
export interface Workspace {
  id: string;
  name: string;
  setupScript: string;
  repos: WorkspaceRepo[];
  snapshot: WorkspaceSnapshot | null;
}
