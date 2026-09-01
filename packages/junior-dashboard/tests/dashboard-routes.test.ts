import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app";
import type { DashboardSession } from "../src/auth";
import { auth, resetDashboardEnv } from "./dashboard-test-helpers";

const { resolveViewerUser, updateViewerDisplayName } = vi.hoisted(() => ({
  resolveViewerUser: vi.fn(async (email: string) => ({
    email,
    id: `user:${email}`,
    identities: [] as [],
  })),
  updateViewerDisplayName: vi.fn(async (id: string, displayName: string) => ({
    displayName,
    email: id.slice("user:".length),
    id,
    identities: [] as [],
  })),
}));
vi.mock("@sentry/junior/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/junior/api")>()),
  resolveViewerUser,
  updateViewerDisplayName,
}));

function dashboard(session: DashboardSession | null) {
  return createDashboardApp({
    allowedGoogleDomains: ["sentry.io"],
    allowedEmails: ["admin@example.com"],
    auth: auth(session),
  });
}

describe("dashboard routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDashboardEnv();
  });

  afterEach(() => {
    vi.doUnmock("#junior/config");
    resetDashboardEnv();
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
    // app.use("/", ...) only matches the exact root in Hono; detail routes
    // must be covered by the dashboard wildcard middleware.
    const app = dashboard(null);

    for (const path of [
      "/code",
      "/conversations",
      "/conversations/slack%3AC1%3A123",
      "/conversations/slack%3AC1%3A123?view=tools",
      "/locations",
      "/locations/destination-1",
      "/system",
      "/system/plugins/github",
      "/tasks",
      "/tasks/task-1",
      "/tasks/scheduled/task-1/executions",
      "/memories",
      "/memories/memory-1",
      "/settings",
      "/settings/api-tokens",
      "/system/workspaces",
      "/system/workspaces/new",
      "/system/workspaces/11111111-1111-4111-8111-111111111111",
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

  it("returns authenticated host routes through Google sign-in", async () => {
    const path = "/_junior/acp/auth/11111111-1111-4111-8111-111111111111";
    let callbackURL: string | undefined;
    const handle = vi.fn(() => new Response("authenticated route"));
    const authenticatedRoutes = [
      {
        handler: handle,
        method: ["GET", "POST"] as const,
        path: "/_junior/acp/auth/:transactionId",
      },
    ];
    const unauthenticatedApp = createDashboardApp({
      authenticatedRoutes,
      allowedGoogleDomains: ["sentry.io"],
      auth: auth(null, (value) => {
        callbackURL = value;
      }),
    });
    const unauthenticated = await unauthenticatedApp.fetch(
      new Request(`http://localhost${path}`),
    );
    expect(unauthenticated.status).toBe(302);
    const loginURL = new URL(unauthenticated.headers.get("location")!);
    expect(loginURL.pathname).toBe("/auth/login");
    expect(loginURL.searchParams.get("next")).toBe(path);

    await unauthenticatedApp.fetch(new Request(loginURL));
    expect(callbackURL).toBe(`http://localhost${path}`);
    expect(handle).not.toHaveBeenCalled();

    const authenticatedApp = createDashboardApp({
      authenticatedRoutes,
      allowedGoogleDomains: ["sentry.io"],
      auth: auth({
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          name: "ACP User",
        },
      }),
    });
    const page = await authenticatedApp.request(`http://localhost${path}`);
    await expect(page.text()).resolves.toBe("authenticated route");
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET" }),
      expect.objectContaining({ id: "user:person@sentry.io" }),
    );
  });

  it("rejects disallowed users on authenticated host routes", async () => {
    const handle = vi.fn(() => new Response("authenticated route"));
    const app = createDashboardApp({
      authenticatedRoutes: [
        {
          handler: handle,
          path: "/_junior/acp/auth/:transactionId",
        },
      ],
      allowedGoogleDomains: ["sentry.io"],
      auth: auth({
        user: {
          email: "person@example.com",
          emailVerified: true,
        },
      }),
    });

    const response = await app.request(
      "/_junior/acp/auth/11111111-1111-4111-8111-111111111111",
    );

    expect(response.status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
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
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(await me.json()).toEqual({
      user: {
        email: "dev@example.com",
        emailVerified: true,
      },
    });
    expect(resolveViewerUser).toHaveBeenCalledWith("dev@example.com");

    const create = await app.fetch(
      new Request("http://localhost/api/conversations", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(create.status).toBe(400);
    await expect(create.json()).resolves.toEqual({
      error: "Invalid request body.",
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
      "/api/locations",
      "/api/locations/destination-1",
      "/api/plugin-reports",
      "/api/conversations/slack%3AC1%3A123",
      "/api/config",
      "/api/me",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
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
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/runtime"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { providers: string[] };
    expect(body.providers).toEqual(expect.any(Array));
  });

  it("allows verified users when Better Auth omits the Google hosted domain", async () => {
    const app = dashboard({
      user: {
        email: "person@SENTRY.IO",
        emailVerified: true,
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/runtime"),
    );

    expect(response.status).toBe(200);
  });

  it("requires a verified email for the allowed email-domain fallback", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: false,
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/runtime"),
    );

    expect(response.status).toBe(403);
  });

  it("updates the signed-in viewer display name", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        name: "Person",
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/me", {
        body: JSON.stringify({ displayName: "New Name" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        name: "New Name",
      },
    });
    expect(updateViewerDisplayName).toHaveBeenCalledWith(
      "user:person@sentry.io",
      "New Name",
    );
  });

  it("rejects an empty display name", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/me", {
        body: JSON.stringify({ displayName: "   " }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body." });
    expect(updateViewerDisplayName).not.toHaveBeenCalled();
  });

  it("keeps mock profile edits process-local", async () => {
    const app = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth({
        user: {
          email: "person@sentry.io",
          emailVerified: true,
          name: "Person",
        },
      }),
      mockConversations: true,
    });

    const response = await app.fetch(
      new Request("http://localhost/api/me", {
        body: JSON.stringify({ displayName: "Mock Name" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        name: "Mock Name",
      },
    });
    expect(updateViewerDisplayName).not.toHaveBeenCalled();

    const me = await app.fetch(new Request("http://localhost/api/me"));
    expect(await me.json()).toEqual({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        name: "Mock Name",
      },
    });
  });

  it("returns the signed-in identity", async () => {
    const app = dashboard({
      session: {
        token: "secret-session-token",
      },
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        name: "Dashboard User",
      },
    } as DashboardSession);

    const me = await app.fetch(new Request("http://localhost/api/me"));
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
        name: "Dashboard User",
      },
    });
  });

  it("preserves the enabled component gallery path through login", async () => {
    let callbackURL: string | undefined;
    const app = createDashboardApp({
      allowedEmails: ["admin@example.com"],
      auth: auth(null, (value) => {
        callbackURL = value;
      }),
      componentGallery: true,
    });

    const unauthenticated = await app.fetch(
      new Request("http://localhost/dev?fixture=charts"),
    );
    const loginUrl = unauthenticated.headers.get("location");
    expect(loginUrl).toBeTruthy();
    expect(new URL(loginUrl!).searchParams.get("next")).toBe(
      "/dev?fixture=charts",
    );

    await app.fetch(new Request(loginUrl!));
    expect(callbackURL).toBe("http://localhost/dev?fixture=charts");
  });

  it("returns safe dashboard config signals", async () => {
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    process.env.SENTRY_ORG_SLUG = "sentry";
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
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
      componentGallery: false,
      sentryConversationLinks: true,
      timeZone: "America/Los_Angeles",
      version: expect.stringMatching(/\S+/),
    });
  });

  it("rejects verified users outside the allowed Google hosted domain", async () => {
    const app = dashboard({
      user: {
        email: "person@example.com",
        emailVerified: true,
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/runtime"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("allows explicitly configured email exceptions", async () => {
    const app = dashboard({
      user: {
        email: "admin@example.com",
        emailVerified: true,
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
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/api/runtime"),
    );

    expect(response.status).toBe(403);
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

});
