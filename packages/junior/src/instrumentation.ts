import * as Sentry from "@/chat/sentry";
import {
  getDeploymentServiceVersion,
  getDeploymentTelemetryAttributes,
} from "@/deployment";

function getSampleRate(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/** Initialize Sentry for the Junior runtime. Call at the top of your entry point. */
export function initSentry(): void {
  if (Sentry.getClient()) {
    return;
  }

  const dsn = process.env.SENTRY_DSN;
  const enableLogs = getBoolean(process.env.SENTRY_ENABLE_LOGS, Boolean(dsn));
  const serviceVersion = getDeploymentServiceVersion();
  const deploymentSpanAttributes = getDeploymentTelemetryAttributes();

  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ??
      process.env.VERCEL_ENV ??
      process.env.NODE_ENV,
    release: serviceVersion,
    tracesSampleRate: getSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 1),
    sendDefaultPii: true,
    enabled: Boolean(dsn),
    enableLogs,
    registerEsmLoaderHooks: false,
    streamGenAiSpans: true,
    // Keep deployment identity centralized so every emitted Sentry span carries it.
    beforeSendSpan(span) {
      if (Object.keys(deploymentSpanAttributes).length === 0) {
        return span;
      }

      span.data = {
        ...span.data,
        ...deploymentSpanAttributes,
      };

      return span;
    },
    integrations: [
      Sentry.vercelAIIntegration({
        recordInputs: true,
        recordOutputs: true,
      }),
    ],
  });
}
