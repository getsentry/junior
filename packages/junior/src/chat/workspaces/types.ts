export interface WorkspaceRepo {
  provider: string;
  repo: string;
  checkoutPath: string;
  isPrimary: boolean;
}

/** Named recipe used to prepare reusable sandbox contents. */
export interface Workspace {
  id: string;
  name: string;
  setupScript: string;
  updatedAt: Date;
  repos: WorkspaceRepo[];
}
