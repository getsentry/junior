import type { SubscribableResource } from "@sentry/junior-plugin-api";

export const VERCEL_DEPLOYMENT_EVENTS = [
  "deployment.succeeded",
  "deployment.error",
  "deployment.canceled",
] as const;

export type VercelDeploymentTarget = "preview" | "production" | "staging";

/** Build the stable deployment-source identity shared by tools and webhooks. */
export function vercelDeploymentSourceResource(input: {
  commitSha: string;
  projectId: string;
  target: VercelDeploymentTarget;
}): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  const commitSha = input.commitSha.toLowerCase();
  return {
    label: `Vercel ${input.target} deployment for ${input.projectId} at ${commitSha.slice(0, 12)}`,
    namespace: "vercel",
    identifier: `deployment-source:${input.projectId}:${input.target}:${commitSha}`,
  };
}

/** Describe a deployment source when signed Vercel webhooks are enabled. */
export function vercelDeploymentSourceSubscribable(input: {
  commitSha: string;
  projectId: string;
  target: VercelDeploymentTarget;
  webhookSecret?: string;
}): SubscribableResource | undefined {
  if (!input.webhookSecret) return undefined;
  return {
    ...vercelDeploymentSourceResource(input),
    suggestedEvents: [...VERCEL_DEPLOYMENT_EVENTS],
    supportedEvents: [...VERCEL_DEPLOYMENT_EVENTS],
    type: "deployment_source",
  };
}
