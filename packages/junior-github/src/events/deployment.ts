import type { SubscribableResource } from "@sentry/junior-plugin-api";

export const GITHUB_DEPLOYMENT_EVENTS = [
  "deployment.created",
  "deployment.queued",
  "deployment.pending",
  "deployment.in_progress",
  "deployment.succeeded",
  "deployment.failed",
  "deployment.error",
] as const;

export const GITHUB_DEPLOYMENT_SUGGESTED_EVENTS = [
  "deployment.succeeded",
  "deployment.failed",
  "deployment.error",
];

/** The identifier shape that `gitHubDeploymentSourceResource` builds. */
export const GITHUB_DEPLOYMENT_SOURCE_IDENTIFIER = {
  format:
    "deployment-source:owner/repo[:environment][:<full-commit-sha>] (environment, commit, or both; omit the commit to follow every deployment to the environment)",
  pattern: /^deployment-source:[^\s/:#]+\/[^\s/:#]+:[^\s:]+(?::[0-9a-f]+)?$/,
};

/** A deployment source names an environment, a commit, or both. */
type DeploymentSourceInput = { repo: string } & (
  | { commitSha: string; environment?: string }
  | { commitSha?: undefined; environment: string }
);

/** Build the stable deployment-source identity shared by tools and webhooks. */
export function gitHubDeploymentSourceResource(
  input: DeploymentSourceInput,
): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  const commitSha = input.commitSha?.toLowerCase();
  const environment = input.environment?.trim();
  const repo = input.repo.toLowerCase();
  const parts = [
    `deployment-source:${repo}`,
    ...(environment ? [encodeURIComponent(environment.toLowerCase())] : []),
    ...(commitSha ? [commitSha] : []),
  ];
  return {
    // Environment names are provider-controlled, so labels never include them.
    label: commitSha
      ? `GitHub deployment for ${repo} at ${commitSha.slice(0, 12)}`
      : `GitHub deployment for ${repo}`,
    namespace: "github",
    identifier: parts.join(":"),
  };
}

/** Describe a deployment source when GitHub webhooks are enabled. */
export function gitHubDeploymentSourceSubscribable(input: {
  commitSha: string;
  environment?: string;
  repo: string;
}): SubscribableResource | undefined {
  if (!process.env.GITHUB_WEBHOOK_SECRET?.trim()) return undefined;
  return {
    ...gitHubDeploymentSourceResource(input),
    suggestedEvents: GITHUB_DEPLOYMENT_SUGGESTED_EVENTS,
    supportedEvents: [...GITHUB_DEPLOYMENT_EVENTS],
    type: "deployment_source",
  };
}
