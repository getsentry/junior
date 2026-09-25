import { PluginToolInputError } from "@sentry/junior-plugin-api";

export const GITHUB_SESSION_FOOTER_START =
  "<!-- junior-session-footer:start -->";
export const GITHUB_SESSION_FOOTER_END = "<!-- junior-session-footer:end -->";
const GITHUB_CONVERSATION_ID_MARKER = "junior-conversation-id:";

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

/** Build the conversation session footer, preferring a host-provided dashboard link. */
export function githubConversationFooter(
  conversationId: string,
  dashboardUrl?: string,
): string | undefined {
  const id = nonEmptyString(conversationId, "conversationId");
  const normalizedDashboardUrl = dashboardUrl?.trim();
  const sentryUrl = sentryConversationUrl(id);
  const sessionLinks = normalizedDashboardUrl
    ? `[View Junior Session](${normalizedDashboardUrl})${sentryUrl ? ` [[Sentry]](${sentryUrl})` : ""}`
    : sentryUrl
      ? `[View Junior Session in Sentry](${sentryUrl})`
      : undefined;
  if (!sessionLinks) {
    return undefined;
  }
  const conversationMarker = `<!-- ${GITHUB_CONVERSATION_ID_MARKER}${encodeURIComponent(id)} -->`;
  return `${GITHUB_SESSION_FOOTER_START}\n${conversationMarker}\n\n--\n\n${sessionLinks}\n\n${GITHUB_SESSION_FOOTER_END}`;
}

/** Read opaque native conversation ids from runtime-owned GitHub footers. */
export function githubConversationIds(
  body: string | null | undefined,
): string[] {
  if (!body) return [];
  const ids = new Set<string>();
  const footer = new RegExp(
    `${escapeRegExp(GITHUB_SESSION_FOOTER_START)}[\\s\\S]*?${escapeRegExp(GITHUB_SESSION_FOOTER_END)}`,
    "g",
  );
  const marker = new RegExp(
    `<!--\\s*${escapeRegExp(GITHUB_CONVERSATION_ID_MARKER)}([^\\s]+)\\s*-->`,
    "g",
  );
  for (const footerMatch of body.matchAll(footer)) {
    for (const markerMatch of footerMatch[0].matchAll(marker)) {
      try {
        const id = decodeURIComponent(markerMatch[1] ?? "").trim();
        if (id) ids.add(id);
      } catch {
        continue;
      }
    }
  }
  return [...ids];
}

/** Read same- and cross-repository issue references from a pull request body. */
export function githubLinkedIssues(
  body: string | null | undefined,
  repositoryFullName: string,
): { number: number; repositoryFullName: string }[] {
  if (!body) return [];
  const references = new Map<
    string,
    { number: number; repositoryFullName: string }
  >();
  const add = (linkedRepository: string, rawNumber: string) => {
    const number = Number.parseInt(rawNumber, 10);
    if (!Number.isInteger(number) || number <= 0) return;
    const normalizedRepository = linkedRepository.toLowerCase();
    references.set(`${normalizedRepository}#${number}`, {
      number,
      repositoryFullName: linkedRepository,
    });
  };

  for (const match of body.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)) {
    add(match[1] ?? "", match[2] ?? "");
  }
  for (const match of body.matchAll(/(?:^|[^\w/])#(\d+)\b/g)) {
    add(repositoryFullName, match[1] ?? "");
  }

  return [...references.values()].sort(
    (left, right) =>
      left.repositoryFullName.localeCompare(right.repositoryFullName) ||
      left.number - right.number,
  );
}

/**
 * Append (or replace an existing) conversation session footer to a GitHub body string.
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
