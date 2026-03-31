import * as Sentry from "@/chat/sentry";

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
  const dsn = process.env.SENTRY_DSN;
  const enableLogs = getBoolean(process.env.SENTRY_ENABLE_LOGS, Boolean(dsn));

  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ??
      process.env.VERCEL_ENV ??
      process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: getSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 1),
    sendDefaultPii: true,
    enabled: Boolean(dsn),
    _experiments: { enableLogs },
    integrations: [
      Sentry.vercelAIIntegration({
        recordInputs: true,
        recordOutputs: true,
      }),
    ],
  });
}
