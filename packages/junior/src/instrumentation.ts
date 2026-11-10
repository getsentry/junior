import * as Sentry from "@/chat/sentry";
import { subscribeGatewayRequestTiming } from "@/chat/pi/gateway-request-timing";
import {
  scrubPrivateSentryEvent,
  scrubPrivateSentryLog,
  scrubPrivateSentrySpan,
} from "@/chat/sentry-payload-filter";
import {
  getDeploymentServiceVersion,
  getDeploymentTelemetryAttributes,
} from "@/deployment";

export {
  nameRequestRoute,
  routeNameMiddleware,
} from "@/chat/sentry-route-name";

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

// Dedupe drops an error that matches the previous error in the process, even
// minutes later. Junior shows each captured turn failure's event ID to the
// person, so a dropped duplicate leaves a reference that Sentry never stored.
// The SDK still skips a second capture of the same error object without it.
const REMOVED_INTEGRATIONS = new Set([...MANUAL_GEN_AI_INTEGRATIONS, "Dedupe"]);

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

function getEnvironment(): string | undefined {
  return (
    process.env.SENTRY_ENVIRONMENT ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV
  );
}

function getTracesSampleRate(): number {
  return getSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 1);
}

/** Browser SDK settings and the current request's trace, for an HTML page. */
export interface BrowserSentryConfig {
  baggage?: string;
  dsn: string;
  environment?: string;
  release?: string;
  sentryTrace?: string;
  tracesSampleRate: number;
}

/**
 * Read the settings a served page needs to send browser spans to the same
 * project, continuing the trace of the request that rendered it.
 */
export function getBrowserSentryConfig(): BrowserSentryConfig | undefined {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return undefined;
  const trace = Sentry.getTraceData();
  return {
    baggage: trace.baggage,
    dsn,
    environment: getEnvironment(),
    release: getDeploymentServiceVersion(),
    sentryTrace: trace["sentry-trace"],
    tracesSampleRate: getTracesSampleRate(),
  };
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
    environment: getEnvironment(),
    release: serviceVersion,
    tracesSampleRate: getTracesSampleRate(),
    ignoreSpans: [
      // Vercel health checks
      { op: "http.server", attributes: { "url.path": "/_vercel/ping" } },
    ],
    dataCollection: {
      // Request and response bodies carry model prompts, webhook payloads,
      // signed callbacks, and sandbox egress content. Collect none.
      httpBodies: [],
      // Other request headers carry credentials and full upstream paths:
      // `forwarded` holds a Vercel bearer, `vercel-forwarded-path` and
      // `referer` keep query strings, and webhooks send HMAC signatures. The
      // SDK matches these terms as substrings of the header name.
      httpHeaders: {
        request: {
          allow: [
            "accept",
            "baggage",
            "content-encoding",
            "content-length",
            "content-type",
            "host",
            "sentry-trace",
            "user-agent",
            "x-github-delivery",
            "x-github-event",
            "x-slack-request-timestamp",
            "x-slack-retry",
            "x-vercel-id",
          ],
        },
      },
      urlQueryParams: false,
      // Query spans must not carry bound parameter values.
      databaseQueryData: false,
    },
    beforeSend: scrubPrivateSentryEvent,
    beforeSendLog: enableLogs ? scrubPrivateSentryLog : () => null,
    beforeSendSpan: scrubPrivateSentrySpan,
    integrations: (defaultIntegrations) =>
      defaultIntegrations.filter(
        (integration) => !REMOVED_INTEGRATIONS.has(integration.name),
      ),
  });

  // Keep deployment identity centralized so every emitted span, log, and metric carries it.
  Sentry.getGlobalScope().setAttributes(deploymentSpanAttributes);
  subscribeGatewayRequestTiming();
}
