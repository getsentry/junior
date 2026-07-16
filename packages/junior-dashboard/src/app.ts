import { Hono, type Context, type Next } from "hono";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createJuniorApi } from "@sentry/junior/api";
import {
  conversationDetailReportSchema,
  conversationFeedQuerySchema,
  conversationFeedSchema,
  conversationParamsSchema,
  conversationStatsReportSchema,
  conversationSubagentTranscriptReportSchema,
  locationDetailReportSchema,
  locationDirectoryReportSchema,
  locationParamsSchema,
  personParamsSchema,
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  subagentParamsSchema,
} from "@sentry/junior/api/schema";
import { initSentry } from "@sentry/junior/instrumentation";
import type {
  PluginApiRouteRequestContext,
  PluginRouteApp,
} from "@sentry/junior-plugin-api";
import { pluginApiRouteRequestContextSchema } from "@sentry/junior-plugin-api";
import { dashboardConfigSchema, dashboardIdentitySchema } from "./api/schema";
import {
  dashboardAvatarHeaderAsset,
  dashboardClientAsset,
  dashboardTailwindAsset,
} from "./assets";
import {
  createDashboardAuth,
  resolveGoogleHostedDomainHint,
  sanitizeDashboardSession,
  type DashboardAuth,
  type DashboardSession,
} from "./auth";
import { dashboardRainbowProgressClass } from "./dashboardLoader";
import {
  readMockConversationDetail,
  readMockConversationFeed,
  readMockConversationStats,
  readMockConversationSubagent,
  readMockLocationDetail,
  readMockLocationDirectory,
  readMockPeopleDirectory,
  readMockPeopleProfile,
} from "./mock-conversations";
import { resolveDashboardBaseURL } from "./url";

const DEFAULT_BASE_PATH = "/";
const DEFAULT_AUTH_PATH = "/api/auth";
const DASHBOARD_CLIENT_VERSION = Date.now().toString(36);
const DASHBOARD_CLIENT_PATH = "/_junior/dashboard/client.js";
const DASHBOARD_AVATAR_HEADER_PATH = "/_junior/dashboard/avatar.png";
const LOGIN_NEXT_PARAM = "next";

export interface JuniorDashboardOptions {
  basePath?: string;
  baseURL?: string;
  authPath?: string;
  authRequired?: boolean;
  allowedGoogleDomains?: string[];
  allowedEmails?: string[];
  sessionMaxAgeSeconds?: number;
  trustedOrigins?: string[];
  auth?: DashboardAuth;
  mockConversations?: boolean;
}

interface DashboardRuntimeOptions extends JuniorDashboardOptions {
  pluginRoutes?: DashboardPluginRoute[];
}

interface DashboardPluginRoute {
  app: PluginRouteApp;
  pluginName: string;
}

type Variables = {
  authSession: DashboardSession;
};

function hasSentryConversationLinks(): boolean {
  return Boolean(
    process.env.SENTRY_DSN?.trim() && process.env.SENTRY_ORG_SLUG?.trim(),
  );
}

function normalizePath(path: string, fallback: string): string {
  const value = path.trim() || fallback;
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return stripTrailingSlashes(withSlash);
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
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
    mockConversations:
      options.mockConversations ??
      readEnvFlag("JUNIOR_DASHBOARD_MOCK_CONVERSATIONS"),
  };
}

function isJsonRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function isDashboardPagePath(pathname: string, basePath: string): boolean {
  for (const { nested, path } of dashboardPagePaths(basePath)) {
    if (pathname === path || (nested && pathname.startsWith(`${path}/`))) {
      return true;
    }
  }

  return false;
}

function dashboardReturnPath(url: URL, basePath: string): string | undefined {
  if (!isDashboardPagePath(url.pathname, basePath)) {
    return undefined;
  }

  const path = `${url.pathname}${url.search}`;
  return path === basePath ? undefined : path;
}

function requestedReturnPath(url: URL, basePath: string): string | undefined {
  const next = url.searchParams.get(LOGIN_NEXT_PARAM);
  if (!next?.startsWith("/") || next.startsWith("//")) {
    return undefined;
  }

  const returnUrl = new URL(next, url.origin);
  if (
    returnUrl.origin !== url.origin ||
    !isDashboardPagePath(returnUrl.pathname, basePath)
  ) {
    return undefined;
  }

  return `${returnUrl.pathname}${returnUrl.search}`;
}

