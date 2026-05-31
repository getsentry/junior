import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@sentry/junior";
import type { JuniorReporting } from "@sentry/junior/reporting";
import { createDashboardApp } from "../src/app";
import {
  createDashboardAuth,
  type DashboardAuth,
  type DashboardSession,
} from "../src/auth";
import { filterConversations } from "../src/client/format";
import type { Conversation } from "../src/client/types";
import { resolveDashboardConfig } from "../src/config";
import { juniorDashboardNitro } from "../src/nitro";

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
  "SENTRY_DSN",
  "SENTRY_ORG_SLUG",
] as const;

function reporting(): JuniorReporting {
  return {
    async getHealth() {
      return {
        status: "ok",
        service: "junior",
        timestamp: "2026-05-29T00:00:00.000Z",
      };
    },
    async getRuntimeInfo() {
      return {
        cwd: "/workspace",
        homeDir: "/workspace/app",
        descriptionText: "Dashboard test",
        providers: ["github"],
        skills: [{ name: "triage", pluginProvider: "github" }],
        packagedContent: {
          packageNames: ["@sentry/junior-github"],
          manifestRoots: [],
          skillRoots: [],
          tracingIncludes: [],
        },
      };
    },
    async getPlugins() {
      return [{ name: "github" }];
    },
    async getSkills() {
      return [{ name: "triage", pluginProvider: "github" }];
    },
    async getSessions() {
      return {
        source: "turn_session_records",
        generatedAt: "2026-05-29T00:00:00.000Z",
        sessions: [
          {
            conversationId: "slack:C1:123",
            id: "turn-1",
            status: "active",
            startedAt: "2026-05-29T00:00:00.000Z",
            lastSeenAt: "2026-05-29T00:00:01.000Z",
            lastProgressAt: "2026-05-29T00:00:01.000Z",
            surface: "slack",
            title: "Turn turn-1",
            channel: "C1",
            sentryConversationUrl:
              "https://sentry.sentry.io/explore/conversations/slack%3AC1%3A123/?project=1",
          },
        ],
      };
    },
    async getConversation(conversationId: string) {
      return {
        conversationId,
        generatedAt: "2026-05-29T00:00:00.000Z",
        turns: [
          {
            conversationId,
            id: "turn-1",
            status: "active",
            startedAt: "2026-05-29T00:00:00.000Z",
            lastSeenAt: "2026-05-29T00:00:01.000Z",
            lastProgressAt: "2026-05-29T00:00:01.000Z",
            surface: "slack",
            title: "Turn turn-1",
            channel: "C1",
            transcriptAvailable: true,
            transcript: [
              {
                role: "assistant",
                parts: [
                  { type: "text", text: "Checking." },
                  {
                    type: "tool_call",
                    name: "search",
                    input: { query: "issue" },
                  },
                ],
              },
            ],
          },
        ],
      };
    },
  };
}

function auth(session: DashboardSession | null): DashboardAuth {
  return {
    async handler() {
      return Response.json({ ok: true });
    },
    async getSession() {
      return session;
    },
    async signInWithGoogle() {
      return Response.redirect(
        "https://accounts.google.com/o/oauth2/v2/auth",
        302,
      );
    },
  };
}

function dashboard(
  session: DashboardSession | null,
  customReporting: JuniorReporting = reporting(),
) {
  return createDashboardApp({
    allowedGoogleDomains: ["sentry.io"],
    allowedEmails: ["admin@example.com"],
    auth: auth(session),
    reporting: customReporting,
  });
}

