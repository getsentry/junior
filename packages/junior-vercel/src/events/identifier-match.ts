import type { EventMatch } from "@sentry/junior-plugin-api";
import {
  VERCEL_DEPLOYMENT_EVENTS,
  VERCEL_DEPLOYMENT_TARGETS,
  vercelDeploymentResource,
  type VercelDeploymentTarget,
} from "./deployment.js";

function isTarget(value: string): value is VercelDeploymentTarget {
  return (VERCEL_DEPLOYMENT_TARGETS as readonly string[]).includes(value);
}

/**
 * Turn a saved Vercel identifier into the filters that select the same
 * deployment events: `projectId`, then `target`, then `commitSha`, one for
 * each part of `projectId[:target[:commitSha]]`.
 *
 * The filters must rebuild the same identifier with the builder that the
 * webhooks use. Otherwise the identifier never got events, and filters could
 * match events that it never got.
 */
export function vercelIdentifierMatch(input: {
  identifier: string;
  eventType: string;
}): EventMatch | undefined {
  if (
    !(VERCEL_DEPLOYMENT_EVENTS as readonly string[]).includes(input.eventType)
  )
    return undefined;
  const [projectId, target, commitSha, ...rest] = input.identifier.split(":");
  if (!projectId || rest.length > 0) return undefined;
  if (target !== undefined && !isTarget(target)) return undefined;
  if (commitSha !== undefined && !/^[0-9a-f]{40}$/.test(commitSha)) {
    return undefined;
  }
  const built = vercelDeploymentResource({ projectId, target, commitSha });
  if (built.identifier !== input.identifier) return undefined;
  return {
    projectId,
    ...(target ? { target } : undefined),
    ...(commitSha ? { commitSha } : undefined),
  };
}
