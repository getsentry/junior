export interface DashboardBaseURLConfig {
  baseURL?: string;
}

export interface DashboardConversationURLConfig extends DashboardBaseURLConfig {
  basePath?: string;
  conversationId: string;
}

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

/** Normalize dashboard route prefixes for host routes and external links. */
export function normalizeDashboardPath(
  path: string | undefined,
  fallback: string,
): string {
  const value = path?.trim() || fallback;
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return stripTrailingSlashes(withSlash);
}

/** Resolve the dashboard origin used for browser auth and external links. */
export function resolveDashboardBaseURL(
  config: DashboardBaseURLConfig = {},
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

/** Build the dashboard conversation URL shown from outside the browser app. */
export function buildDashboardConversationURL(
  config: DashboardConversationURLConfig,
): string {
  const baseURL = resolveDashboardBaseURL({ baseURL: config.baseURL });
  const basePath = normalizeDashboardPath(config.basePath, "/");
  const path =
    basePath === "/"
      ? `/conversations/${encodeURIComponent(config.conversationId)}`
      : `${basePath}/conversations/${encodeURIComponent(config.conversationId)}`;
  return `${baseURL}${path}`;
}
