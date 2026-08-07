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

/** Configure core dashboard links used in Slack footers. */
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
  const path =
    basePath === "/" ? segmentPath : `${basePath}${segmentPath}`;
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

/** Build the dashboard task detail URL when the core dashboard is enabled. */
export function getDashboardTaskLink(taskId: string): string | undefined {
  return resolveDashboardPath(`/tasks/${encodeURIComponent(taskId)}`);
}
