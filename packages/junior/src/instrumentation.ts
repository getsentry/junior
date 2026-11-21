import * as Sentry from "@/chat/sentry";
import { getCurrentConversationPrivacy } from "@/chat/conversation-privacy";
import { getLogContextAttributesForSpan } from "@/chat/logging";
import { setChatSpanEndAttributes } from "@/chat/pi/chat-span";
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
    process.env["SENTRY_ENVIRONMENT"] ??
    process.env["VERCEL_ENV"] ??
    process.env["NODE_ENV"]
  );
}

function getTracesSampleRate(): number {
  return getSampleRate(process.env["SENTRY_TRACES_SAMPLE_RATE"], 1);
}

/** Browser SDK settings and the current request's trace, for an HTML page. */
export interface BrowserSentryConfig {
  baggage?: string | undefined;
  dsn: string;
  environment?: string | undefined;
  release?: string | undefined;
  sentryTrace?: string | undefined;
  tracesSampleRate: number;
}

/**
 * Read the settings a served page needs to send browser spans to the same
 * project, continuing the trace of the request that rendered it.
 */
export function getBrowserSentryConfig(): BrowserSentryConfig | undefined {
  const dsn = process.env["SENTRY_DSN"]?.trim();
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

// The AI integrations record prompts and responses only for public
// Conversations. They decide when each call starts.
const recordAiContent = () => getCurrentConversationPrivacy() === "public";

// Runs for every AI SDK span, in the async context of the call. The spans are
// not Junior agent spans, so they get no `gen_ai.agent.name`.
function setAiSdkSpanAttributes(span: Sentry.Span): void {
  span.setAttributes({
    ...getLogContextAttributesForSpan("gen_ai.chat"),
    "app.conversation.privacy": getCurrentConversationPrivacy() ?? "private",
  });
}

/** Initialize Sentry for the Junior runtime. Call at the top of your entry point. */
export function initSentry(): void {
  if (Sentry.getClient()) {
    return;
  }

  const dsn = process.env["SENTRY_DSN"];
  // `SENTRY_SPOTLIGHT` sends events to a local server, such as the Sentry
  // Local server that `pnpm dev` starts. Logs go there too.
  const enableLogs = getBoolean(
    process.env["SENTRY_ENABLE_LOGS"],
    Boolean(dsn || process.env["SENTRY_SPOTLIGHT"]?.trim()),
  );
  const serviceVersion = getDeploymentServiceVersion();
  const deploymentSpanAttributes = getDeploymentTelemetryAttributes();

  Sentry.init({
    dsn,
    environment: getEnvironment(),
    release: serviceVersion,
    tracesSampleRate: getTracesSampleRate(),
    integrations: [
      Sentry.piAiIntegration({
        recordInputs: recordAiContent,
        recordOutputs: recordAiContent,
        onSpanEnd: setChatSpanEndAttributes,
      }),
      Sentry.vercelAIIntegration({
        recordInputs: recordAiContent,
        recordOutputs: recordAiContent,
        onSpanStart: setAiSdkSpanAttributes,
      }),
    ],
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
  });

  // Keep deployment identity centralized so every emitted span, log, and metric carries it.
  Sentry.getGlobalScope().setAttributes(deploymentSpanAttributes);
  // `beforeSend` sees only error events. User feedback from `submitFeedback`
  // carries the same request and breadcrumb data, so scrub it the same way.
  Sentry.getGlobalScope().addEventProcessor((event) =>
    event.type === "feedback" ? scrubPrivateSentryEvent(event) : event,
  );
  subscribeGatewayRequestTiming();
}
