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
  VERCEL_DEPLOYMENT_TARGETS,
  vercelDeploymentResource,
  type VercelDeploymentTarget,
} from "../events/deployment.js";

const deploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]+$/);
const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i)
  .transform((sha) => sha.toLowerCase());

// Vercel sends `null` for preview deployments. Other unknown targets fail the
// parse, so the delivery is ignored.
const deploymentTargetSchema = z
  .string()
  .nullable()
  .transform((target) => target ?? "preview")
  .pipe(z.enum(VERCEL_DEPLOYMENT_TARGETS));

// Each Git provider writes the commit SHA to a different metadata key.
const COMMIT_SHA_META_KEYS = [
  "githubCommitSha",
  "gitlabCommitSha",
  "bitbucketCommitSha",
  "gitCommitSha",
] as const;

// Read only the fields used for routing. Vercel sends more fields than its docs
// list, so unknown fields must not reject the webhook.
const webhookEnvelopeSchema = z.object({
  createdAt: z.number().finite(),
  id: z.string().min(1),
  payload: z.unknown(),
  type: z.enum(VERCEL_DEPLOYMENT_EVENTS),
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
    target: deploymentTargetSchema,
  })
  .transform((payload) => ({
    commitSha: commitSha(payload.deployment.meta),
    deploymentId: payload.deployment.id,
    projectId: payload.project.id,
    target: payload.target,
  }));

function commitSha(meta: Record<string, unknown>): string | undefined {
  for (const key of COMMIT_SHA_META_KEYS) {
    const parsed = commitShaSchema.safeParse(meta[key]);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

const DEPLOYMENT_OUTCOMES = {
  "deployment.succeeded": "succeeded",
  "deployment.error": "failed",
  "deployment.canceled": "was canceled",
} satisfies Record<(typeof VERCEL_DEPLOYMENT_EVENTS)[number], string>;

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

/**
 * Normalize one verified Vercel delivery into deployment events. Target,
 * commit, and deployment id come from Vercel, so they go in trusted data.
 */
export function normalizeVercelEvents(args: { body: unknown }): EventInput[] {
  const envelope = webhookEnvelopeSchema.safeParse(args.body);
  if (!envelope.success) return [];
  const payload = deploymentPayloadSchema.safeParse(envelope.data.payload);
  if (!payload.success) return [];

  const eventType = envelope.data.type;
  const { commitSha, deploymentId, projectId, target } = payload.data;
  const data = {
    deploymentId,
    target,
    ...(commitSha ? { commitSha } : undefined),
  };

  return deploymentTargets({ commitSha, projectId, target }).map(
    ({ completeOnTerminalEvent, resource }): EventInput => ({
      data,
      eventKey: `vercel:${envelope.data.id}:${eventType}`,
      eventType,
      identifier: resource.identifier,
      objectType: "deployment",
      occurredAtMs: envelope.data.createdAt,
      ...(completeOnTerminalEvent ? { terminal: true } : undefined),
      trustedSummary: `${resource.label} (${deploymentId}) ${DEPLOYMENT_OUTCOMES[eventType]}.`,
    }),
  );
}
