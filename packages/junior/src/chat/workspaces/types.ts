/** Provider-owned repository included in one Workspace recipe. */
export interface WorkspaceRepo {
  provider: string;
  repo: string;
}

/** Last successful Sandbox snapshot recorded for one Workspace recipe. */
export interface WorkspaceSnapshot {
  id: string;
  generatedAt: Date;
  buildDurationMs: number;
  profileHash: string;
}

export type WorkspaceSnapshotStatus = "building" | "failed" | "ready";

/** Current snapshot build for one Workspace recipe. */
export interface WorkspaceSnapshotBuild {
  status: WorkspaceSnapshotStatus;
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
  snapshotBuild?: WorkspaceSnapshotBuild | null;
}
