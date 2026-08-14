/** Provider-owned repository included in one Workspace recipe. */
export interface WorkspaceRepo {
  provider: string;
  repo: string;
  isPrimary: boolean;
}

/** Named recipe used to prepare reusable sandbox contents. */
export interface Workspace {
  id: string;
  name: string;
  setupScript: string;
  repos: WorkspaceRepo[];
}
