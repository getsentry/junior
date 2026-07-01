// Core owns host-level route ordering for Junior. Plugin app routes mount before
// core runtime routes, so dashboard-enabled apps reject plugin route patterns
// that can shadow dashboard/auth paths before the dashboard app is mounted.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Hono, type Context } from "hono";
import {
  getConfigDefaults,
  setConfigDefaults,
} from "@/chat/configuration/defaults";
import { getSlackReactionConfig, setSlackReactionConfig } from "@/chat/config";
import { getDb } from "@/chat/db";
import { logException } from "@/chat/logging";
import { generateAssistantReply } from "@/chat/respond";
import { normalizeSandboxEgressTracePropagationDomains } from "@/chat/sandbox/egress/tracing";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  type PluginRouteRegistration,
  type PluginApiRouteRegistration,
  getPluginApiRoutes,
  getPluginRoutes,
  setPlugins,
  validatePlugins,
} from "@/chat/plugins/agent-hooks";
import { setDashboardConversationLinkOptions } from "@/chat/slack/dashboard-link";
import type { PluginCatalogConfig } from "@/chat/plugins/types";
import {
  validatePluginEgressCredentialHooks,
  validatePluginRegistrations,
} from "@/chat/plugins/validation";
import type {
  PluginRegistration,
  PluginRouteMethod,
} from "@sentry/junior-plugin-api";
import type { JuniorReporting } from "./reporting";
import {
  pluginCatalogConfigFromEnv,
  pluginCatalogConfigFromPluginSet,
  pluginRuntimeRegistrationsFromPluginSet,
  type JuniorPluginSet,
} from "./plugins";
import { GET as healthGET } from "@/handlers/health";
import { POST as agentDispatchPOST } from "@/handlers/agent-dispatch";
import { POST as githubWebhookPOST } from "@/handlers/github-webhook";
import { GET as heartbeatGET } from "@/handlers/heartbeat";
import { GET as mcpOauthCallbackGET } from "@/handlers/mcp-oauth-callback";
import { GET as oauthCallbackGET } from "@/handlers/oauth-callback";
import { handleSandboxEgressRoute } from "@/handlers/sandbox-egress-route";
import { POST as slackWebhookPOST } from "@/handlers/slack-webhook";
import { JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE } from "@/deployment";
import {
  createVercelConversationWorkCallback,
  registerVercelConversationWorkDevConsumer,
  type VercelConversationWorkCallbackOptions,
} from "@/chat/task-execution/vercel-callback";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import {
  createVercelPluginTaskCallback,
  registerVercelPluginTaskDevConsumer,
} from "@/chat/plugins/task-callback";
import {
  createProductionConversationWorkOptions,
  createProductionSlackWebhookServices,
} from "@/chat/app/production";
import { withSandboxTracePropagation } from "@/chat/app/services";
import type { WaitUntilFn } from "@/handlers/types";

export { defineJuniorPlugins } from "./plugins";
export type {
  JuniorPluginInput,
  JuniorPluginSet,
  JuniorPluginSetOptions,
} from "./plugins";

