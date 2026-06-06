import * as Sentry from "@/chat/sentry";

function getSentryOrgSlug(): string | undefined {
  const slug = process.env.SENTRY_ORG_SLUG?.trim();
  return slug || undefined;
}

function isSentrySaasDsnHost(host: string): boolean {
  return host === "sentry.io" || host.endsWith(".sentry.io");
}

function buildSentryWebBaseUrl(dsn: {
  host: string;
  path?: string;
  port?: string;
  protocol: string;
}): string {
  if (isSentrySaasDsnHost(dsn.host)) {
    return "https://sentry.io";
  }

  const port = dsn.port ? `:${dsn.port}` : "";
  const path = dsn.path ? `/${dsn.path}` : "";
  return `${dsn.protocol}://${dsn.host}${port}${path}`;
}

/** Build a Sentry conversation URL only when the runtime has enough Sentry config. */
export function buildSentryConversationUrl(
  conversationId: string,
): string | undefined {
  const client = Sentry.getClient();
  const dsn = client?.getDsn();
  if (!dsn?.host || !dsn.projectId) {
    return undefined;
  }

  const orgSlug = getSentryOrgSlug();
  if (!orgSlug) {
    return undefined;
  }

  const encodedId = encodeURIComponent(conversationId);
  const params = new URLSearchParams();
  params.set("project", dsn.projectId);

  const path = `explore/conversations/${encodedId}/?${params.toString()}`;

  if (isSentrySaasDsnHost(dsn.host)) {
    return `https://${orgSlug}.sentry.io/${path}`;
  }

  return `${buildSentryWebBaseUrl(dsn)}/organizations/${orgSlug}/${path}`;
}

/** Build a Sentry trace URL only when the runtime has enough Sentry config. */
export function buildSentryTraceUrl(traceId: string): string | undefined {
  const client = Sentry.getClient();
  const dsn = client?.getDsn();
  if (!dsn?.host || !dsn.projectId) {
    return undefined;
  }

  const orgSlug = getSentryOrgSlug();
  if (!orgSlug) {
    return undefined;
  }

  const encodedTraceId = encodeURIComponent(traceId);
  const params = new URLSearchParams();
  params.set("project", dsn.projectId);

  const path = `performance/trace/${encodedTraceId}/?${params.toString()}`;

  if (isSentrySaasDsnHost(dsn.host)) {
    return `https://${orgSlug}.sentry.io/${path}`;
  }

  return `${buildSentryWebBaseUrl(dsn)}/organizations/${orgSlug}/${path}`;
}
