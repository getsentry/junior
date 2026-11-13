import {
  objectIconPath,
  objectLinkFilterSchema,
  type ObjectIconName,
  type ObjectLinkFilter,
} from "@sentry/junior-plugin-api";
export interface DashboardConversationLinkOptions {
  basePath?: string;
  baseURL?: string;
  disabled?: boolean;
}

let dashboardConversationLinkOptions:
  | DashboardConversationLinkOptions
  | undefined;

function withHttps(host: string): string {
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function normalizeDashboardPath(
  path: string | undefined,
  fallback: string,
): string {
  const value = path?.trim() || fallback;
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return stripTrailingSlashes(withSlash);
}

function resolveDashboardBaseURL(
  config: DashboardConversationLinkOptions,
): string {
  const explicit = config.baseURL ?? process.env.JUNIOR_BASE_URL;
  if (explicit?.trim()) {
    return stripTrailingSlashes(withHttps(explicit.trim()));
  }

  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelProd) {
    return stripTrailingSlashes(withHttps(vercelProd));
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return stripTrailingSlashes(withHttps(vercelUrl));
  }

  return "http://localhost:3000";
}

/** Configure core dashboard links. */
export function setDashboardConversationLinkOptions(
  options: DashboardConversationLinkOptions | undefined,
): DashboardConversationLinkOptions | undefined {
  const previous = dashboardConversationLinkOptions;
  dashboardConversationLinkOptions = options?.disabled ? undefined : options;
  return previous;
}

function resolveDashboardPath(segmentPath: string): string | undefined {
  if (!dashboardConversationLinkOptions) {
    return undefined;
  }
  const baseURL = resolveDashboardBaseURL(dashboardConversationLinkOptions);
  const basePath = normalizeDashboardPath(
    dashboardConversationLinkOptions.basePath,
    "/",
  );
  const path = basePath === "/" ? segmentPath : `${basePath}${segmentPath}`;
  return `${baseURL}${path}`;
}

/** Build the dashboard conversation URL when the core dashboard is enabled. */
export function getDashboardConversationLink(
  conversationId: string,
): string | undefined {
  return resolveDashboardPath(
    `/conversations/${encodeURIComponent(conversationId)}`,
  );
}

/** Build the dashboard settings URL when the core dashboard is enabled. */
export function getDashboardSettingsLink(): string | undefined {
  return resolveDashboardPath("/settings");
}

// Return the decoded segment after one dashboard page prefix, if the URL
// is that page.
function parseDashboardPageLink(
  url: string,
  pagePrefix: string,
): string | undefined {
  const prefix = resolveDashboardPath(pagePrefix);
  if (!prefix || !URL.canParse(url)) return undefined;
  const base = new URL(prefix);
  const link = new URL(url);
  if (link.origin !== base.origin || !link.pathname.startsWith(base.pathname)) {
    return undefined;
  }
  // A trailing slash names the same page, as in link filters.
  const path = link.pathname.slice(base.pathname.length);
  const segment = path.endsWith("/") ? path.slice(0, -1) : path;
  if (!segment || segment.includes("/")) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Return the Conversation id in a dashboard conversation URL, if it is one. */
export function parseDashboardConversationLink(
  url: string,
): string | undefined {
  return parseDashboardPageLink(url, "/conversations/");
}

/** Build the dashboard URL of one person's page. */
export function getDashboardPersonLink(email: string): string | undefined {
  return resolveDashboardPath(`/people/${encodeURIComponent(email)}`);
}

/** Return the email in a dashboard person URL, if it is one. */
export function parseDashboardPersonLink(url: string): string | undefined {
  return parseDashboardPageLink(url, "/people/");
}

/**
 * Return the link filter for one dashboard page pattern, such as
 * `/conversations/*`, when the core dashboard is enabled.
 */
export function getDashboardLinkFilter(
  pagePattern: string,
): ObjectLinkFilter | undefined {
  const link = resolveDashboardPath(pagePattern);
  if (!link) return undefined;
  const url = new URL(link);
  return objectLinkFilterSchema.parse({
    scheme: url.protocol.slice(0, -1),
    host: url.host,
    pathPattern: url.pathname,
  });
}

/** Build the dashboard task detail URL when the core dashboard is enabled. */
export function getDashboardTaskLink(taskId: string): string | undefined {
  return resolveDashboardPath(`/automations/${encodeURIComponent(taskId)}`);
}

/** Build the review desk URL that selects one Review item. */
export function getDashboardReviewItemLink(itemId: string): string | undefined {
  return resolveDashboardPath(`/review?item=${encodeURIComponent(itemId)}`);
}

/** Public icon asset URL. Headless and local installs keep text-only identity. */
export function getDashboardObjectIconLink(
  icon: ObjectIconName,
): string | undefined {
  if (!dashboardConversationLinkOptions) return undefined;
  const url = new URL(
    objectIconPath(icon),
    resolveDashboardBaseURL(dashboardConversationLinkOptions),
  );
  if (url.protocol !== "https:" || url.hostname === "localhost")
    return undefined;
  return url.href;
}