export interface JuniorAppOptions {
  /** Authenticated dashboard mounted by core when configured. */
  dashboard?: JuniorDashboardOptions;
  /** Slack-specific overrides applied after env parsing. */
  slack?: {
    /** Slack emoji shown while Junior is processing. Defaults to `eyes`. */
    processingReactionEmoji?: string;
    /** Slack emoji shown after a turn completes. Defaults to `white_check_mark`. */
    completedReactionEmoji?: string;
  };
  /** Install-wide provider defaults (`provider.key` format). Channel overrides take precedence. */
  configDefaults?: Record<string, unknown>;
  /** Queue consumer wiring for the durable conversation worker. */
  conversationWork?: VercelConversationWorkCallbackOptions;
  /** Direct plugin set override. Usually omitted when `juniorNitro()` uses a plugin module. */
  plugins?: JuniorPluginSet;
  /** Sandbox execution options. */
  sandbox?: {
    /**
     * Egress domains allowed to carry Sentry trace propagation headers.
     * Entries may be exact domains or leading wildcard domains such as
     * `*.sentry.io`; wildcard entries match subdomains, not the apex domain.
     */
    egressTracePropagationDomains?: string[];
  };
  waitUntil?: WaitUntilFn;
}

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
  /** Disable dashboard route mounting while preserving serializable config shape. */
  disabled?: boolean;
  /** Overlay dashboard visual-QA fixture conversations onto real reporting data. */
  mockConversations?: boolean;
  /** Reporting implementation used by authenticated product APIs. Defaults to core reporting. */
  reporting?: JuniorReporting;
  /** Browser session lifetime in seconds. */
  sessionMaxAgeSeconds?: number;
  /** Additional trusted origins accepted by Better Auth. */
  trustedOrigins?: string[];
}

interface JuniorDashboardRuntimeOptions extends JuniorDashboardOptions {
  pluginRoutes?: PluginApiRouteRegistration[];
}

type JuniorVirtualDashboardOptions = Omit<JuniorDashboardOptions, "reporting">;

interface DashboardApp {
  fetch(request: Request): Promise<Response> | Response;
}

type CreateDashboardApp = (
  options: JuniorDashboardRuntimeOptions,
) => DashboardApp;

interface JuniorVirtualConfig {
  createDashboardApp?: CreateDashboardApp;
  dashboard?: JuniorVirtualDashboardOptions;
  pluginSet?: JuniorPluginSet;
  plugins?: PluginCatalogConfig;
  pluginRuntimeRegistrations: string[];
}

interface HostRouteRegistration {
  handler(request: Request): Promise<Response> | Response;
  method?: PluginRouteMethod | PluginRouteMethod[];
  path: string;
}

const DASHBOARD_PACKAGE_NAME = "@sentry/junior-dashboard";

/** Build a `WaitUntilFn`, preferring Vercel's lifetime extension when available. */
async function defaultWaitUntil(): Promise<WaitUntilFn> {
  try {
    const { waitUntil } = await import("@vercel/functions");
    return (task) => {
      const promise = typeof task === "function" ? task() : task;
      waitUntil(promise);
    };
  } catch {
    // Outside Vercel (e.g. local dev via node-server), fire-and-forget.
    return (task) => {
      const promise = typeof task === "function" ? task() : task;
      promise.catch(console.error);
    };
  }
}

/** Resolve build-time configuration from the virtual module injected by juniorNitro(). */
async function resolveVirtualConfig(): Promise<
  JuniorVirtualConfig | undefined
> {
  try {
    const mod: {
      createDashboardApp?: CreateDashboardApp;
      dashboard?: JuniorVirtualDashboardOptions;
      pluginSet?: JuniorPluginSet;
      plugins?: PluginCatalogConfig;
      pluginRuntimeRegistrations?: string[];
    } = await import("#junior/config");
    return {
      createDashboardApp: mod.createDashboardApp,
      dashboard: mod.dashboard,
      pluginSet: mod.pluginSet,
      plugins: mod.plugins,
      pluginRuntimeRegistrations: mod.pluginRuntimeRegistrations ?? [],
    };
  } catch (error) {
    if (!isMissingVirtualConfig(error)) {
      throw error;
    }
    return undefined;
  }
}

function isMissingVirtualConfig(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return (
    (code === "ERR_PACKAGE_IMPORT_NOT_DEFINED" ||
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "MODULE_NOT_FOUND") &&
    error.message.includes("#junior/config")
  );
}

function hasConfiguredPluginCatalog(
  config: PluginCatalogConfig | undefined,
): boolean {
  if (!config) {
    return false;
  }

  return Boolean(
    config.inlineManifests?.length ||
    config.packages?.length ||
    Object.keys(config.manifests ?? {}).length,
  );
}

