import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardApp } from "../src/app";
import type { DashboardSession } from "../src/auth";
import { auth, resetDashboardEnv } from "./dashboard-test-helpers";

const { resolveViewerUser } = vi.hoisted(() => ({
  resolveViewerUser: vi.fn(async (email: string) => ({
    email,
    id: `user:${email}`,
    identities: [] as [],
  })),
}));
vi.mock("@sentry/junior/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/junior/api")>()),
  resolveViewerUser,
}));

function dashboard(session: DashboardSession | null) {
  return createDashboardApp({
    allowedGoogleDomains: ["sentry.io"],
    allowedEmails: ["admin@example.com"],
    auth: auth(session),
  });
}

describe("dashboard shell routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDashboardEnv();
  });

  afterEach(() => {
    vi.doUnmock("#junior/config");
    resetDashboardEnv();
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
      'content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content"',
    );
    expect(html).toContain('name="theme-color" content="#000000"');
    expect(html).toContain('href="/_junior/dashboard/manifest.webmanifest"');
    expect(html).toContain('href="/_junior/dashboard/icon-512.png"');
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
      "/code",
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
    const installIcon = await app.fetch(
      new Request("http://localhost/_junior/dashboard/icon-512.png"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    const avatarBytes = new Uint8Array(await response.arrayBuffer());
    const installBytes = new Uint8Array(await installIcon.arrayBuffer());
    expect(avatarBytes.byteLength).toBeGreaterThan(1_000);
    expect(avatarBytes).toEqual(installBytes);
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

});
