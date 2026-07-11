import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@sentry/junior";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createDashboardApp } from "../src/app";
import {
  createDashboardAuth,
  type DashboardAuth,
  type DashboardSession,
} from "../src/auth";
import { filterConversations } from "../src/client/format";
import type { Conversation } from "../src/client/types";

const dashboardEnvNames = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "JUNIOR_SECRET",
  "JUNIOR_BASE_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
  "JUNIOR_DASHBOARD_AUTH_REQUIRED",
  "JUNIOR_DASHBOARD_GOOGLE_DOMAINS",
  "JUNIOR_DASHBOARD_ALLOWED_EMAILS",
  "JUNIOR_DASHBOARD_TRUSTED_ORIGINS",
  "JUNIOR_DASHBOARD_MOCK_CONVERSATIONS",
  "SENTRY_DSN",
  "SENTRY_ORG_SLUG",
] as const;

function auth(
  session: DashboardSession | null,
  onSignIn?: (callbackURL: string) => void,
): DashboardAuth {
  return {
    async handler() {
      return Response.json({ ok: true });
    },
    async getSession() {
      return session;
    },
    async signInWithGoogle(_request, callbackURL) {
      onSignIn?.(callbackURL);
      return Response.redirect(
        "https://accounts.google.com/o/oauth2/v2/auth",
        302,
      );
    },
  };
}

function dashboard(session: DashboardSession | null) {
  return createDashboardApp({
    allowedGoogleDomains: ["sentry.io"],
    allowedEmails: ["admin@example.com"],
    auth: auth(session),
  });
}

function mockDashboardVirtualConfig() {
  vi.doMock("#junior/config", () => ({
    createDashboardApp,
    dashboard: undefined,
    pluginRuntimeRegistrations: [],
    pluginSet: undefined,
    plugins: undefined,
  }));
}

