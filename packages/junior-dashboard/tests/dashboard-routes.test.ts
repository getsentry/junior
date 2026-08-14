import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app";
import { createDashboardAuth, type DashboardSession } from "../src/auth";
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

  it("renders the authenticated ops deck shell", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
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
    expect(html).toContain(
      'content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"',
    );
    expect(html).toContain('name="theme-color" content="#000000"');
    expect(html).toContain(
      'href="/_junior/dashboard/manifest.webmanifest"',
    );
    expect(html).toContain(
      'href="/_junior/dashboard/icon-512.png"',
    );
  });

  it("renders the configured agent name from the dashboard shell", async () => {
    const app = createDashboardApp({ agentName: "Marky", authRequired: false });

    const shell = await app.fetch(new Request("http://localhost/"));
    const html = await shell.text();
    expect(html).toContain("<title>Marky</title>");
    expect(html).toContain("Loading Marky");
    expect(html).toContain('__JUNIOR_DASHBOARD_AGENT_NAME__ = "Marky"');
  });

  it("escapes the configured agent name in HTML and inline JavaScript", async () => {
    const app = createDashboardApp({
      agentName: '</script><script>alert("xss")</script>',
      authRequired: false,
    });

    const response = await app.fetch(new Request("http://localhost/"));
    const html = await response.text();

    expect(html).not.toContain('</script><script>alert("xss")</script>');
    expect(html).toContain(
      "&lt;/script&gt;&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
    expect(html).toContain("\\u003c/script>\\u003cscript>alert");
  });

  it("renders React Router dashboard page routes", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
      },
    });

    for (const path of [
      "/conversations",
      "/conversations/slack%3AC1%3A123",
      "/locations",
      "/locations/destination-1",
      "/people",
      "/people/person%40sentry.io",
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
      "/plugins/memory/memories",
      "/plugins/memory/memories/library",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("<title>Junior</title>");
    }
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

  it("does not serve retired dashboard page routes", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
      },
    });

    for (const path of ["/chat/legacy-id"]) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect(response.status).toBe(404);
    }
  });

  it("serves the dashboard client bundle without browser caching", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
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

  it("serves the official dashboard avatar with revalidation", async () => {
    const app = dashboard({
      user: {
        email: "person@sentry.io",
        emailVerified: true,
      },
    });

    const response = await app.fetch(
      new Request("http://localhost/_junior/dashboard/avatar.png"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1_000);
  });

  it("serves the dashboard favicon without auth noise", async () => {
    const app = dashboard(null);

    const response = await app.fetch(
      new Request("http://localhost/favicon.ico"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("serves the installable shell manifest without auth", async () => {
    const app = createDashboardApp({
      agentName: "Marky",
      allowedEmails: ["admin@example.com"],
      auth: auth(null),
      basePath: "/ops",
    });

    const response = await app.fetch(
      new Request("http://localhost/_junior/dashboard/manifest.webmanifest"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.get("content-type")).toBe(
      "application/manifest+json",
    );
    expect(await response.json()).toEqual({
      background_color: "#000000",
      description: "Marky dashboard",
      display: "standalone",
      icons: [
        {
          purpose: "any",
          sizes: "512x512",
          src: "/_junior/dashboard/icon-512.png",
          type: "image/png",
        },
      ],
      name: "Marky",
      scope: "/ops",
      short_name: "Marky",
      start_url: "/ops",
      theme_color: "#000000",
    });
  });

  it("serves the install icon without auth", async () => {
    const app = dashboard(null);

    const response = await app.fetch(
      new Request("http://localhost/_junior/dashboard/icon-512.png"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1_000);
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

  it("serves the component gallery only when enabled", async () => {
    const disabled = createDashboardApp({ authRequired: false });
    const enabled = createDashboardApp({
      authRequired: false,
      componentGallery: true,
    });

    expect(
      (await disabled.fetch(new Request("http://localhost/dev"))).status,
    ).toBe(404);
    expect(
      (await enabled.fetch(new Request("http://localhost/dev"))).status,
    ).toBe(200);
    expect(
      await (
        await enabled.fetch(new Request("http://localhost/api/config"))
      ).json(),
    ).toMatchObject({ componentGallery: true });
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

  it("renders a browser-readable forbidden page for denied dashboard routes", async () => {
    const app = dashboard({
      user: {
        email: "person@example.com",
        emailVerified: true,
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
