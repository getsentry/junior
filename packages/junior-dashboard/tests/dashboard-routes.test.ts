import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@sentry/junior";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import type { JuniorReporting } from "@sentry/junior/reporting";
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
          packages: [],
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
    async listConversations() {
      return {
        source: "conversation_index",
        generatedAt: "2026-05-29T00:00:00.000Z",
        conversations: [
          {
            conversationId: "slack:C1:123",
            cumulativeDurationMs: 0,
            id: "turn-1",
            status: "active",
            startedAt: "2026-05-29T00:00:00.000Z",
            lastSeenAt: "2026-05-29T00:00:01.000Z",
            lastProgressAt: "2026-05-29T00:00:01.000Z",
            surface: "slack",
            displayTitle: "Conversation",
            channel: "C1",
            requesterIdentity: {
              email: "person@sentry.io",
              fullName: "Person Example",
            },
          },
        ],
      };
    },
    async getConversationStats() {
      return {
        active: 1,
        conversations: 1,
        durationMs: 0,
        failed: 0,
        generatedAt: "2026-05-29T00:00:00.000Z",
        hung: 0,
        locations: [
          {
            active: 1,
            conversations: 1,
            durationMs: 0,
            failed: 0,
            hung: 0,
            label: "Public Channel",
            runs: 1,
          },
        ],
        requesters: [
          {
            active: 1,
            conversations: 1,
            durationMs: 0,
            failed: 0,
            hung: 0,
            label: "Unknown",
            runs: 1,
          },
        ],
        sampleLimit: 1,
        sampleSize: 1,
        source: "conversation_index",
        truncated: false,
        runs: 1,
        windowEnd: "2026-05-29T00:00:00.000Z",
        windowStart: "2026-05-22T00:00:00.000Z",
      };
    },
    async listRecentConversations() {
      return [];
    },
    async listRequesters() {
      return {
        generatedAt: "2026-05-29T00:00:00.000Z",
        people: [
          {
            active: 1,
            activeDays: 1,
            conversations: 1,
            durationMs: 0,
            failed: 0,
            firstSeenAt: "2026-05-29T00:00:00.000Z",
            hung: 0,
            lastSeenAt: "2026-05-29T00:00:01.000Z",
            requester: {
              email: "person@sentry.io",
              fullName: "Person Example",
            },
            runs: 1,
          },
        ],
        sampleLimit: 1,
        sampleSize: 1,
        source: "conversation_index",
        truncated: false,
      };
    },
    async getRequesterProfile(email: string) {
      return {
        activityDays: [
          {
            active: 1,
            conversations: 1,
            date: "2026-05-29",
            durationMs: 0,
            failed: 0,
            hung: 0,
            runs: 1,
          },
        ],
        generatedAt: "2026-05-29T00:00:00.000Z",
        locations: [
          {
            active: 1,
            conversations: 1,
            durationMs: 0,
            failed: 0,
            hung: 0,
            label: "Public Channel",
            runs: 1,
          },
        ],
        recentConversations: [
          {
            conversationId: "slack:C1:123",
            cumulativeDurationMs: 0,
            id: "turn-1",
            status: "active",
            startedAt: "2026-05-29T00:00:00.000Z",
            lastSeenAt: "2026-05-29T00:00:01.000Z",
            lastProgressAt: "2026-05-29T00:00:01.000Z",
            surface: "slack",
            displayTitle: "Conversation",
            channel: "C1",
            requesterIdentity: {
              email,
              fullName: "Person Example",
            },
          },
        ],
        requester: {
          email,
          fullName: "Person Example",
        },
        sampleLimit: 1,
        sampleSize: 1,
        source: "conversation_index",
        surfaces: [
          {
            active: 1,
            conversations: 1,
            durationMs: 0,
            failed: 0,
            hung: 0,
            label: "Conversation",
            runs: 1,
          },
        ],
        totals: {
          active: 1,
          activeDays: 1,
          conversations: 1,
          durationMs: 0,
          failed: 0,
          hung: 0,
          runs: 1,
        },
        truncated: false,
        windowEnd: "2026-05-29T00:00:00.000Z",
        windowStart: "2025-05-29T00:00:00.000Z",
      };
    },
    async getPluginOperationalReports() {
      return {
        source: "plugins",
        generatedAt: "2026-05-29T00:00:00.000Z",
        reports: [
          {
            pluginName: "scheduler",
            metrics: [{ label: "active", value: "1" }],
          },
        ],
      };
    },
    async getConversation(conversationId: string) {
      return {
        conversationId,
        displayTitle: "Conversation",
        generatedAt: "2026-05-29T00:00:00.000Z",
        sentryConversationUrl:
          "https://sentry.sentry.io/explore/conversations/slack%3AC1%3A123/?project=1",
        runs: [
          {
            conversationId,
            cumulativeDurationMs: 0,
            id: "turn-1",
            status: "active",
            startedAt: "2026-05-29T00:00:00.000Z",
            lastSeenAt: "2026-05-29T00:00:01.000Z",
            lastProgressAt: "2026-05-29T00:00:01.000Z",
            surface: "slack",
            displayTitle: "Conversation",
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
    async getConversationSubagentTranscript(
      _conversationId,
      _runId,
      subagentId,
    ) {
      return {
        type: "subagent",
        createdAt: "2026-05-29T00:00:01.000Z",
        endedAt: "2026-05-29T00:00:02.000Z",
        id: subagentId,
        outcome: "success",
        parentToolCallId: "advisor-call",
        status: "success",
        subagentKind: "advisor",
        transcriptAvailable: true,
        transcriptMessageCount: 1,
        transcript: [
          {
            role: "assistant",
            parts: [{ type: "text", text: "Advisor transcript." }],
          },
        ],
      };
    },
  };
}

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
      expect(response.status, path).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(`${location.origin}${location.pathname}`, path).toBe(
        "http://localhost/auth/login",
      );
      expect(location.searchParams.get("next"), path).toBe(path);
    }
  });

  it("uses the requested dashboard path as the Google sign-in callback", async () => {
    let callbackURL: string | undefined;
    const app = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth(null, (value) => {
        callbackURL = value;
      }),
      reporting: reporting(),
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

  it("preserves non-root dashboard base paths through Google sign-in", async () => {
    let callbackURL: string | undefined;
    const app = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth(null, (value) => {
        callbackURL = value;
      }),
      basePath: "/ops",
      reporting: reporting(),
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
      reporting: reporting(),
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
      reporting: reporting(),
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
      reporting: reporting(),
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
      reporting: reporting(),
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
      "/api/conversations/slack%3AC1%3A123/runs/turn-1/subagents/advisor-call",
      "/api/config",
      "/api/me",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect(response.status, path).toBe(401);
      expect(await response.json(), path).toEqual({ error: "unauthenticated" });
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

      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toContain("text/html");
      const html = await response.text();
      expect(html, path).toContain("<title>Junior</title>");
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

  it("returns command center API slices for authenticated users", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
      },
    });

    const runtime = await app.fetch(
      new Request("http://localhost/api/runtime"),
    );
    expect(runtime.status).toBe(200);
    expect(await runtime.json()).toMatchObject({
      cwd: "/workspace",
      providers: ["github"],
    });

    const plugins = await app.fetch(
      new Request("http://localhost/api/plugins"),
    );
    expect(plugins.status).toBe(200);
    expect(await plugins.json()).toEqual([{ name: "github" }]);

    const skills = await app.fetch(new Request("http://localhost/api/skills"));
    expect(skills.status).toBe(200);
    expect(await skills.json()).toEqual([
      { name: "triage", pluginProvider: "github" },
    ]);

    const conversationStats = await app.fetch(
      new Request("http://localhost/api/conversations/stats"),
    );
    expect(conversationStats.status).toBe(200);
    expect(await conversationStats.json()).toMatchObject({
      active: 1,
      conversations: 1,
      requesters: [{ label: "Unknown", conversations: 1 }],
      sampleLimit: 1,
      sampleSize: 1,
      source: "conversation_index",
      truncated: false,
    });

    const pluginReports = await app.fetch(
      new Request("http://localhost/api/plugin-reports"),
    );
    expect(pluginReports.status).toBe(200);
    expect(await pluginReports.json()).toMatchObject({
      reports: [
        {
          pluginName: "scheduler",
          metrics: [{ label: "active", value: "1" }],
        },
      ],
      source: "plugins",
    });

    const people = await app.fetch(new Request("http://localhost/api/people"));
    expect(people.status).toBe(200);
    expect(await people.json()).toMatchObject({
      people: [
        {
          conversations: 1,
          requester: {
            email: "person@sentry.io",
          },
        },
      ],
      source: "conversation_index",
    });

    const profile = await app.fetch(
      new Request("http://localhost/api/people/person%40sentry.io"),
    );
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      recentConversations: [
        {
          conversationId: "slack:C1:123",
        },
      ],
      requester: {
        email: "person@sentry.io",
      },
      totals: {
        conversations: 1,
      },
    });
  });

  it("returns empty conversation stats for legacy reporting providers", async () => {
    const { getConversationStats: _getConversationStats, ...legacyReporting } =
      reporting();
    expect(_getConversationStats).toBeTypeOf("function");
    const app = dashboard(
      {
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          hostedDomain: "sentry.io",
        },
      },
      legacyReporting,
    );

    const conversationStats = await app.fetch(
      new Request("http://localhost/api/conversations/stats"),
    );

    expect(conversationStats.status).toBe(200);
    expect(await conversationStats.json()).toMatchObject({
      conversations: 0,
      requesters: [],
      sampleLimit: 0,
      sampleSize: 0,
      source: "conversation_index",
      truncated: false,
    });
  });

  it("returns a failure status when conversation stats reporting throws", async () => {
    const customReporting = {
      ...reporting(),
      async getConversationStats() {
        throw new Error("conversation stats unavailable");
      },
    };
    const app = dashboard(
      {
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          hostedDomain: "sentry.io",
        },
      },
      customReporting,
    );

    const conversationStats = await app.fetch(
      new Request("http://localhost/api/conversations/stats"),
    );

    expect(conversationStats.status).toBe(500);
    expect(await conversationStats.json()).toEqual({
      error: "Conversation stats failed to load.",
    });
  });

  it("returns an empty plugin report feed for legacy reporting providers", async () => {
    const {
      getPluginOperationalReports: _getPluginOperationalReports,
      ...legacyReporting
    } = reporting();
    expect(_getPluginOperationalReports).toBeTypeOf("function");
    const app = dashboard(
      {
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          hostedDomain: "sentry.io",
        },
      },
      legacyReporting,
    );

    const pluginReports = await app.fetch(
      new Request("http://localhost/api/plugin-reports"),
    );

    expect(pluginReports.status).toBe(200);
    expect(await pluginReports.json()).toMatchObject({
      reports: [],
      source: "plugins",
    });
  });

  it("returns a failure status when plugin reporting throws", async () => {
    const customReporting = {
      ...reporting(),
      async getPluginOperationalReports() {
        throw new Error("plugin reporting unavailable");
      },
    };
    const app = dashboard(
      {
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          hostedDomain: "sentry.io",
        },
      },
      customReporting,
    );

    const pluginReports = await app.fetch(
      new Request("http://localhost/api/plugin-reports"),
    );

    expect(pluginReports.status).toBe(500);
    expect(await pluginReports.json()).toEqual({
      error: "Plugin stats failed to load.",
    });
  });

  it("returns the signed-in identity and conversation feed", async () => {
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

    const conversations = await app.fetch(
      new Request("http://localhost/api/conversations"),
    );
    expect(conversations.status).toBe(200);
    expect(await conversations.json()).toMatchObject({
      conversations: [
        {
          conversationId: "slack:C1:123",
          id: "turn-1",
          status: "active",
        },
      ],
      source: "conversation_index",
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
      new Request("http://localhost/api/conversations/slack%3AC1%3A123"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversationId: "slack:C1:123",
      runs: [
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

  it("returns authenticated subagent transcript details", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        hostedDomain: "sentry.io",
      },
    });

    const response = await app.fetch(
      new Request(
        "http://localhost/api/conversations/slack%3AC1%3A123/runs/turn-1/subagents/advisor-call",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "advisor-call",
      parentToolCallId: "advisor-call",
      subagentKind: "advisor",
      transcriptAvailable: true,
      transcript: [
        {
          role: "assistant",
          parts: [{ type: "text", text: "Advisor transcript." }],
        },
      ],
    });
  });

  it("returns redacted private conversation details without transcript payloads", async () => {
    const privateReporting = reporting();
    privateReporting.getConversation = async (conversationId: string) => ({
      conversationId,
      displayTitle: "Conversation",
      generatedAt: "2026-05-29T00:00:00.000Z",
      runs: [
        {
          conversationId,
          cumulativeDurationMs: 1_000,
          id: "turn-1",
          status: "completed",
          startedAt: "2026-05-29T00:00:00.000Z",
          lastSeenAt: "2026-05-29T00:00:01.000Z",
          lastProgressAt: "2026-05-29T00:00:01.000Z",
          surface: "slack",
          displayTitle: "Conversation",
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
      new Request("http://localhost/api/conversations/slack%3AD1%3A123"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      conversationId: "slack:D1:123",
      runs: [
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
        reporting: reporting(),
      },
      plugins: defineJuniorPlugins([]),
    });

    const dashboard = await app.fetch(new Request("http://localhost/"));
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("dashboard-root");

    const info = await app.fetch(new Request("http://localhost/api/runtime"));
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      descriptionText: "Dashboard test",
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
        reporting: reporting(),
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
      reporting: reporting(),
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
      reporting: reporting(),
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
      reporting: reporting(),
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
      reporting: reporting(),
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
        reporting: reporting(),
      }),
    ).toThrow("JUNIOR_DASHBOARD_ALLOWED_EMAILS must be a JSON string array");
  });

  it("keeps active conversations in the default recent filter", () => {
    const conversations = [
      {
        id: "active",
        status: "active",
        runs: [{ status: "active" }],
      },
      {
        id: "completed",
        status: "completed",
        runs: [{ status: "completed" }],
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
      new Request("http://localhost/auth/login"),
      "http://localhost/",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("accounts.google.com");
    expect(response.headers.get("set-cookie")).toContain("oauth_state");
  });
});
