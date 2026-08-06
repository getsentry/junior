import type { SubscribableResource } from "@sentry/junior-plugin-api";

export const VERCEL_DEPLOYMENT_EVENTS = [
  "deployment.succeeded",
  "deployment.error",
  "deployment.canceled",
] as const;

export const VERCEL_DEPLOYMENT_SUGGESTED_EVENTS = [
  "deployment.succeeded",
  "deployment.error",
  "deployment.canceled",
];

export type VercelDeploymentTarget = "preview" | "production" | "staging";

/** Build the stable deployment-source identity shared by tools and webhooks. */
export function vercelDeploymentSourceResource(input: {
  commitSha?: string;
  projectId: string;
  target?: VercelDeploymentTarget;
}): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  const commitSha = input.commitSha?.toLowerCase();
  const target = input.target;
  const parts = ["deployment-source", input.projectId];
  if (target) parts.push(target);
  if (commitSha) parts.push(commitSha);

  let label: string;
  if (target && commitSha) {
    label = `Vercel ${target} deployment for ${input.projectId} at ${commitSha.slice(0, 12)}`;
  } else if (target) {
    label = `Vercel ${target} deployments for ${input.projectId}`;
  } else {
    label = `Vercel deployments for ${input.projectId}`;
  }

  return {
    label,
    namespace: "vercel",
    identifier: parts.join(":"),
  };
}

/** Describe a deployment source when signed Vercel webhooks are enabled. */
export function vercelDeploymentSourceSubscribable(input: {
  commitSha?: string;
  projectId: string;
  target?: VercelDeploymentTarget;
  webhookSecret?: string;
}): SubscribableResource | undefined {
  if (!input.webhookSecret) return undefined;
  // Commit-scoped watches require a target so the identity stays unambiguous.
  if (input.commitSha && !input.target) return undefined;
  return {
    ...vercelDeploymentSourceResource(input),
    suggestedEvents: VERCEL_DEPLOYMENT_SUGGESTED_EVENTS,
    supportedEvents: [...VERCEL_DEPLOYMENT_EVENTS],
    type: "deployment_source",
  };
}
