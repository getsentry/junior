import type { Workspace } from "./types";

function copyWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    repos: workspace.repos.map((repo) => ({ ...repo })),
  };
}

function validateWorkspaces(input: readonly Workspace[]): Workspace[] {
  const ids = new Set<string>();
  const names = new Set<string>();

  return input.map((value) => {
    const workspace = copyWorkspace(value);
    if (!workspace.id.trim()) throw new Error("Workspace id must not be empty");
    if (!workspace.name.trim()) {
      throw new Error("Workspace name must not be empty");
    }
    if (ids.has(workspace.id)) {
      throw new Error(`Duplicate Workspace id: ${workspace.id}`);
    }
    if (names.has(workspace.name)) {
      throw new Error(`Duplicate Workspace name: ${workspace.name}`);
    }
    ids.add(workspace.id);
    names.add(workspace.name);

    const checkoutPaths = new Set<string>();
    let primaryRepoCount = 0;
    for (const repo of workspace.repos) {
      if (!repo.provider.trim() || !repo.repo.trim()) {
        throw new Error(
          `Workspace ${workspace.name} repository provider and name must not be empty`,
        );
      }
      if (!repo.checkoutPath.trim()) {
        throw new Error(
          `Workspace ${workspace.name} checkout path must not be empty`,
        );
      }
      if (checkoutPaths.has(repo.checkoutPath)) {
        throw new Error(
          `Workspace ${workspace.name} has duplicate checkout path: ${repo.checkoutPath}`,
        );
      }
      checkoutPaths.add(repo.checkoutPath);
      if (repo.isPrimary) primaryRepoCount += 1;
    }
    if (primaryRepoCount > 1) {
      throw new Error(
        `Workspace ${workspace.name} must not have more than one primary repository`,
      );
    }
    return workspace;
  });
}

/** Define immutable install-wide Workspace recipes. */
export function defineJuniorWorkspaces(
  input: readonly Workspace[],
): Workspace[] {
  return validateWorkspaces(input);
}
