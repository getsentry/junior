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
