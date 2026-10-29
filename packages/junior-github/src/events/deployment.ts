import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";

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

/** Trusted deployment values that watches and event automations can match. */
export const GITHUB_DEPLOYMENT_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  environment: {
    kind: "string",
    description: "lowercase deployment environment name, such as production",
  },
  workflowId: {
    kind: "number",
    description:
      "numeric GitHub Actions workflow id when a workflow created the deployment",
  },
  workflowPath: {
    kind: "string",
    description:
      "GitHub Actions workflow file, such as .github/workflows/deploy.yml, when a workflow created the deployment",
  },
});

/** The identifier shape that `gitHubDeploymentSourceResource` builds. */
export const GITHUB_DEPLOYMENT_SOURCE_IDENTIFIER = {
  format: "deployment-source:owner/repo[:environment]:<full-commit-sha>",
  pattern: String.raw`^deployment-source:[^\s/:#]+\/[^\s/:#]+(?::[^\s:]+)?:[0-9a-f]+$`,
};

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

/**
 * Describe a deployment source that a conversation can watch.
 * Return undefined when the host cannot create Watches.
 */
export function gitHubDeploymentSourceSubscribable(input: {
  /** `ctx.events.canSubscribe` from the tool context. */
  canSubscribe: boolean;
  commitSha: string;
  environment?: string;
  repo: string;
}): SubscribableResource | undefined {
  if (!input.canSubscribe) return undefined;
  return {
    ...gitHubDeploymentSourceResource(input),
    suggestedEvents: GITHUB_DEPLOYMENT_SUGGESTED_EVENTS,
    supportedEvents: [...GITHUB_DEPLOYMENT_EVENTS],
    type: "deployment_source",
  };
}