describe("dashboard routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const name of dashboardEnvNames) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    vi.doUnmock("#junior/config");
    for (const name of dashboardEnvNames) {
      delete process.env[name];
    }
  });

  it("redirects unauthenticated dashboard page requests to login", async () => {
    const app = dashboard(null);

    const response = await app.fetch(new Request("http://localhost/"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://localhost/auth/login",
    );
  });

  it("protects sub-routes at root basePath from unauthenticated access", async () => {
    // app.use("/", ...) only matches the exact root in Hono; sub-routes like
    // /conversations and /plugins must be covered by a wildcard middleware.
    const app = dashboard(null);

    for (const path of [
      "/conversations",
      "/conversations/slack%3AC1%3A123",
      "/conversations/slack%3AC1%3A123?view=tools",
      "/plugins",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(`${location.origin}${location.pathname}`).toBe(
        "http://localhost/auth/login",
      );
      expect(location.searchParams.get("next")).toBe(path);
    }
  });

  it("uses the requested dashboard path as the Google sign-in callback", async () => {
    let callbackURL: string | undefined;
    const app = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth(null, (value) => {
        callbackURL = value;
      }),
    });
    const unauthenticated = await app.fetch(
      new Request("http://localhost/conversations/slack%3AC1%3A123?view=tools"),
    );
    const loginUrl = unauthenticated.headers.get("location");
    expect(loginUrl).toBeTruthy();

    const signIn = await app.fetch(new Request(loginUrl!));

    expect(signIn.status).toBe(302);
    expect(callbackURL).toBe(
      "http://localhost/conversations/slack%3AC1%3A123?view=tools",
    );
  });

  it("starts OAuth on the JUNIOR_BASE_URL origin", async () => {
    process.env.BETTER_AUTH_URL = "https://legacy-auth.example.com";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    let callbackURL: string | undefined;
    const app = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth(null, (value) => {
        callbackURL = value;
      }),
    });
    const canonicalLogin =
      "https://junior.example.com/auth/login?next=%2Fconversations%2Fslack%253AC1%253A123%3Fview%3Dtools";

    const directLogin = await app.fetch(
      new Request(
        "https://junior-prod.vercel.app/auth/login?next=%2Fconversations%2Fslack%253AC1%253A123%3Fview%3Dtools",
      ),
    );

    expect(directLogin.status).toBe(302);
    expect(directLogin.headers.get("location")).toBe(canonicalLogin);
    expect(callbackURL).toBeUndefined();

    const unauthenticated = await app.fetch(
      new Request(
        "https://junior-prod.vercel.app/conversations/slack%3AC1%3A123?view=tools",
      ),
    );

    expect(unauthenticated.status).toBe(302);
    expect(unauthenticated.headers.get("location")).toBe(canonicalLogin);

    const signIn = await app.fetch(
      new Request(unauthenticated.headers.get("location")!),
    );

    expect(signIn.status).toBe(302);
    expect(signIn.headers.get("location")).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(callbackURL).toBe(
      "https://junior.example.com/conversations/slack%3AC1%3A123?view=tools",
    );
  });

  it("preserves non-root dashboard base paths through Google sign-in", async () => {
    let callbackURL: string | undefined;
    const app = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth(null, (value) => {
        callbackURL = value;
      }),
      basePath: "/ops",
    });

    const unauthenticated = await app.fetch(
      new Request("http://localhost/ops/conversations/slack%3AC1%3A123"),
    );
    const loginUrl = unauthenticated.headers.get("location");
    expect(loginUrl).toBeTruthy();
    expect(new URL(loginUrl!).searchParams.get("next")).toBe(
      "/ops/conversations/slack%3AC1%3A123",
    );

    const signIn = await app.fetch(new Request(loginUrl!));

    expect(signIn.status).toBe(302);
    expect(callbackURL).toBe(
      "http://localhost/ops/conversations/slack%3AC1%3A123",
    );
  });

  it("starts sign-in when the auth prefix overlaps the login route", async () => {
    const app = createDashboardApp({
      allowedEmails: ["admin@example.com"],
      auth: auth(null),
      authPath: "/auth",
    });

    const response = await app.fetch(
      new Request("http://localhost/auth/login"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
  });

  it("falls back to the dashboard root for unsafe login return paths", async () => {
    let callbackURL: string | undefined;
    const app = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth(null, (value) => {
        callbackURL = value;
      }),
    });

    const response = await app.fetch(
      new Request(
        "http://localhost/auth/login?next=https%3A%2F%2Fevil.example%2Fconversations",
      ),
    );

    expect(response.status).toBe(302);
    expect(callbackURL).toBe("http://localhost/");
  });

  it("does not restart Google sign-in for an already authorized session", async () => {
    let startedGoogleSignIn = false;
    const app = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth(
        {
          user: {
            email: "person@sentry.io",
            emailVerified: true,
            hostedDomain: "sentry.io",
          },
        },
        () => {
          startedGoogleSignIn = true;
        },
      ),
    });

    const response = await app.fetch(
      new Request(
        "http://localhost/auth/login?next=%2Fconversations%2Fslack%253AC1%253A123",
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://localhost/conversations/slack%3AC1%3A123",
    );
    expect(startedGoogleSignIn).toBe(false);
  });

  it("can explicitly disable dashboard auth for local development", async () => {
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
    });

    const page = await app.fetch(new Request("http://localhost/"));
    expect(page.status).toBe(200);

    const me = await app.fetch(new Request("http://localhost/api/me"));
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: {
        email: "local-dashboard@localhost",
        emailVerified: true,
        hostedDomain: "localhost",
      },
    });
  });

  it("rejects unauthenticated product API requests without diagnostics", async () => {
    const app = dashboard(null);

    for (const path of [
      "/api/health",
      "/api/runtime",
      "/api/plugins",
      "/api/skills",
      "/api/conversations",
      "/api/conversations/stats",
      "/api/people",
      "/api/people/person%40sentry.io",
      "/api/plugin-reports",
      "/api/conversations/slack%3AC1%3A123",
      "/api/conversations/slack%3AC1%3A123/subagents/advisor-call",
      "/api/config",
      "/api/me",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
    }

    const client = await app.fetch(
      new Request("http://localhost/_junior/dashboard/client.js"),
    );
    expect(client.status).toBe(302);
    expect(client.headers.get("location")).toBe("http://localhost/auth/login");
  });

  it("allows verified users from an allowed Google hosted domain", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/runtime"),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: string[] };
    expect(body.providers).toEqual(expect.any(Array));
  });

  it("renders the authenticated ops deck shell", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
      },
    });

    const response = await app.fetch(new Request("http://localhost/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>Junior</title>");
    expect(html).toContain("Loading Junior");
    expect(html).toContain("junior-rainbow-flow");
    expect(html).toMatch(/\/_junior\/dashboard\/client\.js\?v=[a-z0-9]+/);
    expect(html).toContain("__JUNIOR_DASHBOARD_BASE_PATH__");
  });

  it("renders React Router dashboard page routes", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
      },
    });

    for (const path of [
      "/conversations",
      "/people",
      "/people/person%40sentry.io",
      "/plugins",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("<title>Junior</title>");
    }
  });

  it("serves the dashboard client bundle without browser caching", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/_junior/dashboard/client.js"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain(
      "application/javascript",
    );
    expect(await response.text()).not.toMatch(/\bfrom\s*["']lucide-react["']/);
  });

  it("serves the dashboard favicon without auth noise", async () => {
    const app = dashboard(null);

    const response = await app.fetch(
      new Request("http://localhost/favicon.ico"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("returns the signed-in identity", async () => {
    const app = dashboard({
      session: {
        token: "secret-session-token",
      },
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
        name: "Dashboard User",
      },
    } as DashboardSession);

    const me = await app.fetch(new Request("http://localhost/api/me"));
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
        name: "Dashboard User",
      },
    });
  });

  it("returns safe dashboard config signals", async () => {
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    process.env.SENTRY_ORG_SLUG = "sentry";
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/config"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      allowedEmailCount: 1,
      allowedGoogleDomainCount: 1,
      authRequired: true,
      authPath: "/api/auth",
      basePath: "/",
      sentryConversationLinks: true,
      timeZone: "America/Los_Angeles",
    });
  });

  it("rejects verified users outside the allowed Google hosted domain", async () => {
    const app = dashboard({
      user: {
        email: "person@example.com",
        emailVerified: true,
        hostedDomain: "example.com",
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/runtime"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("renders a browser-readable forbidden page for denied dashboard routes", async () => {
    const app = dashboard({
      user: {
        email: "person@example.com",
        emailVerified: true,
        hostedDomain: "example.com",
      },
    });

    const response = await app.fetch(new Request("http://localhost/"));

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<style>");
    expect(html).toContain("Access denied");
  });

  it("allows explicitly configured email exceptions", async () => {
    const app = dashboard({
      user: {
        email: "admin@example.com",
        emailVerified: true,
        hostedDomain: "example.com",
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/runtime"),
    );

    expect(response.status).toBe(200);
  });

  it("requires verified email for explicitly configured email exceptions", async () => {
    const app = dashboard({
      user: {
        email: "admin@example.com",
        emailVerified: false,
        hostedDomain: "example.com",
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/runtime"),
    );

    expect(response.status).toBe(403);
  });

  it("mounts dashboard routes through core app config", async () => {
    mockDashboardVirtualConfig();
    const app = await createApp({
      dashboard: {
        authRequired: false,
        allowedGoogleDomains: ["sentry.io"],
      },
      plugins: defineJuniorPlugins([]),
    });

    const dashboard = await app.fetch(new Request("http://localhost/"));
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("dashboard-root");

    const info = await app.fetch(new Request("http://localhost/api/runtime"));
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      cwd: expect.any(String),
      providers: expect.any(Array),
    });

    const health = await app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "ok",
      service: "junior",
    });

    const oldInfo = await app.fetch(new Request("http://localhost/api/info"));
    expect(oldInfo.status).toBe(404);
  });

  it("mounts plugin API route apps under the authenticated namespace", async () => {
    mockDashboardVirtualConfig();
    const pluginApp = new Hono();
    pluginApp.get("/memories", (c) => {
      return c.json({ path: c.req.path, ok: true });
    });

    const app = await createApp({
      dashboard: {
        authRequired: false,
        allowedGoogleDomains: ["sentry.io"],
      },
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "memory",
            displayName: "Memory",
            description: "Memory plugin",
          },
          hooks: {
            apiRoutes() {
              return pluginApp;
            },
          },
        }),
      ]),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/plugins/memory/memories"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: "/memories",
      ok: true,
    });

    const health = await app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
  });

  it("protects plugin API route apps with dashboard auth", async () => {
    const pluginApp = new Hono();
    pluginApp.get("/memories", (c) => {
      return c.json({ path: c.req.path, ok: true });
    });

    const unauthenticated = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth(null),
      pluginRoutes: [{ app: pluginApp, pluginName: "memory" }],
    });

    const denied = await unauthenticated.fetch(
      new Request("http://localhost/api/plugins/memory/memories"),
    );

    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toEqual({
      error: "unauthenticated",
    });

    const authenticated = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth({
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          hostedDomain: "sentry.io",
        },
      }),
      pluginRoutes: [{ app: pluginApp, pluginName: "memory" }],
    });

    const allowed = await authenticated.fetch(
      new Request("http://localhost/api/plugins/memory/memories"),
    );

    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({
      path: "/memories",
      ok: true,
    });
  });

  it("passes sanitized auth context to plugin API route apps", async () => {
    let pluginContext: unknown;
    const authenticated = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth({
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          hostedDomain: "sentry.io",
          name: "Person",
        },
      }),
      pluginRoutes: [
        {
          app: {
            fetch(_request, context) {
              pluginContext = context;
              return Response.json({ ok: true });
            },
          },
          pluginName: "memory",
        },
      ],
    });

    const response = await authenticated.fetch(
      new Request("http://localhost/api/plugins/memory/memories"),
    );

    expect(response.status).toBe(200);
    expect(pluginContext).toEqual({
      auth: {
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          hostedDomain: "sentry.io",
          name: "Person",
        },
      },
      pluginName: "memory",
    });
  });

  it("resolves auth policy from env when dashboard options omit allowlists", async () => {
    process.env.JUNIOR_DASHBOARD_GOOGLE_DOMAINS = "sentry.io, example.com";
    process.env.JUNIOR_DASHBOARD_ALLOWED_EMAILS = JSON.stringify([
      "admin@example.com",
    ]);
    process.env.JUNIOR_DASHBOARD_TRUSTED_ORIGINS = "https://junior.example.com";
    process.env.JUNIOR_DASHBOARD_MOCK_CONVERSATIONS = "true";

    const app = createDashboardApp({
      auth: auth({
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          hostedDomain: "sentry.io",
        },
      }),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/config"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      allowedEmailCount: 1,
      allowedGoogleDomainCount: 2,
      authRequired: true,
    });
  });

  it("fails clearly when list env JSON is malformed", async () => {
    process.env.JUNIOR_DASHBOARD_ALLOWED_EMAILS = '["admin@example.com"';

    expect(() =>
      createDashboardApp({
        authRequired: false,
      }),
    ).toThrow("JUNIOR_DASHBOARD_ALLOWED_EMAILS must be a JSON string array");
  });

  it("keeps active conversations in the default recent filter", () => {
    const conversations = [
      {
        cumulativeDurationMs: 0,
        displayTitle: "Active",
        id: "active",
        lastProgressAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        surface: "internal",
      },
      {
        cumulativeDurationMs: 0,
        displayTitle: "Completed",
        id: "completed",
        lastProgressAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        surface: "internal",
      },
    ] as Conversation[];

    expect(
      filterConversations(conversations, "recent").map(
        (conversation) => conversation.id,
      ),
    ).toEqual(["active", "completed"]);
  });

  it("uses JUNIOR_SECRET as the default Better Auth secret", () => {
    process.env.JUNIOR_SECRET = "junior-secret";

    expect(() =>
      createDashboardAuth({
        authPath: "/api/auth",
        trustedOrigins: [],
      }),
    ).toThrow("GOOGLE_CLIENT_ID is required for Junior dashboard auth");
  });

  it("defaults dashboard auth to the local development URL", () => {
    process.env.JUNIOR_SECRET = "junior-secret";
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";

    expect(() =>
      createDashboardAuth({
        authPath: "/api/auth",
        trustedOrigins: [],
      }),
    ).not.toThrow();
  });

  it("derives the Better Auth base URL from Junior deployment env", () => {
    process.env.JUNIOR_SECRET = "junior-secret";
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";

    expect(() =>
      createDashboardAuth({
        authPath: "/api/auth",
        trustedOrigins: [],
      }),
    ).not.toThrow();
  });

  it("preserves the Better Auth OAuth state cookie during Google sign-in", async () => {
    const auth = createDashboardAuth({
      authPath: "/api/auth",
      googleClientId: "google-client-id",
      googleClientSecret: "google-client-secret",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
    });

    const response = await auth.signInWithGoogle(
      new Request("http://localhost/auth/login"),
      "http://localhost/",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("accounts.google.com");
    expect(response.headers.get("set-cookie")).toContain("oauth_state");
  });
});
