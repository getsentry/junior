import * as Sentry from "@sentry/nextjs";

function getSampleRate(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getCommonOptions() {
  return {
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: getSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 1),
    profilesSampleRate: getSampleRate(process.env.SENTRY_PROFILES_SAMPLE_RATE, 0),
    sendDefaultPii: true,
    enabled: Boolean(process.env.SENTRY_DSN)
  };
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      ...getCommonOptions(),
      integrations: [Sentry.vercelAIIntegration()]
    });
    return;
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(getCommonOptions());
  }
}
