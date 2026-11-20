/** Name the github.com page of one watched resource, when it has one. */
export function gitHubResourceUrl(input: {
  identifier: string;
  resourceType: string;
}): string | undefined {
  if (input.resourceType === "repository") {
    return `https://github.com/${input.identifier}`;
  }
  const [repo, number] = input.identifier.split("#");
  if (!repo || !number) return undefined;
  if (input.resourceType === "pull_request") {
    return `https://github.com/${repo}/pull/${number}`;
  }
  if (input.resourceType === "issue") {
    return `https://github.com/${repo}/issues/${number}`;
  }
  return undefined;
}

const RESOURCE_PAGES = new Map([
  ["issues", "issue"],
  ["pull", "pull_request"],
]);

/**
 * Name the watched resource of one github.com page: a repository, or a pull
 * request or issue and its subpages, such as `/pull/12/files`.
 */
export function gitHubUrlResource(
  url: string,
): { identifier: string; resourceType: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    return undefined;
  }
  const [owner, repo, page, number] = parsed.pathname
    .split("/")
    .filter(Boolean);
  if (!owner || !repo) return undefined;
  const repository = `${owner}/${repo}`.toLowerCase();
  if (!page) return { identifier: repository, resourceType: "repository" };
  const resourceType = RESOURCE_PAGES.get(page);
  if (!resourceType || !number || !/^\d+$/.test(number)) return undefined;
  return { identifier: `${repository}#${number}`, resourceType };
}