function dashboardLoginUrl(
  request: Request,
  basePath: string,
  canonicalBaseURL?: string,
): string {
  const requestUrl = new URL(request.url);
  const url = canonicalBaseURL
    ? new URL(canonicalBaseURL)
    : new URL(request.url);
  url.pathname = dashboardLoginPath(basePath);
  url.search = "";
  const returnPath = dashboardReturnPath(requestUrl, basePath);
  if (returnPath) {
    url.searchParams.set(LOGIN_NEXT_PARAM, returnPath);
  }
  return url.toString();
}

function canonicalLoginUrl(
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

function callbackUrl(request: Request, basePath: string): string {
  const requestUrl = new URL(request.url);
  const returnPath = requestedReturnPath(requestUrl, basePath);
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

function isAuthorized(
  session: DashboardSession,
  allowedDomains: string[],
  allowedEmails: string[],
): boolean {
  const email = session.user.email.toLowerCase();
  const emailSeparator = email.lastIndexOf("@");
  const emailDomain =
    emailSeparator > 0 ? email.slice(emailSeparator + 1) : undefined;

  if (session.user.emailVerified && email && allowedEmails.includes(email)) {
    return true;
  }

  return Boolean(
    session.user.emailVerified &&
      emailDomain &&
      allowedDomains.includes(emailDomain),
  );
}

function unauthorized(
  request: Request,
  basePath: string,
  canonicalBaseURL?: string,
): Response {
  if (isJsonRoute(new URL(request.url).pathname)) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  return Response.redirect(
    dashboardLoginUrl(request, basePath, canonicalBaseURL),
    302,
  );
}

function forbidden(request: Request): Response {
  if (!isJsonRoute(new URL(request.url).pathname)) {
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Junior access denied</title>
  <style>
    ${readDashboardTailwind()}
  </style>
</head>
<body class="m-0 bg-black font-sans text-white [color-scheme:dark]">
  <main class="grid min-h-screen place-items-center p-8">
    <section class="max-w-lg border-l-4 border-rose-400 pl-4">
      <h1 class="m-0 mb-3 text-[1.75rem] font-bold leading-tight">Access denied</h1>
      <p class="m-0 leading-relaxed text-[#b8b8b8]">Your Google account is authenticated, but it is not allowed to use this Junior dashboard.</p>
    </section>
  </main>
</body>
</html>`,
      {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
        status: 403,
      },
    );
  }
  return Response.json({ error: "forbidden" }, { status: 403 });
}

function localAuthBypassSession(
  email = "local-dashboard@localhost.test",
): DashboardSession {
  return {
    user: {
      email,
      emailVerified: true,
    },
  };
}

function readAssetUrl(url: URL): string {
  if (!existsSync(url)) {
    return "";
  }
  return readFileSync(url, "utf8");
}

function readWorkspaceAsset(fileName: string): string {
  const assetPath = path.join(
    process.cwd(),
    "node_modules",
    "@sentry",
    "junior-dashboard",
    "dist",
    fileName,
  );
  if (!existsSync(assetPath)) {
    return "";
  }
  return readFileSync(assetPath, "utf8");
}

function readDashboardClient(): string {
  const client =
    dashboardClientAsset ||
    readAssetUrl(new URL("./client.js", import.meta.url)) ||
    readAssetUrl(new URL("../dist/client.js", import.meta.url)) ||
    readWorkspaceAsset("client.js");
  if (!client) {
    throw new Error("Junior dashboard client bundle was not found");
  }
  return client;
}

function dashboardTimeZone(): string {
  return process.env.JUNIOR_TIMEZONE || "America/Los_Angeles";
}

function readDashboardTailwind(): string {
  return (
    dashboardTailwindAsset ||
    readAssetUrl(new URL("./tailwind.css", import.meta.url)) ||
    readAssetUrl(new URL("../dist/tailwind.css", import.meta.url)) ||
    readWorkspaceAsset("tailwind.css")
  );
}

function readDashboardAvatarHeader(): ArrayBuffer {
  if (dashboardAvatarHeaderAsset) {
    return Uint8Array.from(Buffer.from(dashboardAvatarHeaderAsset, "base64"))
      .buffer;
  }

  const assetUrl = new URL("./assets/junior-avatar-line.png", import.meta.url);
  if (!existsSync(assetUrl)) {
    throw new Error("Junior dashboard avatar asset was not found");
  }
  return Uint8Array.from(readFileSync(assetUrl)).buffer;
}

function dashboardPagePaths(
  basePath: string,
): Array<{ nested?: boolean; path: string }> {
  return [
    { path: basePath },
    {
      nested: true,
      path: basePath === "/" ? "/conversations" : `${basePath}/conversations`,
    },
    {
      nested: true,
      path: basePath === "/" ? "/people" : `${basePath}/people`,
    },
    {
      nested: true,
      path: basePath === "/" ? "/locations" : `${basePath}/locations`,
    },
    { path: basePath === "/" ? "/system" : `${basePath}/system` },
  ];
}

function renderDashboard(basePath: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Junior</title>
  <style>
    ${readDashboardTailwind()}
  </style>
</head>
<body class="m-0 bg-black text-white [color-scheme:dark]">
  <div id="dashboard-root">
    <main class="grid min-h-screen place-items-center bg-black px-4 py-8 font-sans text-white md:px-8" aria-busy="true">
      <section class="grid w-full max-w-lg grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border border-white/15 bg-[#0b0b0b] p-4">
        <div class="grid size-9 shrink-0 select-none place-items-center bg-black text-[0.82rem] font-black leading-none text-white">Jr</div>
        <div class="min-w-0">
          <div class="font-bold">Loading Junior</div>
          <div class="${dashboardRainbowProgressClass} mt-3 h-1.5 w-full" role="progressbar" aria-label="Loading Junior"></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    window.__JUNIOR_DASHBOARD_BASE_PATH__ = ${JSON.stringify(basePath)};
    (function () {
      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }
      function errorText(error) {
        if (!error) return "Unknown dashboard error";
        if (typeof error === "string") return error;
        if (error.stack) return error.stack;
        if (error.message) return error.message;
        try {
          return JSON.stringify(error, null, 2);
        } catch (_error) {
          return String(error);
        }
      }
      window.__JUNIOR_DASHBOARD_SHOW_ERROR__ = function (error) {
        var root = document.getElementById("dashboard-root");
        if (!root) return;
        root.innerHTML =
          '<main class="grid min-h-screen place-items-center bg-black p-8 text-white">' +
          '<section class="w-full max-w-5xl border border-rose-400/50 bg-[#0b0b0b] p-5 font-sans">' +
          '<div class="font-mono text-xs uppercase leading-none text-[#888]">Dashboard Error</div>' +
          '<h1 class="mt-2 text-3xl font-bold leading-tight tracking-normal">Junior failed to render</h1>' +
          '<p class="my-4 max-w-3xl text-[#b8b8b8]">The dashboard hit a client-side exception. The stack trace is shown here so the page does not fail blank.</p>' +
          '<pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words border border-white/10 bg-black p-4 font-mono text-sm leading-relaxed text-white">' +
          escapeHtml(errorText(error)) +
          "</pre></section></main>";
      };
      window.addEventListener("error", function (event) {
        window.__JUNIOR_DASHBOARD_SHOW_ERROR__(event.error || event.message);
      });
      window.addEventListener("unhandledrejection", function (event) {
        window.__JUNIOR_DASHBOARD_SHOW_ERROR__(event.reason);
      });
    })();
  </script>
  <script type="module" src="${DASHBOARD_CLIENT_PATH}?v=${DASHBOARD_CLIENT_VERSION}"></script>
</body>
</html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

function renderFavicon(): Response {
  return new Response(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#000000"/><text x="16" y="20.5" fill="#ffffff" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="11" font-weight="900" text-anchor="middle">Jr</text></svg>`,
    { headers: { "content-type": "image/svg+xml" } },
  );
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

  const basePath = normalizePath(
    options.basePath ?? DEFAULT_BASE_PATH,
    DEFAULT_BASE_PATH,
  );
  const authPath = normalizePath(
    options.authPath ?? DEFAULT_AUTH_PATH,
    DEFAULT_AUTH_PATH,
  );
  const allowedDomains = normalizeValues(options.allowedGoogleDomains);
  const allowedEmails = normalizeValues(options.allowedEmails);

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
        authPath,
        baseURL: options.baseURL,
        trustedOrigins: options.trustedOrigins ?? [],
        googleHostedDomain: resolveGoogleHostedDomainHint(allowedDomains),
        sessionMaxAgeSeconds: options.sessionMaxAgeSeconds,
      }))
    : undefined;
  const app = new Hono<{ Variables: Variables }>();

  app.get(dashboardLoginPath(basePath), async (c) => {
    const canonicalUrl = canonicalLoginUrl(c.req.raw, canonicalBaseURL);
    if (canonicalUrl) {
      return Response.redirect(canonicalUrl, 302);
    }
    const returnUrl = callbackUrl(c.req.raw, basePath);
    if (!auth) {
      return Response.redirect(returnUrl, 302);
    }
    const session = await auth.getSession(c.req.raw);
    if (session && isAuthorized(session, allowedDomains, allowedEmails)) {
      return Response.redirect(returnUrl, 302);
    }
    return auth.signInWithGoogle(c.req.raw, returnUrl);
  });

  if (auth) {
    app.on(["GET", "POST"], `${authPath}/*`, (c) => auth.handler(c.req.raw));
  }

  app.get("/favicon.ico", () => renderFavicon());

  /**
   * Require dashboard auth for every later route; login, Better Auth callbacks,
   * and favicon are the only registration-order bypasses.
   */
  const requireAuth = async (
    c: Context<{ Variables: Variables }>,
    next: Next,
  ) => {
    if (!authRequired) {
      c.set(
        "authSession",
        localAuthBypassSession(
          options.mockConversations ? "morgan@sentry.io" : undefined,
        ),
      );
      await next();
      return;
    }

    if (!auth) {
      return unauthorized(c.req.raw, basePath, canonicalBaseURL);
    }
    const session = await auth.getSession(c.req.raw);
    if (!session) {
      return unauthorized(c.req.raw, basePath, canonicalBaseURL);
    }
    if (!isAuthorized(session, allowedDomains, allowedEmails)) {
      return forbidden(c.req.raw);
    }
    c.set("authSession", sanitizeDashboardSession(session));
    await next();
  };

  app.use("*", requireAuth);

  for (const { nested, path } of dashboardPagePaths(basePath)) {
    app.get(path, () => renderDashboard(basePath));
    if (nested) {
      app.get(`${path}/*`, () => renderDashboard(basePath));
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
    app.get("/api/people", () => {
      return Response.json(
        actorDirectoryReportSchema.parse(readMockPeopleDirectory()),
      );
    });
    app.get("/api/people/:email", (c) => {
      const { email } = personParamsSchema.parse(c.req.param());
      const report = readMockPeopleProfile(email);
      return report
        ? Response.json(actorProfileReportSchema.parse(report))
        : Response.json({ error: "Person not found." }, { status: 404 });
    });
    app.get("/api/locations", () => {
      return Response.json(
        locationDirectoryReportSchema.parse(readMockLocationDirectory()),
      );
    });
    app.get("/api/locations/:locationId", (c) => {
      const { locationId } = locationParamsSchema.parse(c.req.param());
      const report = readMockLocationDetail(locationId);
      return report
        ? Response.json(locationDetailReportSchema.parse(report))
        : Response.json({ error: "Location not found." }, { status: 404 });
    });
    app.get("/api/conversations", (c) => {
      const query = conversationFeedQuerySchema.safeParse(c.req.query());
      if (!query.success) {
        return Response.json(
          { error: "Invalid query parameters." },
          { status: 400 },
        );
      }
      const { actorEmail } = query.data;
      return Response.json(
        conversationFeedSchema.parse(readMockConversationFeed(actorEmail)),
      );
    });
    app.get("/api/conversations/stats", () => {
      return Response.json(
        conversationStatsReportSchema.parse(readMockConversationStats()),
      );
    });
    app.get("/api/conversations/:conversationId", (c) => {
      const { conversationId } = conversationParamsSchema.parse(c.req.param());
      const report = readMockConversationDetail(conversationId);
      return report
        ? Response.json(conversationDetailReportSchema.parse(report))
        : Response.json({ error: "Conversation not found." }, { status: 404 });
    });
    app.get("/api/conversations/:conversationId/subagents/:subagentId", (c) => {
      const { conversationId, subagentId } = subagentParamsSchema.parse(
        c.req.param(),
      );
      const report = conversationSubagentTranscriptReportSchema.parse(
        readMockConversationSubagent(conversationId, subagentId),
      );
      return report.unavailableReason === "not_found"
        ? Response.json(report, { status: 404 })
        : Response.json(report);
    });
  }
  app.route("/", createJuniorApi());
  app.get("/api/config", () => {
    return Response.json(
      dashboardConfigSchema.parse({
        allowedEmailCount: allowedEmails.length,
        allowedGoogleDomainCount: allowedDomains.length,
        authRequired,
        authPath,
        basePath,
        sentryConversationLinks: hasSentryConversationLinks(),
        timeZone: dashboardTimeZone(),
      }),
    );
  });
  app.get("/api/me", (c) => {
    return Response.json(dashboardIdentitySchema.parse(c.get("authSession")));
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

  return app;
}
