/** Derive the fixed sandbox checkout path for one repository. */
export function workspaceRepoCheckoutPath(repo: string): string {
  const name = repo.split("/").filter(Boolean).at(-1);
  if (
    !name ||
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    throw new Error(`Invalid repository name for checkout path: ${repo}`);
  }
  return `repos/${name}`;
}
