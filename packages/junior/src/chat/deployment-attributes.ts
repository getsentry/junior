/** Resolve deployment-scoped telemetry attributes from host environment. */
export function getDeploymentTelemetryAttributes(): Record<string, string> {
  const attributes: Record<string, string> = {};
  const serviceVersion =
    process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA;
  if (serviceVersion) {
    attributes["service.version"] = serviceVersion;
  }
  if (process.env.VERCEL_DEPLOYMENT_ID) {
    attributes["deployment.id"] = process.env.VERCEL_DEPLOYMENT_ID;
  }
  return attributes;
}
