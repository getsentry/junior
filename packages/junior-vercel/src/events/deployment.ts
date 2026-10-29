import {
  eventIdentifierSchema,
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

const VERCEL_DEPLOYMENT_TARGETS = ["preview", "production", "staging"] as const;

export type VercelDeploymentTarget = (typeof VERCEL_DEPLOYMENT_TARGETS)[number];

/**
 * The identifier format that `vercelDeploymentResource` builds. A commit needs
 * a target, so the commit group is inside the target group.
 */
export const VERCEL_DEPLOYMENT_IDENTIFIER = eventIdentifierSchema.parse({
  template: "{projectId}[:{target}[:{commitSha}]]",
  parts: {
    projectId: {
      kind: "string",
      description: "Vercel project ID, such as prj_123",
    },
    target: {
      kind: "string",
      description: "optional deployment target",
      enum: [...VERCEL_DEPLOYMENT_TARGETS],
    },
    commitSha: {
      kind: "hex",
      description: "optional full lowercase commit SHA. Needs a target.",
    },
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
