import type { WorkspaceReport } from "@sentry/junior/api/schema";

export type RepoDraft = {
  key: string;
  provider: string;
  repo: string;
};

export type WorkspaceDraft = {
  name: string;
  setupScript: string;
  repos: RepoDraft[];
};

export function createRepoDraft(): RepoDraft {
  return {
    key: crypto.randomUUID(),
    provider: "github",
    repo: "",
  };
}

export function createWorkspaceDraft(): WorkspaceDraft {
  return {
    name: "",
    setupScript: "",
    repos: [createRepoDraft()],
  };
}

export function editWorkspaceDraft(workspace: WorkspaceReport): WorkspaceDraft {
  return {
    name: workspace.name,
    setupScript: workspace.setupScript,
    repos:
      workspace.repos.length > 0
        ? workspace.repos.map((repo) => ({
            key: crypto.randomUUID(),
            provider: repo.provider,
            repo: repo.repo,
          }))
        : [createRepoDraft()],
  };
}

export function workspaceDraftBody(draft: WorkspaceDraft) {
  return {
    name: draft.name.trim(),
    setupScript: draft.setupScript,
    repos: draft.repos.map((repo) => ({
      provider: repo.provider.trim(),
      repo: repo.repo.trim(),
    })),
  };
}

export function canSaveWorkspaceDraft(
  draft: WorkspaceDraft,
  busy: boolean,
): boolean {
  if (busy || !draft.name.trim()) return false;
  if (draft.repos.some((repo) => !repo.provider.trim() || !repo.repo.trim())) {
    return false;
  }
  return true;
}
