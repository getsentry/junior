import { Hono, type Context, type Next } from "hono";
import {
  authenticatePersonalToken,
  createJuniorApi,
  jsonResponse,
  resolveViewerUser,
  updateViewerDisplayName,
  type JuniorApiVariables,
} from "@sentry/junior/api";
import { apiErrorSchema } from "@sentry/junior/api/schema";
import { initSentry } from "@sentry/junior/instrumentation";
import { JUNIOR_VERSION } from "@sentry/junior/version";
import type {
  PluginApiRouteRequestContext,
  PluginRouteApp,
} from "@sentry/junior-plugin-api";
import { pluginApiRouteRequestContextSchema } from "@sentry/junior-plugin-api";
import {
  dashboardConfigSchema,
  dashboardIdentitySchema,
  dashboardProfileUpdateSchema,
} from "./api/schema";
import {
  createDashboardAuth,
  dashboardBearerSession,
  dashboardPersonalBearerToken,
  dashboardSessionIsAuthorized,
  resolveGoogleHostedDomainHint,
  sanitizeDashboardSession,
  verifiedDashboardSessionEmail,
  type DashboardAuth,
  type DashboardSession,
} from "./auth";
import { isAuthPath, type AuthenticatedRoute } from "./authenticated-routes";
import { createMockReportingApi } from "./mock-reporting/routes";
import {
  DASHBOARD_AVATAR_HEADER_PATH,
  DASHBOARD_CLIENT_PATH,
  DASHBOARD_INSTALL_ICON_PATH,
  DASHBOARD_MANIFEST_PATH,
  dashboardPagePaths,
  readDashboardAvatarHeader,
  readDashboardClient,
  renderDashboard,
  renderFavicon,
  renderForbiddenPage,
  renderInstallIcon,
  renderManifest,
} from "./shell";
import { normalizeDashboardPath, resolveDashboardBaseURL } from "./url";

const DEFAULT_BASE_PATH = "/";
const DEFAULT_AUTH_PATH = "/api/auth";
const LOGIN_NEXT_PARAM = "next";
const LOCAL_VIEWER_EMAIL = "dev@example.com";
/** Process-local display names for mock reporting only. */
const mockDisplayNamesByEmail = new Map<string, string>();

export interface JuniorDashboardOptions {
  agentName?: string;
  basePath?: string;
  baseURL?: string;
  authPath?: string;
  authRequired?: boolean;
  allowedGoogleDomains?: string[];
  allowedEmails?: string[];
  sessionMaxAgeSeconds?: number;
  trustedOrigins?: string[];
  auth?: DashboardAuth;
  componentGallery?: boolean;
  mockConversations?: boolean;
}

interface DashboardRuntimeOptions extends JuniorDashboardOptions {
  authenticatedRoutes?: readonly AuthenticatedRoute[];
  pluginRoutes?: DashboardPluginRoute[];
}

interface DashboardPluginRoute {
  app: PluginRouteApp;
  pluginName: string;
}

type Variables = JuniorApiVariables & { authSession: DashboardSession };

function hasSentryConversationLinks(): boolean {
  return Boolean(
    process.env.SENTRY_DSN?.trim() && process.env.SENTRY_ORG_SLUG?.trim(),
  );
}

