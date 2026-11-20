/**
 * Read Junior's own telemetry back from Sentry, for System page reports.
 *
 * Junior sends its telemetry to the project of `SENTRY_DSN`, so it reads only
 * that project, in the `SENTRY_ORG_SLUG` org, with the `SENTRY_READ_TOKEN` org
 * read token. Only server code calls Sentry, so the token never reaches a
 * browser.
 */

/** Settings that the telemetry reads need. */
export type SentryTelemetrySetting =
  | "SENTRY_DSN"
  | "SENTRY_ORG_SLUG"
  | "SENTRY_READ_TOKEN";

/** Where and how to read Junior's telemetry. */
export interface SentryTelemetry {
  /** API base URL, such as `https://us.sentry.io`. */
  apiUrl: string;
  org: string;
  projectId: string;
  token: string;
}

/** The answer of one telemetry read that Sentry did not fail. */
export type SentryTelemetryResponse =
  | { status: "ok"; body: unknown }
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
  return { apiUrl: apiUrlOf(url), org, projectId, token };
}

/**
 * Read one org events endpoint (`events` for tables, `events-stats` for time
 * series) for the telemetry project. Throw for any other failure.
 */
export async function readSentryTelemetry(
  telemetry: SentryTelemetry,
  endpoint: "events" | "events-stats",
  params: URLSearchParams,
): Promise<SentryTelemetryResponse> {
  const query = new URLSearchParams(params);
  query.set("project", telemetry.projectId);
  const response = await fetch(
    `${telemetry.apiUrl}/api/0/organizations/${encodeURIComponent(telemetry.org)}/${endpoint}/?${query}`,
    { headers: { authorization: `Bearer ${telemetry.token}` } },
  );
  if (response.status === 429) return { status: "rate_limited" };
  if (response.status === 401 || response.status === 403) {
    return { status: "denied" };
  }
  if (!response.ok) {
    throw new Error(
      `Sentry ${endpoint} read failed with status ${response.status}.`,
    );
  }
  return { status: "ok", body: await response.json() };
}