describe("dashboard routes", () => {
  afterEach(() => {
    for (const name of dashboardEnvNames) {
      delete process.env[name];
    }
  });

  it("redirects unauthenticated dashboard page requests to login", async () => {
    const app = dashboard(null);

    const response = await app.fetch(new Request("http://localhost/"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://localhost/api/dashboard/login",
    );
  });

  it("protects sub-routes at root basePath from unauthenticated access", async () => {
    // app.use("/", ...) only matches the exact root in Hono; sub-routes like
    // /conversations and /sessions must be covered by a wildcard middleware.
    const app = dashboard(null);

    for (const path of [
      "/conversations",
      "/conversations/slack%3AC1%3A123",
      "/sessions",
      "/sessions/some-session",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(
        `http://localhost/api/dashboard/login`,
      );
    }
  });

  it("can explicitly disable dashboard auth for local development", async () => {
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      reporting: reporting(),
    });

    const page = await app.fetch(new Request("http://localhost/"));
    expect(page.status).toBe(200);

    const me = await app.fetch(
      new Request("http://localhost/api/dashboard/me"),
    );
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: {
        email: "local-dashboard@localhost",
        emailVerified: true,
        hostedDomain: "localhost",
      },
    });
  });

  it("rejects unauthenticated dashboard API requests without diagnostics", async () => {
    const app = dashboard(null);

    for (const path of [
      "/api/dashboard/health",
      "/api/dashboard/runtime",
      "/api/dashboard/plugins",
      "/api/dashboard/skills",
      "/api/dashboard/sessions",
      "/api/dashboard/conversations/slack%3AC1%3A123",
      "/api/dashboard/config",
      "/api/dashboard/me",
      "/api/dashboard/info",
      "/api/dashboard/client.js",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect(response.status, path).toBe(401);
      expect(await response.json(), path).toEqual({ error: "unauthenticated" });
    }
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
      new Request("http://localhost/api/dashboard/info"),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: string[] };
    expect(body.providers).toEqual(["github"]);
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
    expect(html).toMatch(/\/api\/dashboard\/client\.js\?v=[a-z0-9]+/);
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

    const response = await app.fetch(
      new Request("http://localhost/conversations"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>Junior</title>");
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
      new Request("http://localhost/api/dashboard/client.js"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain(
      "application/javascript",
    );
  });

  it("serves the dashboard favicon without auth noise", async () => {
    const app = dashboard(null);

    const response = await app.fetch(
      new Request("http://localhost/favicon.ico"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("returns command center API slices for authenticated users", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
      },
    });

    const runtime = await app.fetch(
      new Request("http://localhost/api/dashboard/runtime"),
    );
    expect(runtime.status).toBe(200);
    expect(await runtime.json()).toMatchObject({
      cwd: "/workspace",
      providers: ["github"],
    });

    const plugins = await app.fetch(
      new Request("http://localhost/api/dashboard/plugins"),
    );
    expect(plugins.status).toBe(200);
    expect(await plugins.json()).toEqual([{ name: "github" }]);

    const skills = await app.fetch(
      new Request("http://localhost/api/dashboard/skills"),
    );
    expect(skills.status).toBe(200);
    expect(await skills.json()).toEqual([
      { name: "triage", pluginProvider: "github" },
    ]);
  });

  it("returns the signed-in identity and session feed", async () => {
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

    const me = await app.fetch(
      new Request("http://localhost/api/dashboard/me"),
    );
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
        name: "Dashboard User",
      },
    });

    const sessions = await app.fetch(
      new Request("http://localhost/api/dashboard/sessions"),
    );
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toMatchObject({
      sessions: [
        {
          conversationId: "slack:C1:123",
          id: "turn-1",
          sentryConversationUrl:
            "https://sentry.sentry.io/explore/conversations/slack%3AC1%3A123/?project=1",
          status: "active",
        },
      ],
      source: "turn_session_records",
    });
  });

  it("returns authenticated conversation transcript details", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
      },
    });

    const response = await app.fetch(
      new Request(
        "http://localhost/api/dashboard/conversations/slack%3AC1%3A123",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversationId: "slack:C1:123",
      turns: [
        {
          id: "turn-1",
          transcriptAvailable: true,
          transcript: [
            {
              role: "assistant",
              parts: [
                { type: "text", text: "Checking." },
                { type: "tool_call", name: "search" },
              ],
            },
          ],
        },
      ],
    });
  });

  it("returns redacted private conversation details without transcript payloads", async () => {
    const privateReporting = reporting();
    privateReporting.getConversation = async (conversationId: string) => ({
      conversationId,
      generatedAt: "2026-05-29T00:00:00.000Z",
      turns: [
        {
          conversationId,
          id: "turn-1",
          status: "completed",
          startedAt: "2026-05-29T00:00:00.000Z",
          lastSeenAt: "2026-05-29T00:00:01.000Z",
          lastProgressAt: "2026-05-29T00:00:01.000Z",
          surface: "slack",
          title: "Turn turn-1",
          channel: "D1",
          transcriptAvailable: false,
          transcriptMessageCount: 2,
          transcriptRedacted: true,
          transcriptRedactionReason: "non_public_conversation",
          transcript: [],
        },
      ],
    });
    const app = dashboard(
      {
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          hostedDomain: "sentry.io",
        },
      },
      privateReporting,
    );

    const response = await app.fetch(
      new Request(
        "http://localhost/api/dashboard/conversations/slack%3AD1%3A123",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversationId: "slack:D1:123",
      turns: [
        {
          id: "turn-1",
          transcriptAvailable: false,
          transcriptMessageCount: 2,
          transcriptRedacted: true,
          transcriptRedactionReason: "non_public_conversation",
          transcript: [],
        },
      ],
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
      new Request("http://localhost/api/dashboard/config"),
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
      new Request("http://localhost/api/dashboard/info"),
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
      new Request("http://localhost/api/dashboard/info"),
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
      new Request("http://localhost/api/dashboard/info"),
    );

    expect(response.status).toBe(403);
  });

  it("does not intercept Junior runtime routes with route-scoped dispatch", async () => {
    const dashboardApp = dashboard(null);
    const juniorApp = await createApp();
    const fetch = (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (
        pathname === "/" ||
        pathname === "/conversations" ||
        pathname.startsWith("/conversations/") ||
        pathname === "/sessions" ||
        pathname.startsWith("/sessions/") ||
        pathname.startsWith("/api/dashboard/") ||
        pathname.startsWith("/api/auth/")
      ) {
        return dashboardApp.fetch(request);
      }
      return juniorApp.fetch(request);
    };

    const health = await fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "ok",
      service: "junior",
    });

    const oldInfo = await fetch(new Request("http://localhost/api/info"));
    expect(oldInfo.status).toBe(404);
  });

  it("registers dashboard Nitro routes before an existing catch-all route", () => {
    const nitro = {
      options: {
        routes: {
          "/**": { handler: "./server.ts" },
        },
        virtual: {} as Record<string, string>,
      },
    };

    juniorDashboardNitro({
      allowedGoogleDomains: ["sentry.io"],
      trustedOrigins: ["https://junior.example.com"],
    }).nitro.setup(nitro);

    expect(Object.keys(nitro.options.routes).slice(0, 8)).toEqual([
      "/",
      "/conversations",
      "/conversations/**",
      "/sessions",
      "/sessions/**",
      "/api/dashboard/**",
      "/api/auth",
      "/api/auth/**",
    ]);
    expect(nitro.options.routes["/**"]).toEqual({ handler: "./server.ts" });
    expect(nitro.options.virtual["#junior-dashboard/config"]).toContain(
      "sentry.io",
    );
    expect(nitro.options.virtual["#junior-dashboard/handler"]).toContain(
      "sentry.io",
    );
  });

  it("resolves auth policy from env when Nitro virtual config is unavailable", async () => {
    process.env.JUNIOR_DASHBOARD_GOOGLE_DOMAINS = "sentry.io, example.com";
    process.env.JUNIOR_DASHBOARD_ALLOWED_EMAILS = JSON.stringify([
      "admin@example.com",
    ]);
    process.env.JUNIOR_DASHBOARD_TRUSTED_ORIGINS = "https://junior.example.com";

    await expect(resolveDashboardConfig()).resolves.toEqual({
      authRequired: true,
      allowedGoogleDomains: ["sentry.io", "example.com"],
      allowedEmails: ["admin@example.com"],
      trustedOrigins: ["https://junior.example.com"],
    });
  });

  it("fails clearly when list env JSON is malformed", async () => {
    process.env.JUNIOR_DASHBOARD_ALLOWED_EMAILS = '["admin@example.com"';

    await expect(resolveDashboardConfig()).rejects.toThrow(
      "JUNIOR_DASHBOARD_ALLOWED_EMAILS must be a JSON string array",
    );
  });

  it("keeps active conversations in the default recent filter", () => {
    const conversations = [
      {
        id: "active",
        status: "active",
        turns: [{ status: "active" }],
      },
      {
        id: "completed",
        status: "completed",
        turns: [{ status: "completed" }],
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

  it("does not require BETTER_AUTH_URL in local development", () => {
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
      new Request("http://localhost/api/dashboard/login"),
      "http://localhost/",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("accounts.google.com");
    expect(response.headers.get("set-cookie")).toContain("oauth_state");
  });
});
