import { randomUUID } from "node:crypto";
import { JUNIOR_VERSION } from "@/version";

export const JUNIOR_HEARTBEAT_ROUTE = "/api/internal/heartbeat";
export const JUNIOR_HEARTBEAT_CRON_SCHEDULE = "* * * * *";
export const JUNIOR_RETENTION_ROUTE = "/api/internal/retention";
// Retention is a dedicated daily bounded-batch cron, kept off the heartbeat
// repair loop; a purge failure must not touch execution or recovery paths.
export const JUNIOR_RETENTION_CRON_SCHEDULE = "0 4 * * *";
export const JUNIOR_AUTO_ARCHIVE_ROUTE = "/api/internal/auto-archive";
export const JUNIOR_AUTO_ARCHIVE_CRON_SCHEDULE = "17 * * * *";
export const JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE =
  "/api/internal/agent/continue";
export const JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE = "/api/internal/plugin/tasks";
export const JUNIOR_WORKSPACE_SNAPSHOT_JOB_CALLBACK_ROUTE =
  "/api/internal/workspace/snapshots";
export const JUNIOR_CACHE_WARMUP_CALLBACK_ROUTE = "/api/internal/cache/warmups";
export const JUNIOR_CONTEXT_COMPACTION_CALLBACK_ROUTE =
  "/api/internal/context/compactions";
export const LEGACY_JUNIOR_CONVERSATION_WORK_FUNCTION =
  "api/internal/agent/continue.ts";

// One id per process. Fluid compute runs many invocations in one process, so
// this shows which spans shared an instance.
const SERVICE_INSTANCE_ID = randomUUID();

function toOptionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve the deployment version used for release and telemetry correlation. */
export function getDeploymentServiceVersion(): string | undefined {
  const configuredRelease = toOptionalTrimmed(process.env.SENTRY_RELEASE);
  if (configuredRelease) {
    return configuredRelease;
  }

  const deploymentRevision = toOptionalTrimmed(
    process.env.VERCEL_GIT_COMMIT_SHA,
  );
  return deploymentRevision
    ? `${JUNIOR_VERSION}+${deploymentRevision}`
    : undefined;
}

/** Resolve deployment-scoped telemetry attributes from host environment. */
export function getDeploymentTelemetryAttributes(): Record<string, string> {
  const attributes: Record<string, string> = {};
  const serviceVersion = getDeploymentServiceVersion();
  const deploymentId = toOptionalTrimmed(process.env.VERCEL_DEPLOYMENT_ID);
  const region = toOptionalTrimmed(process.env.VERCEL_REGION);
  attributes["app.junior.version"] = JUNIOR_VERSION;
  attributes["service.instance.id"] = SERVICE_INSTANCE_ID;
  if (region) {
    attributes["cloud.region"] = region;
  }
  if (serviceVersion) {
    attributes["service.version"] = serviceVersion;
  }
  if (deploymentId) {
    attributes["deployment.id"] = deploymentId;
  }
  return attributes;
}
