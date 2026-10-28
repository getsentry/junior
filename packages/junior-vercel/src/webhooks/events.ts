/**
 * Owns Vercel's deployment webhook wire-format boundary.
 *
 * It validates webhook payloads, ignores unsupported or incomplete deliveries,
 * and emits canonical events for project, target, and commit watches.
 */
import type { EventInput } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { vercelProjectIdSchema } from "../project.js";
import {
  VERCEL_DEPLOYMENT_EVENTS,
  vercelDeploymentResource,
  type VercelDeploymentTarget,
} from "../events/deployment.js";

const deploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);

// Read only the fields used for routing. Vercel sends more fields than its docs
// list, so unknown fields must not reject the webhook.
const webhookEnvelopeSchema = z.object({
  createdAt: z.number().finite(),
  id: z.string().min(1),
  payload: z.unknown(),
  type: z.string().min(1),
});

const deploymentPayloadSchema = z
  .object({
    deployment: z.object({
      id: deploymentIdSchema,
      meta: z.record(z.string(), z.unknown()),
    }),
    project: z.object({
      id: vercelProjectIdSchema,
    }),
    target: z.string().nullable(),
  })
  .transform((payload) => ({
    commitSha: commitSha(payload.deployment.meta),
    deploymentId: payload.deployment.id,
    projectId: payload.project.id,
    target: deploymentTarget(payload.target),
  }));

function deploymentTarget(
  value: string | null,
): VercelDeploymentTarget | undefined {
  if (value === null) return "preview";
  if (value === "production" || value === "staging") return value;
  return undefined;
}

function commitSha(meta: Record<string, unknown>): string | undefined {
  for (const key of [
    "githubCommitSha",
    "gitlabCommitSha",
    "bitbucketCommitSha",
    "gitCommitSha",
  ]) {
    const parsed = commitShaSchema.safeParse(meta[key]);
    if (parsed.success) return parsed.data.toLowerCase();
  }
  return undefined;
}

function isDeploymentEvent(
  value: string,
): value is (typeof VERCEL_DEPLOYMENT_EVENTS)[number] {
  return VERCEL_DEPLOYMENT_EVENTS.includes(
    value as (typeof VERCEL_DEPLOYMENT_EVENTS)[number],
  );
}

/** Address one deployment through project, target, and optional commit watches. */
function deploymentTargets(input: {
  commitSha?: string;
  projectId: string;
  target: VercelDeploymentTarget;
}) {
  const targets = [
    {
      completeOnTerminalEvent: false,
      resource: vercelDeploymentResource({
        projectId: input.projectId,
      }),
    },
    {
      completeOnTerminalEvent: false,
      resource: vercelDeploymentResource({
        projectId: input.projectId,
        target: input.target,
      }),
    },
  ];
  if (input.commitSha) {
    targets.push({
      completeOnTerminalEvent: true,
      resource: vercelDeploymentResource({
        commitSha: input.commitSha,
        projectId: input.projectId,
        target: input.target,
      }),
    });
  }
  return targets;
}

/** Normalize one verified Vercel delivery into deployment events. */
export function normalizeVercelEvents(args: { body: unknown }): EventInput[] {
  const envelope = webhookEnvelopeSchema.safeParse(args.body);
  if (!envelope.success || !isDeploymentEvent(envelope.data.type)) return [];
  const payload = deploymentPayloadSchema.safeParse(envelope.data.payload);
  if (!payload.success) return [];
  const target = payload.data.target;
  if (!target) return [];

  const eventType = envelope.data.type;
  const deploymentId = payload.data.deploymentId;
  const outcome =
    eventType === "deployment.succeeded"
      ? "succeeded"
      : eventType === "deployment.error"
        ? "failed"
        : "was canceled";
  const untrustedParts = [
    `Target: ${target}`,
    payload.data.commitSha ? `Commit: ${payload.data.commitSha}` : undefined,
    `Deployment: ${deploymentId}`,
  ].filter((part): part is string => part !== undefined);
  const untrustedText = untrustedParts.join("\n");

  return deploymentTargets({
    commitSha: payload.data.commitSha,
    projectId: payload.data.projectId,
    target,
  }).map(({ completeOnTerminalEvent, resource }) => ({
    eventKey: `vercel:${envelope.data.id}:${eventType}`,
    eventType,
    occurredAtMs: envelope.data.createdAt,
    identifier: resource.identifier,
    ...(completeOnTerminalEvent ? { terminal: true } : undefined),
    trustedSummary: `${resource.label} (${deploymentId}) ${outcome}.`,
    untrustedText,
  }));
}
