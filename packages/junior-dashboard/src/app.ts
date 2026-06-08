import { Hono, type Context, type Next } from "hono";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  ConversationStatsReport,
  PluginOperationalReportFeed,
  JuniorReporting,
} from "@sentry/junior/reporting";
import { createJuniorReporting } from "@sentry/junior/reporting";
import { initSentry } from "@sentry/junior/instrumentation";
import { dashboardClientAsset, dashboardTailwindAsset } from "./assets";
import {
  createDashboardAuth,
  resolveGoogleHostedDomainHint,
  sanitizeDashboardSession,
  type DashboardAuth,
  type DashboardSession,
} from "./auth";
import { dashboardRainbowProgressClass } from "./dashboardLoader";
import { createMockConversationReporting } from "./mock-conversations";

const DEFAULT_BASE_PATH = "/";
const DEFAULT_AUTH_PATH = "/api/auth";
const DASHBOARD_CLIENT_VERSION = Date.now().toString(36);
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
  reporting?: JuniorReporting;
  mockConversations?: boolean;
}

type Variables = {
  dashboardSession: DashboardSession;
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

function isJsonRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function isDashboardPagePath(pathname: string, basePath: string): boolean {
  for (const path of dashboardPagePaths(basePath)) {
    if (
      pathname === path ||
      (path !== "/" && pathname.startsWith(`${path}/`))
    ) {
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

function dashboardLoginUrl(request: Request, basePath: string): string {
  const requestUrl = new URL(request.url);
  const url = new URL(request.url);
  url.pathname = "/api/dashboard/login";
  url.search = "";
  const returnPath = dashboardReturnPath(requestUrl, basePath);
  if (returnPath) {
    url.searchParams.set(LOGIN_NEXT_PARAM, returnPath);
  }
  return url.toString();
}

function emptyPluginReportFeed(): PluginOperationalReportFeed {
  return {
    generatedAt: new Date().toISOString(),
    reports: [],
    source: "plugins",
  };
}

function emptyConversationStatsReport(): ConversationStatsReport {
  const nowMs = Date.now();
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    generatedAt: new Date(nowMs).toISOString(),
    hung: 0,
    locations: [],
    requesters: [],
    sampleLimit: 0,
    sampleSize: 0,
    source: "conversation_index",
    truncated: false,
    runs: 0,
    windowEnd: new Date(nowMs).toISOString(),
    windowStart: new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

async function readConversationStats(
  reporting: JuniorReporting,
): Promise<ConversationStatsReport> {
  if (!reporting.getConversationStats) {
    return emptyConversationStatsReport();
  }
  return await reporting.getConversationStats();
}

async function readPluginReports(
  reporting: JuniorReporting,
): Promise<PluginOperationalReportFeed> {
  if (!reporting.getPluginOperationalReports) {
    return emptyPluginReportFeed();
  }
  return await reporting.getPluginOperationalReports();
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
  const email = session.user.email?.toLowerCase();
  const domain = session.user.hostedDomain?.toLowerCase();

  if (session.user.emailVerified && email && allowedEmails.includes(email)) {
    return true;
  }

  return Boolean(
    session.user.emailVerified && domain && allowedDomains.includes(domain),
  );
}

function unauthorized(request: Request, basePath: string): Response {
  if (isJsonRoute(new URL(request.url).pathname)) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  return Response.redirect(dashboardLoginUrl(request, basePath), 302);
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

function dashboardSessionBypass(): DashboardSession {
  return {
    user: {
      email: "local-dashboard@localhost",
      emailVerified: true,
      hostedDomain: "localhost",
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

function dashboardPagePaths(basePath: string): string[] {
  return [
    basePath,
    basePath === "/" ? "/conversations" : `${basePath}/conversations`,
    basePath === "/" ? "/plugins" : `${basePath}/plugins`,
    basePath === "/" ? "/sessions" : `${basePath}/sessions`,
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
  <script type="module" src="/api/dashboard/client.js?v=${DASHBOARD_CLIENT_VERSION}"></script>
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

/** Create the authenticated dashboard Hono app mounted by Nitro. */
export function createDashboardApp(
  options: JuniorDashboardOptions,
): Hono<{ Variables: Variables }> {
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
  const baseReporting = options.reporting ?? createJuniorReporting();
  const reporting = options.mockConversations
    ? createMockConversationReporting(baseReporting)
    : baseReporting;
  const app = new Hono<{ Variables: Variables }>();

  if (auth) {
    app.on(["GET", "POST"], `${authPath}/*`, (c) => auth.handler(c.req.raw));
  }

  app.get("/favicon.ico", () => renderFavicon());

  app.get("/api/dashboard/login", async (c) => {
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

  const requireDashboardSession = async (
    c: Context<{ Variables: Variables }>,
    next: Next,
  ) => {
    if (!authRequired) {
      c.set("dashboardSession", dashboardSessionBypass());
      await next();
      return;
    }

    if (!auth) {
      return unauthorized(c.req.raw, basePath);
    }
    const session = await auth.getSession(c.req.raw);
    if (!session) {
      return unauthorized(c.req.raw, basePath);
    }
    if (!isAuthorized(session, allowedDomains, allowedEmails)) {
      return forbidden(c.req.raw);
    }
    c.set("dashboardSession", sanitizeDashboardSession(session));
    await next();
  };

  if (basePath === "/") {
    // When mounted at root, a wildcard is required to cover all sub-routes
    // (e.g. /conversations, /plugins, /sessions). `app.use("/", ...)` only
    // matches the exact root path in Hono and leaves those routes unprotected.
    app.use("/*", requireDashboardSession);
  } else {
    app.use(basePath, requireDashboardSession);
    app.use(`${basePath}/*`, requireDashboardSession);
  }
  app.use("/api/dashboard/*", requireDashboardSession);

  for (const path of dashboardPagePaths(basePath)) {
    app.get(path, () => renderDashboard(basePath));
    if (path !== "/") {
      app.get(`${path}/*`, () => renderDashboard(basePath));
    }
  }
  app.get("/api/dashboard/health", async () => {
    return Response.json(await reporting.getHealth());
  });
  app.get("/api/dashboard/runtime", async () => {
    return Response.json(await reporting.getRuntimeInfo());
  });
  app.get("/api/dashboard/plugins", async () => {
    return Response.json(await reporting.getPlugins());
  });
  app.get("/api/dashboard/skills", async () => {
    return Response.json(await reporting.getSkills());
  });
  app.get("/api/dashboard/sessions", async () => {
    return Response.json(await reporting.getSessions());
  });
  app.get("/api/dashboard/conversation-stats", async () => {
    try {
      return Response.json(await readConversationStats(reporting));
    } catch {
      return Response.json(
        { error: "Conversation stats failed to load." },
        { status: 500 },
      );
    }
  });
  app.get("/api/dashboard/plugin-reports", async () => {
    try {
      return Response.json(await readPluginReports(reporting));
    } catch {
      return Response.json(
        { error: "Plugin stats failed to load." },
        { status: 500 },
      );
    }
  });
  app.get("/api/dashboard/conversations/:conversationId", async (c) => {
    return Response.json(
      await reporting.getConversation(
        decodeURIComponent(c.req.param("conversationId")),
      ),
    );
  });
  app.get("/api/dashboard/config", () => {
    return Response.json({
      allowedEmailCount: allowedEmails.length,
      allowedGoogleDomainCount: allowedDomains.length,
      authRequired,
      authPath,
      basePath,
      sentryConversationLinks: hasSentryConversationLinks(),
      timeZone: dashboardTimeZone(),
    });
  });
  app.get("/api/dashboard/me", (c) => {
    return Response.json(c.get("dashboardSession"));
  });
  app.get("/api/dashboard/info", async () => {
    return Response.json(await reporting.getRuntimeInfo());
  });
  app.get("/api/dashboard/client.js", () => {
    return new Response(readDashboardClient(), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/javascript; charset=utf-8",
      },
    });
  });

  return app;
}
