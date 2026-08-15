import type { WorkspaceReport } from "@sentry/junior/api/schema";

export type RepoDraft = {
  key: string;
  provider: string;
  repo: string;
};

export type WorkspaceDraft = {
  name: string;
  setupScript: string;
  prebuild: boolean;
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
    prebuild: false,
    repos: [createRepoDraft()],
  };
}

export function editWorkspaceDraft(workspace: WorkspaceReport): WorkspaceDraft {
  return {
    name: workspace.name,
    setupScript: workspace.setupScript,
    prebuild: workspace.prebuild,
    repos:
      workspace.repos.length > 0
        ? workspace.repos.map((repo) => ({
            // Stable keys keep focused inputs mounted across draft reseeds.
            key: `${repo.provider}:${repo.repo.toLowerCase()}`,
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
    prebuild: draft.prebuild,
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
