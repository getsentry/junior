/**
 * Read Junior's own telemetry back from Sentry, for System page reports.
 *
 * Junior sends its telemetry to the project of `SENTRY_DSN`, so it reads only
 * that project, in the `SENTRY_ORG_SLUG` org, with the `SENTRY_READ_TOKEN` org
 * read token, through the `@sentry/api` client. Only server code calls
 * Sentry, so the token never reaches a browser.
 */
import {
  createSentryClient,
  type SdkResult,
  type SentryClient,
} from "@sentry/api";

/** Settings that the telemetry reads need. */
export type SentryTelemetrySetting =
  | "SENTRY_DSN"
  | "SENTRY_ORG_SLUG"
  | "SENTRY_READ_TOKEN";

/** Where and how to read Junior's telemetry. */
export interface SentryTelemetry {
  client: SentryClient;
  org: string;
  projectId: string;
}

/** The answer of one telemetry read that Sentry did not fail. */
export type SentryTelemetryResponse<T> =
  | { status: "ok"; data: T }
  /** Sentry rate limited the read. A later read can work. */
  | { status: "rate_limited" }
  /** The token cannot read the org or the project. */
  | { status: "denied" };

const env = (name: SentryTelemetrySetting) =>
  process.env[name]?.trim() || undefined;

// The ingest host of a SaaS DSN names the region of the API, such as
// `o1.ingest.us.sentry.io` for `us.sentry.io`. A self-hosted DSN names the
// server itself.
function apiUrlOf(dsn: URL): string {
  const region = /^o\d+\.ingest\.((?:[a-z]+\.)?sentry\.io)$/.exec(dsn.host);
  if (region) return `https://${region[1]}`;
  const prefix = dsn.pathname.split("/").slice(0, -1).join("/");
  return `${dsn.protocol}//${dsn.host}${prefix}`;
}

/**
 * Return where to read Junior's telemetry, or the settings that are missing.
 */
export function sentryTelemetry():
  | SentryTelemetry
  | { missing: SentryTelemetrySetting[] } {
  const dsn = env("SENTRY_DSN");
  const org = env("SENTRY_ORG_SLUG");
  const token = env("SENTRY_READ_TOKEN");
  const url = dsn && URL.canParse(dsn) ? new URL(dsn) : undefined;
  const projectId = url?.pathname.split("/").at(-1);
  if (!url || !projectId || !org || !token) {
    return {
      missing: [
        ...(projectId ? [] : ["SENTRY_DSN" as const]),
        ...(org ? [] : ["SENTRY_ORG_SLUG" as const]),
        ...(token ? [] : ["SENTRY_READ_TOKEN" as const]),
      ],
    };
  }
  return {
    client: createSentryClient({ baseUrl: apiUrlOf(url), auth: token }),
    org,
    projectId,
  };
}

/**
 * Return the answer of one telemetry read through the `@sentry/api` client.
 * Throw for a failure that is not a rate limit or a denied token, naming
 * `what` failed.
 */
export function telemetryResponse<T>(
  result: SdkResult<T>,
  what: string,
): SentryTelemetryResponse<T> {
  if (!("error" in result)) return { status: "ok", data: result.data };
  const status = result.response?.status;
  if (status === 429) return { status: "rate_limited" };
  if (status === 401 || status === 403) return { status: "denied" };
  throw new Error(`Sentry ${what} read failed with status ${status}.`, {
    cause: result.error,
  });
}
