import { PluginToolInputError } from "@sentry/junior-plugin-api";

export const GITHUB_SESSION_FOOTER_START = "<!-- junior-session-footer:start -->";
export const GITHUB_SESSION_FOOTER_END = "<!-- junior-session-footer:end -->";

function nonEmptyString(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new PluginToolInputError(`${name} is required`);
  }
  return value.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sentryConversationUrl(
  conversationId: string,
): string | undefined {
  const dsn = process.env.SENTRY_DSN?.trim();
  const orgSlug = process.env.SENTRY_ORG_SLUG?.trim();
  if (!dsn || !orgSlug) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    return undefined;
  }

  const projectId = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!parsed.hostname || !projectId) {
    return undefined;
  }

  const encodedConversationId = encodeURIComponent(conversationId);
  const params = new URLSearchParams({ project: projectId });
  const path = `explore/conversations/${encodedConversationId}/?${params.toString()}`;

  if (
    parsed.hostname === "sentry.io" ||
    parsed.hostname.endsWith(".sentry.io")
  ) {
    return `https://${orgSlug}.sentry.io/${path}`;
  }

  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${parsed.hostname}${port}/organizations/${orgSlug}/${path}`;
}

/** Build the Junior session footer, preferring a host-provided dashboard link. */
export function githubConversationFooter(
  conversationId: string,
  dashboardUrl?: string,
): string | undefined {
  const id = nonEmptyString(conversationId, "conversationId");
  const normalizedDashboardUrl = dashboardUrl?.trim();
  const sessionUrl = normalizedDashboardUrl || sentryConversationUrl(id);
  if (!sessionUrl) {
    return undefined;
  }
  const label = normalizedDashboardUrl
    ? "View Junior Session"
    : "View Junior Session in Sentry";
  return `${GITHUB_SESSION_FOOTER_START}\n\n--\n\n[${label}](${sessionUrl})\n\n${GITHUB_SESSION_FOOTER_END}`;
}

/**
 * Append (or replace an existing) Junior session footer to a GitHub body string.
 * Without a dashboard or Sentry link, returns the body unchanged (existing footer stripped).
 */
export function appendGitHubFooter(
  body: string,
  conversationId: string,
  dashboardUrl?: string,
): string {
  const footer = githubConversationFooter(conversationId, dashboardUrl);
  const normalizedBody = body.trimEnd();
  const existingFooter = new RegExp(
    `${escapeRegExp(GITHUB_SESSION_FOOTER_START)}[\\s\\S]*?${escapeRegExp(GITHUB_SESSION_FOOTER_END)}`,
  );
  if (existingFooter.test(normalizedBody)) {
    return footer
      ? normalizedBody.replace(existingFooter, footer)
      : normalizedBody.replace(existingFooter, "").trimEnd();
  }
  if (!footer) {
    return normalizedBody;
  }
  return normalizedBody ? `${normalizedBody}\n\n${footer}` : footer;
}
