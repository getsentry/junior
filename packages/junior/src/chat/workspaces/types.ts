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

/** Named recipe used to prepare reusable sandbox contents. */
export interface Workspace {
  id: string;
  name: string;
  setupScript: string;
  /** Build this Workspace snapshot in background work when the app starts. */
  prebuild?: boolean;
  repos: WorkspaceRepo[];
  snapshot: WorkspaceSnapshot | null;
}
