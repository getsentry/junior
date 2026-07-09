export const JUNIOR_HEARTBEAT_ROUTE = "/api/internal/heartbeat";
export const JUNIOR_HEARTBEAT_CRON_SCHEDULE = "* * * * *";
export const JUNIOR_RETENTION_ROUTE = "/api/internal/retention";
// Retention is a dedicated daily bounded-batch cron, kept off the heartbeat
// repair loop; a purge failure must not touch execution or recovery paths.
export const JUNIOR_RETENTION_CRON_SCHEDULE = "0 4 * * *";
export const JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE =
  "/api/internal/agent/continue";
export const JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE = "/api/internal/plugin/tasks";
export const LEGACY_JUNIOR_CONVERSATION_WORK_FUNCTION =
  "api/internal/agent/continue.ts";

function toOptionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve the deployment version used for release and telemetry correlation. */
export function getDeploymentServiceVersion(): string | undefined {
  return (
    toOptionalTrimmed(process.env.SENTRY_RELEASE) ??
    toOptionalTrimmed(process.env.VERCEL_GIT_COMMIT_SHA)
  );
}

/** Resolve deployment-scoped telemetry attributes from host environment. */
export function getDeploymentTelemetryAttributes(): Record<string, string> {
  const attributes: Record<string, string> = {};
  const serviceVersion = getDeploymentServiceVersion();
  const deploymentId = toOptionalTrimmed(process.env.VERCEL_DEPLOYMENT_ID);
  if (serviceVersion) {
    attributes["service.version"] = serviceVersion;
  }
  if (deploymentId) {
    attributes["deployment.id"] = deploymentId;
  }
  return attributes;
}
