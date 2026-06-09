function toOptionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve deployment-scoped telemetry attributes from host environment. */
export function getDeploymentTelemetryAttributes(): Record<string, string> {
  const attributes: Record<string, string> = {};
  const serviceVersion =
    toOptionalTrimmed(process.env.SENTRY_RELEASE) ??
    toOptionalTrimmed(process.env.VERCEL_GIT_COMMIT_SHA);
  const deploymentId = toOptionalTrimmed(process.env.VERCEL_DEPLOYMENT_ID);
  if (serviceVersion) {
    attributes["service.version"] = serviceVersion;
  }
  if (deploymentId) {
    attributes["deployment.id"] = deploymentId;
  }
  return attributes;
}
