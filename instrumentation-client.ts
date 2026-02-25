import * as Sentry from "@sentry/nextjs";

function getSampleRate(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  tracesSampleRate: getSampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 1),
  profilesSampleRate: getSampleRate(process.env.NEXT_PUBLIC_SENTRY_PROFILES_SAMPLE_RATE, 0),
  sendDefaultPii: true,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN)
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
