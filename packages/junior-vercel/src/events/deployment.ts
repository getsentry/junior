import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";

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

/** The deployment targets that Vercel webhooks report. */
export const VERCEL_DEPLOYMENT_TARGETS = [
  "preview",
  "production",
  "staging",
] as const;

export type VercelDeploymentTarget = (typeof VERCEL_DEPLOYMENT_TARGETS)[number];

/**
 * Trusted values that every Vercel deployment event sets. `commitSha` is left
 * out when the deployment has no Git commit, so a filter on it does not match.
 * Vercel ids keep the case that Vercel sends, the same as identifiers,
 * because they are case-sensitive.
 */
export const VERCEL_DEPLOYMENT_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  projectId: {
    kind: "string",
    description: "Vercel project id, such as prj_abc123",
    events: [...VERCEL_DEPLOYMENT_EVENTS],
  },
  deploymentId: {
    kind: "string",
    description: "Vercel deployment id, such as dpl_abc123",
    events: [...VERCEL_DEPLOYMENT_EVENTS],
  },
  target: {
    kind: "string",
    description: "where Vercel deployed: preview, production, or staging",
    enum: [...VERCEL_DEPLOYMENT_TARGETS],
    events: [...VERCEL_DEPLOYMENT_EVENTS],
  },
  commitSha: {
    kind: "string",
    description:
      "full lowercase Git commit SHA of the deployment, when it came from a Git commit",
    events: [...VERCEL_DEPLOYMENT_EVENTS],
  },
});

/** Build the stable deployment identity shared by tools and webhooks. */
export function vercelDeploymentResource(input: {
  commitSha?: string;
  projectId: string;
  target?: VercelDeploymentTarget;
}): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  const commitSha = input.commitSha?.toLowerCase();
  const target = input.target;
  const parts = [input.projectId];
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

/**
 * Describe a deployment resource that a conversation can watch.
 * Return undefined when the host cannot create Watches.
 */
export function vercelDeploymentSubscribable(input: {
  /** `ctx.events.canSubscribe` from the tool context. */
  canSubscribe: boolean;
  commitSha?: string;
  projectId: string;
  target?: VercelDeploymentTarget;
}): SubscribableResource | undefined {
  if (!input.canSubscribe) return undefined;
  // Commit-scoped watches require a target so the identity stays unambiguous.
  if (input.commitSha && !input.target) return undefined;
  return {
    ...vercelDeploymentResource(input),
    suggestedEvents: VERCEL_DEPLOYMENT_SUGGESTED_EVENTS,
    supportedEvents: [...VERCEL_DEPLOYMENT_EVENTS],
    type: "deployment",
  };
}