function normalizeValues(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

/** Read dashboard list env vars as comma-separated strings or JSON arrays. */
function readEnvList(name: string): string[] | undefined {
  const value = process.env[name];
  if (!value?.trim()) {
    return undefined;
  }

  if (value.trim().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${name} must be a JSON string array`, {
        cause: error,
      });
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error(`${name} must be a JSON string array`);
    }
    return parsed;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Read dashboard boolean env vars; only explicit true/false values apply. */
function readEnvFlag(name: string): boolean | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  return value === "true" ? true : value === "false" ? false : undefined;
}

function resolveDashboardOptions(
  options: DashboardRuntimeOptions,
): DashboardRuntimeOptions {
  return {
    ...options,
    authRequired:
      options.authRequired ?? readEnvFlag("JUNIOR_DASHBOARD_AUTH_REQUIRED"),
    allowedGoogleDomains:
      options.allowedGoogleDomains ??
      readEnvList("JUNIOR_DASHBOARD_GOOGLE_DOMAINS"),
    allowedEmails:
      options.allowedEmails ?? readEnvList("JUNIOR_DASHBOARD_ALLOWED_EMAILS"),
    trustedOrigins:
      options.trustedOrigins ?? readEnvList("JUNIOR_DASHBOARD_TRUSTED_ORIGINS"),
    componentGallery:
      options.componentGallery ??
      readEnvFlag("JUNIOR_DASHBOARD_COMPONENT_GALLERY"),
    mockConversations:
      options.mockConversations ??
      readEnvFlag("JUNIOR_DASHBOARD_MOCK_CONVERSATIONS"),
  };
}

function isJsonRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function isDashboardPagePath(
  pathname: string,
  basePath: string,
  options: { componentGallery?: boolean } = {},
): boolean {
  for (const { nested, path } of dashboardPagePaths(basePath, options)) {
    if (pathname === path || (nested && pathname.startsWith(`${path}/`))) {
      return true;
    }
  }

  return false;
}

interface DashboardReturnPathOptions {
  authenticatedRoutes?: readonly AuthenticatedRoute[];
  componentGallery?: boolean;
}

function dashboardReturnPath(
  url: URL,
  basePath: string,
  options: DashboardReturnPathOptions = {},
): string | undefined {
  if (
    !isDashboardPagePath(url.pathname, basePath, options) &&
    !isAuthPath(url.pathname, options.authenticatedRoutes ?? [])
  ) {
    return undefined;
  }

  const path = `${url.pathname}${url.search}`;
  return path === basePath ? undefined : path;
}

function requestedReturnPath(
  url: URL,
  basePath: string,
  options: DashboardReturnPathOptions = {},
): string | undefined {
  const next = url.searchParams.get(LOGIN_NEXT_PARAM);
  if (!next?.startsWith("/") || next.startsWith("//")) {
    return undefined;
  }

  const returnUrl = new URL(next, url.origin);
  if (
    returnUrl.origin !== url.origin ||
    (!isDashboardPagePath(returnUrl.pathname, basePath, options) &&
      !isAuthPath(returnUrl.pathname, options.authenticatedRoutes ?? []))
  ) {
    return undefined;
  }

  return `${returnUrl.pathname}${returnUrl.search}`;
}

function dashboardLoginUrl(
  request: Request,
  basePath: string,
  canonicalBaseURL?: string,
  options: DashboardReturnPathOptions = {},
): string {
  const requestUrl = new URL(request.url);
  const url = canonicalBaseURL
    ? new URL(canonicalBaseURL)
    : new URL(request.url);
  url.pathname = dashboardLoginPath(basePath);
  url.search = "";
  const returnPath = dashboardReturnPath(requestUrl, basePath, options);
  if (returnPath) {
    url.searchParams.set(LOGIN_NEXT_PARAM, returnPath);
  }
  return url.toString();
}

function canonicalRequestUrl(
  request: Request,
  canonicalBaseURL: string | undefined,
): string | undefined {
  if (!canonicalBaseURL) {
    return undefined;
  }

  const requestUrl = new URL(request.url);
  const canonicalUrl = new URL(canonicalBaseURL);
  if (requestUrl.origin === canonicalUrl.origin) {
    return undefined;
  }

  canonicalUrl.pathname = requestUrl.pathname;
  canonicalUrl.search = requestUrl.search;
  return canonicalUrl.toString();
}

function dashboardLoginPath(basePath: string): string {
  return basePath === "/" ? "/auth/login" : `${basePath}/auth/login`;
}

function callbackUrl(
  request: Request,
  basePath: string,
  options: DashboardReturnPathOptions = {},
): string {
  const requestUrl = new URL(request.url);
  const returnPath = requestedReturnPath(requestUrl, basePath, options);
  const url = new URL(request.url);
  if (returnPath) {
    const returnUrl = new URL(returnPath, requestUrl.origin);
    url.pathname = returnUrl.pathname;
    url.search = returnUrl.search;
  } else {
    url.pathname = basePath;
    url.search = "";
  }
  return url.toString();
}

function unauthorized(
  request: Request,
  basePath: string,
  canonicalBaseURL?: string,
  options: DashboardReturnPathOptions = {},
): Response {
  if (isJsonRoute(new URL(request.url).pathname)) {
    return jsonResponse(
      apiErrorSchema,
      { error: "unauthenticated" },
      { status: 401 },
    );
  }
  return Response.redirect(
    dashboardLoginUrl(request, basePath, canonicalBaseURL, options),
    302,
  );
}

function forbidden(request: Request, agentName: string): Response {
  if (!isJsonRoute(new URL(request.url).pathname)) {
    return renderForbiddenPage(agentName);
  }
  return jsonResponse(apiErrorSchema, { error: "forbidden" }, { status: 403 });
}

function localAuthBypassSession(email = LOCAL_VIEWER_EMAIL): DashboardSession {
  return {
    user: {
      email,
      emailVerified: true,
    },
  };
}

/** Build a local mock viewer without creating a durable Junior user. */
function mockViewerFromSession(session: DashboardSession) {
  const email = verifiedDashboardSessionEmail(session);
  if (!email) return undefined;
  const displayName =
    mockDisplayNamesByEmail.get(email) ??
    session.user.name?.trim() ??
    undefined;
  return {
    email,
    id: `mock-user:${email}`,
    identities: [],
    ...(displayName ? { displayName } : undefined),
  };
}

function dashboardTimeZone(): string {
  return process.env.JUNIOR_TIMEZONE || "America/Los_Angeles";
}

function pluginRoutePrefix(pluginName: string): string {
  return `/api/plugins/${pluginName}`;
}

/** Strip the core-owned plugin prefix before dispatching to a plugin app. */
function pluginRouteRequest(request: Request, prefix: string): Request {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const nextPath =
    pathname === prefix ? "/" : pathname.slice(prefix.length) || "/";
  url.pathname = nextPath.startsWith("/") ? nextPath : `/${nextPath}`;
  return new Request(url, request);
}

/** Build the sanitized per-request context passed into plugin API route apps. */
function pluginRouteContext(
  pluginName: string,
  session: DashboardSession,
): PluginApiRouteRequestContext {
  const { email, emailVerified, name } = session.user;
  return {
    auth: {
      user: {
        email,
        emailVerified,
        name,
      },
    },
    pluginName,
  } satisfies PluginApiRouteRequestContext;
}

/** Create the authenticated dashboard Hono app mounted by Nitro. */
export function createDashboardApp(
  rawOptions: DashboardRuntimeOptions,
): Hono<{ Variables: Variables }> {
  const options = resolveDashboardOptions(rawOptions);

  if (process.env.SENTRY_DSN?.trim()) {
    initSentry();
  }

  const basePath = normalizeDashboardPath(
    options.basePath ?? DEFAULT_BASE_PATH,
    DEFAULT_BASE_PATH,
  );
  const authPath = normalizeDashboardPath(
    options.authPath ?? DEFAULT_AUTH_PATH,
    DEFAULT_AUTH_PATH,
  );
  const allowedDomains = normalizeValues(options.allowedGoogleDomains);
  const allowedEmails = normalizeValues(options.allowedEmails);
  const agentName = options.agentName?.trim() || "Junior";

  const authRequired = options.authRequired !== false;
  const configuredBaseURL = options.baseURL ?? process.env.JUNIOR_BASE_URL;
  let canonicalBaseURL: string | undefined;
  if (authRequired && (configuredBaseURL || !options.auth)) {
    canonicalBaseURL = resolveDashboardBaseURL({ baseURL: configuredBaseURL });
  }

  if (
    authRequired &&
    allowedDomains.length === 0 &&
    allowedEmails.length === 0
  ) {
    throw new Error(
      "Junior dashboard auth requires allowedGoogleDomains or allowedEmails",
    );
  }

  const auth = authRequired
    ? (options.auth ??
      createDashboardAuth({
        agentName,
        authPath,
        baseURL: options.baseURL,
        trustedOrigins: options.trustedOrigins ?? [],
        googleHostedDomain: resolveGoogleHostedDomainHint(allowedDomains),
        sessionMaxAgeSeconds: options.sessionMaxAgeSeconds,
      }))
    : undefined;
  const app = new Hono<{ Variables: Variables }>();
  const authenticatedRoutes = options.authenticatedRoutes ?? [];

  app.get(dashboardLoginPath(basePath), async (c) => {
    const canonicalUrl = canonicalRequestUrl(c.req.raw, canonicalBaseURL);
    if (canonicalUrl) return Response.redirect(canonicalUrl, 302);
    const returnUrl = callbackUrl(c.req.raw, basePath, {
      authenticatedRoutes,
      componentGallery: options.componentGallery,
    });
    if (!auth) {
      return Response.redirect(returnUrl, 302);
    }
    const session = await auth.getSession(c.req.raw);
    if (
      session &&
      dashboardSessionIsAuthorized(session, allowedDomains, allowedEmails)
    ) {
      return Response.redirect(returnUrl, 302);
    }
    return auth.signInWithGoogle(c.req.raw, returnUrl);
  });

  if (auth) {
    app.on(["GET", "POST"], `${authPath}/*`, (c) => auth.handler(c.req.raw));
  }

  app.get("/favicon.ico", () => renderFavicon());
  app.get(DASHBOARD_MANIFEST_PATH, () => renderManifest(basePath, agentName));
  app.get(DASHBOARD_INSTALL_ICON_PATH, () => renderInstallIcon());

  /**
   * Require dashboard auth for every later route; login, Better Auth callbacks,
   * favicon, install manifest, and install icon are the only registration-order
   * bypasses.
   */
  const requireAuth = async (
    c: Context<{ Variables: Variables }>,
    next: Next,
  ) => {
    const pathname = new URL(c.req.url).pathname;
    const appRoute = isAuthPath(pathname, authenticatedRoutes);
    if (appRoute) {
      const canonicalUrl = canonicalRequestUrl(c.req.raw, canonicalBaseURL);
      if (canonicalUrl) return Response.redirect(canonicalUrl, 302);
    }
    if (!authRequired) {
      const session = localAuthBypassSession();
      c.set("authSession", session);
      if (pathname.startsWith("/api/") || appRoute) {
        const viewer = options.mockConversations
          ? mockViewerFromSession(session)
          : await resolveViewerUser(LOCAL_VIEWER_EMAIL);
        if (!viewer) {
          throw new Error("Local dashboard viewer could not be resolved");
        }
        c.set("viewer", viewer);
      }
      await next();
      return;
    }

    if (!auth) {
      return unauthorized(c.req.raw, basePath, canonicalBaseURL, {
        authenticatedRoutes,
        componentGallery: options.componentGallery,
      });
    }
    const browserSession = await auth.getSession(c.req.raw);
    const token = dashboardPersonalBearerToken(c.req.raw);
    const tokenEmail =
      !appRoute &&
      !browserSession &&
      token &&
      (c.req.method === "GET" || c.req.method === "HEAD") &&
      pathname.startsWith("/api/") &&
      !pathname.startsWith("/api/personal-tokens")
        ? await authenticatePersonalToken(token)
        : undefined;
    const session =
      browserSession ??
      (tokenEmail ? dashboardBearerSession(tokenEmail) : null);
    if (!session) {
      return unauthorized(c.req.raw, basePath, canonicalBaseURL, {
        authenticatedRoutes,
        componentGallery: options.componentGallery,
      });
    }
    if (!dashboardSessionIsAuthorized(session, allowedDomains, allowedEmails)) {
      return forbidden(c.req.raw, agentName);
    }
    const sanitizedSession = sanitizeDashboardSession(session);
    c.set("authSession", sanitizedSession);
    // Resolve the canonical user only for authenticated API requests.
    if (pathname.startsWith("/api/") || appRoute) {
      const email = verifiedDashboardSessionEmail(sanitizedSession);
      if (!email) {
        throw new Error(
          "Authenticated dashboard session has no verified email",
        );
      }
      // Mock reporting stays local and does not require durable user rows.
      const viewer = options.mockConversations
        ? mockViewerFromSession(sanitizedSession)
        : await resolveViewerUser(email);
      if (!viewer) {
        throw new Error("Authenticated dashboard user could not be resolved");
      }
      c.set("viewer", viewer);
    }
    await next();
  };

  app.use("*", requireAuth);

  for (const route of authenticatedRoutes) {
    const handler = (c: Context<{ Variables: Variables }>) => {
      const viewer = c.get("viewer");
      if (!viewer) {
        throw new Error("Authenticated app route has no resolved user");
      }
      return route.handler(c.req.raw, viewer);
    };
    const methods =
      typeof route.method === "string"
        ? [route.method]
        : (route.method ?? ["ALL"]);
    const explicitMethods = methods.filter((method) => method !== "ALL");
    if (methods.includes("ALL")) {
      app.all(route.path, handler);
    } else if (explicitMethods.length > 0) {
      app.on(explicitMethods, route.path, handler);
    }
  }

  for (const { nested, path } of dashboardPagePaths(basePath, {
    componentGallery: options.componentGallery,
  })) {
    app.get(path, () => renderDashboard(basePath, agentName));
    if (nested) {
      app.get(`${path}/*`, () => renderDashboard(basePath, agentName));
    }
  }
  for (const route of options.pluginRoutes ?? []) {
    const prefix = pluginRoutePrefix(route.pluginName);
    const handler = (c: Context<{ Variables: Variables }>) =>
      route.app.fetch(
        pluginRouteRequest(c.req.raw, prefix),
        pluginApiRouteRequestContextSchema.parse(
          pluginRouteContext(route.pluginName, c.get("authSession")),
        ),
      );
    app.all(prefix, handler);
    app.all(`${prefix}/*`, handler);
  }
  if (options.mockConversations) {
    app.route("/api", createMockReportingApi());
  }
  app.route("/", createJuniorApi());
  app.get("/api/config", () => {
    return jsonResponse(dashboardConfigSchema, {
      allowedEmailCount: allowedEmails.length,
      allowedGoogleDomainCount: allowedDomains.length,
      authRequired,
      authPath,
      basePath,
      componentGallery: options.componentGallery === true,
      sentryConversationLinks: hasSentryConversationLinks(),
      timeZone: dashboardTimeZone(),
      version: JUNIOR_VERSION,
    });
  });
  app.get("/api/me", (c) => {
    const session = c.get("authSession");
    const viewer = c.get("viewer");
    return jsonResponse(dashboardIdentitySchema, {
      user: {
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        name: viewer?.displayName ?? session.user.name,
      },
    });
  });
  app.patch("/api/me", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonResponse(
        apiErrorSchema,
        { error: "Invalid request body." },
        { status: 400 },
      );
    }
    const parsed = dashboardProfileUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Invalid request body." },
        { status: 400 },
      );
    }
    const viewer = c.get("viewer");
    if (!viewer) {
      return jsonResponse(
        apiErrorSchema,
        { error: "Authentication required." },
        { status: 401 },
      );
    }
    const session = c.get("authSession");
    // Mock reporting keeps profile edits process-local and out of SQL.
    if (options.mockConversations) {
      mockDisplayNamesByEmail.set(viewer.email, parsed.data.displayName);
      return jsonResponse(dashboardIdentitySchema, {
        user: {
          email: session.user.email,
          emailVerified: session.user.emailVerified,
          name: parsed.data.displayName,
        },
      });
    }
    const updated = await updateViewerDisplayName(
      viewer.id,
      parsed.data.displayName,
    );
    if (!updated) {
      return jsonResponse(
        apiErrorSchema,
        { error: "User not found." },
        { status: 404 },
      );
    }
    return jsonResponse(dashboardIdentitySchema, {
      user: {
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        name: updated.displayName,
      },
    });
  });
  app.get(DASHBOARD_CLIENT_PATH, () => {
    return new Response(readDashboardClient(), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/javascript; charset=utf-8",
      },
    });
  });
  app.get(DASHBOARD_AVATAR_HEADER_PATH, () => {
    return new Response(readDashboardAvatarHeader(), {
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        "content-type": "image/png",
      },
    });
  });
  app.notFound((c) =>
    isJsonRoute(new URL(c.req.url).pathname)
      ? jsonResponse(
          apiErrorSchema,
          { error: "Resource not found." },
          { status: 404 },
        )
      : c.text("Not Found", 404),
  );

  return app;
}