function pluginPackageNames(config: PluginCatalogConfig | undefined): string[] {
  return config?.packages ?? [];
}

function validateBuildIncludesPluginPackages(
  pluginConfig: PluginCatalogConfig | undefined,
  virtualConfig: JuniorVirtualConfig | undefined,
): void {
  if (!virtualConfig?.plugins) {
    return;
  }
  const bundled = new Set(pluginPackageNames(virtualConfig.plugins));
  const missing = pluginPackageNames(pluginConfig).filter(
    (packageName) => !bundled.has(packageName),
  );
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `createApp() registered plugin package(s) not bundled by juniorNitro(): ${missing.join(", ")}. Point juniorNitro({ plugins: "./plugins" }) at the runtime plugin module or pass the same defineJuniorPlugins(...) set to juniorNitro({ plugins }) and createApp({ plugins }).`,
  );
}

function validateBuildIncludesPluginRuntimeRegistrations(
  runtimeRegistrations: PluginRegistration[],
  virtualConfig: JuniorVirtualConfig | undefined,
): void {
  const bundledRuntimeRegistrations =
    virtualConfig?.pluginRuntimeRegistrations ?? [];
  if (bundledRuntimeRegistrations.length === 0) {
    return;
  }

  const registered = new Set(
    runtimeRegistrations.map((plugin) => plugin.manifest.name),
  );
  const missing = bundledRuntimeRegistrations.filter(
    (pluginName) => !registered.has(pluginName),
  );
  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `createApp() is missing plugin registration(s) with runtime code bundled by juniorNitro(): ${missing.join(", ")}. Pass a runtime-safe plugin module to juniorNitro({ plugins: "./plugins" }) or pass the same defineJuniorPlugins(...) set to createApp({ plugins }).`,
  );
}

