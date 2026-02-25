import * as Sentry from "@sentry/nextjs";

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

function getCommonOptions() {
  const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
  const enableLogs = getBoolean(process.env.SENTRY_ENABLE_LOGS, Boolean(dsn));
  return {
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: getSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 1),
    profilesSampleRate: getSampleRate(process.env.SENTRY_PROFILES_SAMPLE_RATE, 0),
    sendDefaultPii: true,
    enabled: Boolean(dsn),
    enableLogs
  };
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      ...getCommonOptions(),
      integrations: [Sentry.vercelAIIntegration(), Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] })]
    });
    return;
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(getCommonOptions());
  }
}
