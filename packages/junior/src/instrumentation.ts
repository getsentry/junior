import * as Sentry from "@/chat/sentry";
import {
  scrubPrivateSentryEvent,
  scrubPrivateSentryLog,
  scrubPrivateSentrySpan,
} from "@/chat/sentry-payload-filter";
import {
  getDeploymentServiceVersion,
  getDeploymentTelemetryAttributes,
} from "@/deployment";

// Junior records its own gen_ai spans with usage and cost. These SDK spans
// would duplicate them, and Pi reads provider streams itself, so they have no
// usage. Remove this filter after getsentry/sentry-javascript#25869.
const MANUAL_GEN_AI_INTEGRATIONS = new Set([
  "Anthropic_AI",
  "Google_GenAI",
  "Groq",
  "Mistral",
  "OpenAI",
  "TogetherAI",
  "VercelAI",
]);

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
    dataCollection: {
      // Outgoing calls carry model prompts and provider responses that the
      // payload filter cannot see. Keep only incoming request bodies.
      httpBodies: ["incomingRequest"],
      // Query spans must not carry bound parameter values.
      databaseQueryData: false,
    },
    beforeSend: scrubPrivateSentryEvent,
    beforeSendLog: enableLogs ? scrubPrivateSentryLog : () => null,
    beforeSendSpan: scrubPrivateSentrySpan,
    integrations: (defaultIntegrations) =>
      defaultIntegrations.filter(
        (integration) => !MANUAL_GEN_AI_INTEGRATIONS.has(integration.name),
      ),
  });

  // Keep deployment identity centralized so every emitted span, log, and metric carries it.
  Sentry.getGlobalScope().setAttributes(deploymentSpanAttributes);
}
