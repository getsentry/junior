// Dashboard routes that createApp() mounts. Dashboard-enabled apps reject
// plugin route patterns that can shadow dashboard or auth paths.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { PluginRouteMethod, User } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import type {
  PluginApiRouteRegistration,
  PluginRouteRegistration,
} from "@/chat/plugins/agent-hooks";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

export interface JuniorDashboardOptions {
  /** Browser auth route prefix used by Better Auth. */
  authPath?: string;
  /** Require a dashboard browser session before serving dashboard pages and APIs. */
  authRequired?: boolean;
  /** Exact Google account emails allowed to open the dashboard. */
  allowedEmails?: string[];
  /** Google Workspace domains allowed to open the dashboard. */
  allowedGoogleDomains?: string[];
  /** Browser route prefix for the dashboard shell. */
  basePath?: string;
  /** Public deployment origin used for auth callbacks and external links. */
  baseURL?: string;
  /** Expose the config-gated component gallery for local visual QA. */
  componentGallery?: boolean;
  /** Disable dashboard route mounting while preserving serializable config shape. */
  disabled?: boolean;
  /** Replace Conversation route responses with dashboard visual-QA fixtures. */
  mockConversations?: boolean;
  /** Browser session lifetime in seconds. */
  sessionMaxAgeSeconds?: number;
  /** Additional trusted origins accepted by Better Auth. */
  trustedOrigins?: string[];
}

export interface JuniorDashboardRuntimeOptions extends JuniorDashboardOptions {
  agentName?: string;
  authenticatedRoutes?: readonly AuthenticatedRoute[];
  conversationWorkQueue?: ConversationWorkQueue;
  pluginRoutes?: PluginApiRouteRegistration[];
}

interface DashboardApp {
  fetch(request: Request): Promise<Response> | Response;
}

export type CreateDashboardApp = (
  options: JuniorDashboardRuntimeOptions,
) => DashboardApp;

export interface HostRouteRegistration {
  handler(request: Request): Promise<Response> | Response;
  method?: PluginRouteMethod | readonly PluginRouteMethod[];
  path: string;
}

export interface AuthenticatedRoute {
  handler(request: Request, user: User): Promise<Response> | Response;
  method?: PluginRouteMethod | readonly PluginRouteMethod[];
  path: string;
}

const DASHBOARD_PACKAGE_NAME = "@sentry/junior-dashboard";

/** Mount the dashboard app on the dashboard-owned host paths. */
export async function createDashboardRouteRegistrations(args: {
  authenticatedRoutes: readonly AuthenticatedRoute[];
  conversationWorkQueue: ConversationWorkQueue;
  dashboard: JuniorDashboardOptions | undefined;
  createDashboardApp: CreateDashboardApp | undefined;
  pluginRoutes: PluginApiRouteRegistration[];
}): Promise<HostRouteRegistration[]> {
  if (!args.dashboard || args.dashboard.disabled) {
    return [];
  }

  const createDashboardApp =
    args.createDashboardApp ?? (await loadDashboardAppFactory());
  return dashboardRouteRegistrations({
    authenticatedRoutes: args.authenticatedRoutes,
    conversationWorkQueue: args.conversationWorkQueue,
    dashboard: args.dashboard,
    createDashboardApp,
    pluginRoutes: args.pluginRoutes,
  });
}

async function loadDashboardAppFactory(): Promise<CreateDashboardApp> {
  try {
    const appRequire = createRequire(`${process.cwd()}/package.json`);
    const mod = await import(
      pathToFileURL(appRequire.resolve(DASHBOARD_PACKAGE_NAME)).href
    );
    return dashboardAppFactoryFromModule(mod);
  } catch (error) {
    if (isMissingDashboardPackage(error)) {
      throw new Error(
        'createApp({ dashboard }) requires installing "@sentry/junior-dashboard"',
        { cause: error },
      );
    }
    throw error;
  }
}

function dashboardAppFactoryFromModule(mod: unknown): CreateDashboardApp {
  if (
    !mod ||
    typeof mod !== "object" ||
    typeof (mod as { createDashboardApp?: unknown }).createDashboardApp !==
      "function"
  ) {
    throw new Error(
      '@sentry/junior-dashboard must export a "createDashboardApp" function',
    );
  }
  return (mod as { createDashboardApp: CreateDashboardApp }).createDashboardApp;
}