async function createDashboardRouteRegistrations(args: {
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
function dashboardHostRoutePaths(dashboard: JuniorDashboardOptions): string[] {
  const basePath = normalizeDashboardPath(dashboard.basePath, "/");
  const authPath = normalizeDashboardPath(dashboard.authPath, "/api/auth");
  const pagePaths =
    basePath === "/"
      ? [
          "/",
          "/conversations",
          "/conversations/*",
          "/people",
          "/people/*",
          "/plugins",
          "/plugins/*",
        ]
      : [basePath, `${basePath}/*`];
  const loginPath = basePath === "/" ? "/auth/login" : `${basePath}/auth/login`;

  return [
    ...pagePaths,
    "/favicon.ico",
    "/_junior/dashboard/client.js",
    loginPath,
    "/api/health",
    "/api/runtime",
    "/api/plugins",
    "/api/plugins/*",
    "/api/plugin-reports",
    "/api/skills",
    "/api/conversations",
    "/api/conversations/*",
    "/api/people",
    "/api/people/*",
    "/api/config",
    "/api/me",
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
): boolean {
  return dashboardHostRoutePaths(dashboard).some((path) =>
    routePatternOverlaps(path, routePath),
  );
}

function dashboardRouteRegistrations(args: {
  dashboard: JuniorDashboardOptions;
  createDashboardApp: CreateDashboardApp;
  pluginRoutes: PluginApiRouteRegistration[];
}): HostRouteRegistration[] {
  let app: DashboardApp | undefined;
  const fetch = (request: Request) => {
    app ??= args.createDashboardApp({
      ...args.dashboard,
      pluginRoutes: args.pluginRoutes,
    });
    if (!app || typeof app.fetch !== "function") {
      throw new Error("createDashboardApp() must return an app with fetch()");
    }
    return app.fetch(request);
  };

  return dashboardHostRoutePaths(args.dashboard).map((path) => ({
    handler: fetch,
    path,
  }));
}

function validateDashboardRouteOwnership(args: {
  dashboard: JuniorDashboardOptions | undefined;
  routes: PluginRouteRegistration[];
}): void {
  if (!args.dashboard || args.dashboard.disabled) {
    return;
  }
  for (const route of args.routes) {
    if (dashboardOwnedRoutePath(route.path, args.dashboard)) {
      throw new Error(
        `Plugin "${route.pluginName}" route "${route.path}" conflicts with core dashboard routes`,
      );
    }
  }
}

/** Mount HTTP handlers before core routes claim those paths. */
function mountRoutes(app: Hono, routes: HostRouteRegistration[]): void {
  for (const route of routes) {
    const handler = (c: Context) => route.handler(c.req.raw);
    const methods = Array.isArray(route.method)
      ? route.method
      : [route.method ?? "ALL"];
    const explicitMethods = methods.filter(
      (method): method is Exclude<PluginRouteMethod, "ALL"> => method !== "ALL",
    );

    if (methods.includes("ALL")) {
      app.all(route.path, handler);
    } else if (explicitMethods.length > 0) {
      app.on(explicitMethods, route.path, handler);
    }
  }
}

/** Create a Hono app with all Junior routes. */
export async function createApp(options?: JuniorAppOptions): Promise<Hono> {
  const virtualConfig = await resolveVirtualConfig();
  const dashboard = options?.dashboard ?? virtualConfig?.dashboard;
  const configuredPlugins = options?.plugins ?? virtualConfig?.pluginSet;
  const plugins = pluginRuntimeRegistrationsFromPluginSet(configuredPlugins);
  const pluginConfig = configuredPlugins
    ? pluginCatalogConfigFromPluginSet(configuredPlugins)
    : (virtualConfig?.plugins ?? pluginCatalogConfigFromEnv());
  if (configuredPlugins) {
    validateBuildIncludesPluginPackages(pluginConfig, virtualConfig);
  }
  validateBuildIncludesPluginRuntimeRegistrations(plugins, virtualConfig);
  validatePlugins(plugins);
  getDb();
  const shouldValidatePluginCatalog =
    hasConfiguredPluginCatalog(pluginConfig) ||
    Boolean(configuredPlugins?.registrations.length) ||
    Boolean(Object.keys(options?.configDefaults ?? {}).length);
  const previousPluginCatalogConfig =
    pluginCatalogRuntime.setConfig(pluginConfig);
  const previousPlugins = setPlugins(plugins);
  const previousConfigDefaults = getConfigDefaults();
  const previousSlackReactionConfig = getSlackReactionConfig();
  const previousDashboardLinkOptions =
    setDashboardConversationLinkOptions(dashboard);
  let pluginRoutes: PluginRouteRegistration[] = [];
  let pluginApiRoutes: PluginApiRouteRegistration[] = [];
  let sandboxEgressTracePropagationDomains: string[] = [];
  try {
    sandboxEgressTracePropagationDomains =
      normalizeSandboxEgressTracePropagationDomains(
        options?.sandbox?.egressTracePropagationDomains,
      );
    setConfigDefaults(options?.configDefaults);
    if (options?.slack) {
      setSlackReactionConfig(options.slack);
    }
    if (shouldValidatePluginCatalog) {
      pluginCatalogRuntime.getSignature();
      validatePluginRegistrations(configuredPlugins?.registrations ?? []);
      validatePluginEgressCredentialHooks(
        configuredPlugins?.registrations ?? [],
      );
    }
    pluginRoutes = getPluginRoutes();
    validateDashboardRouteOwnership({ dashboard, routes: pluginRoutes });
    if (dashboard && !dashboard.disabled) {
      pluginApiRoutes = getPluginApiRoutes();
    }
  } catch (error) {
    pluginCatalogRuntime.setConfig(previousPluginCatalogConfig);
    setPlugins(previousPlugins);
    setConfigDefaults(previousConfigDefaults);
    setSlackReactionConfig(previousSlackReactionConfig);
    setDashboardConversationLinkOptions(previousDashboardLinkOptions);
    throw error;
  }

  const waitUntil = options?.waitUntil ?? (await defaultWaitUntil());
  const runtimeServiceOverrides = {
    sandbox: {
      tracePropagation: { domains: sandboxEgressTracePropagationDomains },
    },
  };
  const slackWebhookServices = createProductionSlackWebhookServices({
    services: runtimeServiceOverrides,
  });
  const generateReplyWithTracePropagation = withSandboxTracePropagation(
    generateAssistantReply,
    runtimeServiceOverrides.sandbox.tracePropagation,
  );

  const app = new Hono();

  app.onError((err, c) => {
    logException(err, "unhandled_route_error");
    return c.text("Internal Server Error", 500);
  });

  app.use("*", async (c, next) => {
    return await handleSandboxEgressRoute(
      c.req.raw,
      sandboxEgressTracePropagationDomains,
      next,
    );
  });

  mountRoutes(app, pluginRoutes);
  mountRoutes(
    app,
    await createDashboardRouteRegistrations({
      dashboard,
      createDashboardApp: virtualConfig?.createDashboardApp,
      pluginRoutes: pluginApiRoutes,
    }),
  );

  app.get("/", () => healthGET());
  app.get("/health", () => healthGET());

  // MCP callback must be registered before the generic OAuth callback
  // because Hono matches routes top-down and `:provider` would swallow `mcp/`.
  app.get("/api/oauth/callback/mcp/:provider", (c) => {
    return mcpOauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil, {
      generateReply: generateReplyWithTracePropagation,
    });
  });

  app.get("/api/oauth/callback/:provider", (c) => {
    return oauthCallbackGET(c.req.raw, c.req.param("provider"), waitUntil, {
      generateReply: generateReplyWithTracePropagation,
    });
  });

  app.post("/api/internal/agent-dispatch", (c) => {
    return agentDispatchPOST(c.req.raw, waitUntil, {
      tracePropagation: { domains: sandboxEgressTracePropagationDomains },
    });
  });

  let agentContinuePOST:
    | ReturnType<typeof createVercelConversationWorkCallback>
    | undefined;
  let pluginTaskPOST:
    | ReturnType<typeof createVercelPluginTaskCallback>
    | undefined;
  let conversationWorkOptions:
    | VercelConversationWorkCallbackOptions
    | undefined;
  const getConversationWorkOptions = () => {
    conversationWorkOptions ??=
      options?.conversationWork ??
      createProductionConversationWorkOptions({
        services: runtimeServiceOverrides,
      });
    return conversationWorkOptions;
  };
  const getResourceEventQueue = (): ConversationWorkQueue =>
    getConversationWorkOptions().queue ?? getVercelConversationWorkQueue();
  if (process.env.NODE_ENV === "development") {
    registerVercelConversationWorkDevConsumer(getConversationWorkOptions());
    registerVercelPluginTaskDevConsumer();
  }
  app.post("/api/internal/agent/continue", (c) => {
    agentContinuePOST ??= createVercelConversationWorkCallback(
      getConversationWorkOptions(),
    );
    return agentContinuePOST(c.req.raw);
  });
  app.post(JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE, (c) => {
    pluginTaskPOST ??= createVercelPluginTaskCallback();
    return pluginTaskPOST(c.req.raw);
  });

  app.get("/api/internal/heartbeat", (c) => {
    return heartbeatGET(c.req.raw, waitUntil);
  });

  app.post("/api/webhooks/slack", (c) => {
    return slackWebhookPOST(c.req.raw, waitUntil, slackWebhookServices);
  });

  app.post("/api/webhooks/github", (c) => {
    return githubWebhookPOST(c.req.raw, {
      queue: getResourceEventQueue,
      state: () => getConversationWorkOptions().state,
    });
  });

  app.post("/api/webhooks/:platform", (c) => {
    return new Response(`Unknown platform: ${c.req.param("platform")}`, {
      status: 404,
    });
  });

  return app;
}
