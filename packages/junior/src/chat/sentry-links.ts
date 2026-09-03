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

function buildSentryOrgPath(args: {
  path: string;
  query?: Record<string, string>;
}): string | undefined {
  const client = Sentry.getClient();
  const dsn = client?.getDsn();
  if (!dsn?.host || !dsn.projectId) {
    return undefined;
  }

  const orgSlug = getSentryOrgSlug();
  if (!orgSlug) {
    return undefined;
  }

  const params = new URLSearchParams();
  params.set("project", dsn.projectId);
  if (args.query) {
    for (const [key, value] of Object.entries(args.query)) {
      params.set(key, value);
    }
  }
  const path = `${args.path}?${params.toString()}`;

  if (isSentrySaasDsnHost(dsn.host)) {
    return `https://${orgSlug}.sentry.io/${path}`;
  }

  return `${buildSentryWebBaseUrl(dsn)}/organizations/${orgSlug}/${path}`;
}

/** Build a Sentry conversation URL only when the runtime has enough Sentry config. */
export function buildSentryConversationUrl(
  conversationId: string,
): string | undefined {
  return buildSentryOrgPath({
    path: `explore/conversations/${encodeURIComponent(conversationId)}/`,
  });
}

/** Build a Sentry event URL only when the runtime has enough Sentry config. */
export function buildSentryEventUrl(eventId: string): string | undefined {
  // Direct /events/{id}/ is not a stable product route; issues search by id is.
  return buildSentryOrgPath({
    path: "issues/",
    query: { query: eventId },
  });
}

/** Build a Sentry trace URL only when the runtime has enough Sentry config. */
export function buildSentryTraceUrl(traceId: string): string | undefined {
  return buildSentryOrgPath({
    path: `performance/trace/${encodeURIComponent(traceId)}/`,
  });
}