function isMissingDashboardPackage(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return (
    (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    error.message.includes("@sentry/junior-dashboard")
  );
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

/** List every route path core forwards to the dashboard app and reserves from plugin routes. */
function dashboardHostRoutePaths(
  dashboard: JuniorDashboardOptions,
  authenticatedRoutes: readonly AuthenticatedRoute[] = [],
): string[] {
  const basePath = normalizeDashboardPath(dashboard.basePath, "/");
  const authPath = normalizeDashboardPath(dashboard.authPath, "/api/auth");
  const pagePath = (suffix: string) =>
    basePath === "/" ? `/${suffix}` : `${basePath}/${suffix}`;
  const conversationsPath = pagePath("conversations");
  const peoplePath = pagePath("people");
  const pagePaths = [
    basePath,
    pagePath("code"),
    `${pagePath("code")}/*`,
    conversationsPath,
    `${conversationsPath}/*`,
    pagePath("locations"),
    `${pagePath("locations")}/*`,
    peoplePath,
    `${peoplePath}/*`,
    pagePath("automations"),
    `${pagePath("automations")}/*`,
    pagePath("tasks"),
    `${pagePath("tasks")}/*`,
    pagePath("memories"),
    `${pagePath("memories")}/*`,
    pagePath("system"),
    `${pagePath("system")}/*`,
    pagePath("plugins"),
    `${pagePath("plugins")}/*`,
    pagePath("settings"),
    `${pagePath("settings")}/*`,
  ];
  if (dashboard.componentGallery) {
    pagePaths.push(pagePath("dev"), `${pagePath("dev")}/*`);
  }
  const loginPath = basePath === "/" ? "/auth/login" : `${basePath}/auth/login`;

  return [
    ...pagePaths,
    "/favicon.ico",
    "/_junior/dashboard/avatar.png",
    "/_junior/dashboard/object-icons/*",
    "/_junior/dashboard/client.js",
    "/_junior/dashboard/chunks/*",
    "/_junior/dashboard/icon-512.png",
    "/_junior/dashboard/manifest.webmanifest",
    loginPath,
    "/api/health",
    "/api/runtime",
    "/api/plugins",
    "/api/plugins/*",
    "/api/plugin-reports",
    "/api/user-pages",
    "/api/user-pages/*",
    "/api/automations",
    "/api/automations/*",
    "/api/skills",
    "/api/code",
    "/api/code/*",
    "/api/stats",
    "/api/conversations",
    "/api/conversations/*",
    "/api/locations",
    "/api/locations/*",
    "/api/people",
    "/api/people/*",
    "/api/personal-tokens",
    "/api/personal-tokens/*",
    "/api/workspaces",
    "/api/workspaces/*",
    "/api/config",
    "/api/me",
    ...authenticatedRoutes.map((route) => route.path),
    authPath,
    `${authPath}/*`,
  ];
}

function routePrefixCoversPath(routePrefix: string, path: string): boolean {
  return (
    routePrefix === "/" ||
    path === routePrefix ||
    path.startsWith(`${routePrefix}/`)
  );
}

function routeSegments(path: string): string[] {
  return normalizeDashboardPath(path, "/").split("/").filter(Boolean);
}

function routeSegmentMatches(pattern: string, value: string): boolean {
  return pattern === value || pattern === "*" || pattern.startsWith(":");
}

function routePatternMatchesConcretePath(
  pattern: string,
  concretePath: string,
): boolean {
  const patternSegments = routeSegments(pattern);
  const pathSegments = routeSegments(concretePath);
  for (let index = 0; index < patternSegments.length; index += 1) {
    const segment = patternSegments[index];
    if (segment === "**" || segment === "*") {
      return true;
    }
    const value = pathSegments[index];
    if (!value || !routeSegmentMatches(segment, value)) {
      return false;
    }
  }
  return patternSegments.length === pathSegments.length;
}

function routePatternExamples(routePath: string): string[] {
  const normalized = normalizeDashboardPath(routePath, "/");
  if (!normalized.endsWith("/*") && !normalized.endsWith("/**")) {
    return [normalized];
  }
  const prefix = normalizeDashboardPath(
    normalized.endsWith("/*")
      ? normalized.slice(0, -2)
      : normalized.slice(0, -3),
    "/",
  );
  return [
    prefix,
    prefix === "/" ? "/__dashboard__" : `${prefix}/__dashboard__`,
  ];
}

function routePatternOverlaps(ownedPath: string, routePath: string): boolean {
  if (
    ownedPath.endsWith("/*") &&
    routePrefixCoversPath(ownedPath.slice(0, -2), routePath)
  ) {
    return true;
  }
  return routePatternExamples(ownedPath).some((example) =>
    routePatternMatchesConcretePath(routePath, example),
  );
}

function dashboardOwnedRoutePath(
  routePath: string,
  dashboard: JuniorDashboardOptions,
  authenticatedRoutes: readonly AuthenticatedRoute[] = [],
): boolean {
  return dashboardHostRoutePaths(dashboard, authenticatedRoutes).some((path) =>
    routePatternOverlaps(path, routePath),
  );
}

function dashboardRouteRegistrations(args: {
  authenticatedRoutes: readonly AuthenticatedRoute[];
  conversationWorkQueue: ConversationWorkQueue;
  dashboard: JuniorDashboardOptions;
  createDashboardApp: CreateDashboardApp;
  pluginRoutes: PluginApiRouteRegistration[];
}): HostRouteRegistration[] {
  let app: DashboardApp | undefined;
  const fetch = (request: Request) => {
    const dashboardOptions: JuniorDashboardRuntimeOptions = {
      ...args.dashboard,
      agentName: botConfig.userName,
      authenticatedRoutes: args.authenticatedRoutes,
      conversationWorkQueue: args.conversationWorkQueue,
      pluginRoutes: args.pluginRoutes,
    };
    app ??= args.createDashboardApp(dashboardOptions);
    if (!app || typeof app.fetch !== "function") {
      throw new Error("createDashboardApp() must return an app with fetch()");
    }
    return app.fetch(request);
  };

  return dashboardHostRoutePaths(args.dashboard, args.authenticatedRoutes).map(
    (path) => ({
      handler: fetch,
      path,
    }),
  );
}

/** Reject plugin routes that would shadow dashboard or auth paths. */
export function validateDashboardRouteOwnership(args: {
  authenticatedRoutes?: readonly AuthenticatedRoute[];
  dashboard: JuniorDashboardOptions | undefined;
  routes: PluginRouteRegistration[];
}): void {
  if (!args.dashboard || args.dashboard.disabled) {
    return;
  }
  for (const route of args.routes) {
    if (
      dashboardOwnedRoutePath(
        route.path,
        args.dashboard,
        args.authenticatedRoutes,
      )
    ) {
      throw new Error(
        `Plugin "${route.pluginName}" route "${route.path}" conflicts with core dashboard routes`,
      );
    }
  }
}
