/** Derive the fixed sandbox checkout path for one repository, or undefined when invalid. */
export function tryWorkspaceRepoCheckoutPath(repo: string): string | undefined {
  const name = repo.split("/").filter(Boolean).at(-1);
  if (
    !name ||
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    return undefined;
  }
  return `repos/${name}`;
}

/** Derive the fixed sandbox checkout path for one repository. */
export function workspaceRepoCheckoutPath(repo: string): string {
  const path = tryWorkspaceRepoCheckoutPath(repo);
  if (!path) {
    throw new Error(`Invalid repository name for checkout path: ${repo}`);
  }
  return path;
}
