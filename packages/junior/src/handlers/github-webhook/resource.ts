function resourceRef(repositoryFullName: string, pullRequestNumber: number) {
  return `github:pull_request:${repositoryFullName}#${pullRequestNumber}`;
}

/** Build the normalized resource identity for a GitHub pull request. */
export function gitHubPullRequestResource(input: {
  pullRequestNumber: number;
  repositoryFullName: string;
}) {
  return {
    label: `GitHub PR ${input.repositoryFullName}#${input.pullRequestNumber}`,
    resourceRef: resourceRef(input.repositoryFullName, input.pullRequestNumber),
  };
}

/** Build a stable provider retry key for one normalized GitHub event. */
export function gitHubEventKey(deliveryId: string, eventType: string): string {
  return `github:${deliveryId}:${eventType}`;
}
