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

/** Build the stable deployment-source identity shared by tools and webhooks. */
export function gitHubDeploymentSourceResource(input: {
  commitSha: string;
  environment?: string;
  repo: string;
}): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  const commitSha = input.commitSha.toLowerCase();
  const environment = input.environment?.trim();
  const repo = input.repo.toLowerCase();
  return {
    label: `GitHub deployment for ${repo} at ${commitSha.slice(0, 12)}`,
    namespace: "github",
    identifier: environment
      ? `deployment-source:${repo}:${encodeURIComponent(environment.toLowerCase())}:${commitSha}`
      : `deployment-source:${repo}:${commitSha}`,
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
