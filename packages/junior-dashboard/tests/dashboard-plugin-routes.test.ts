import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@sentry/junior";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createDashboardApp } from "../src/app";
import { auth, resetDashboardEnv } from "./dashboard-test-helpers";

const { authenticatePersonalToken, resolveViewerUser } = vi.hoisted(() => ({
  authenticatePersonalToken: vi.fn(),
  resolveViewerUser: vi.fn(async (email: string) => ({
    email,
    id: `user:${email}`,
    identities: [] as [],
  })),
}));
vi.mock("@sentry/junior/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/junior/api")>()),
  authenticatePersonalToken,
  resolveViewerUser,
}));

function mockDashboardVirtualConfig() {
  vi.doMock("#junior/config", () => ({
    createDashboardApp,
    functionMaxDurationSeconds: undefined,
    dashboard: undefined,
    pluginRuntimeRegistrations: [],
    pluginSet: undefined,
    plugins: undefined,
  }));
}

function memoryRoutes() {
  const app = new Hono();
  app.get("/memories", (c) => c.json({ path: c.req.path, ok: true }));
  return app;
}

describe("dashboard plugin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticatePersonalToken.mockReset();
    resetDashboardEnv();
  });

  afterEach(() => {
    vi.doUnmock("#junior/config");
    resetDashboardEnv();
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

    const chatRoute = await app.fetch(
      new Request("http://localhost/chat/legacy-id"),
    );
    expect(chatRoute.status).toBe(404);
  });

  it("mounts plugin API route apps under the authenticated namespace", async () => {
    mockDashboardVirtualConfig();
    const pluginApp = memoryRoutes();
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
    const pluginApp = memoryRoutes();
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

  it("rejects personal bearer token writes before plugin dispatch", async () => {
    authenticatePersonalToken.mockResolvedValue("person@sentry.io");
    let dispatched = false;
    const pluginApp = new Hono();
    pluginApp.delete("/memories/:id", (c) => {
      dispatched = true;
      return c.body(null, 204);
    });
    const app = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth(null),
      pluginRoutes: [{ app: pluginApp, pluginName: "memory" }],
    });

    const response = await app.fetch(
      new Request("http://localhost/api/plugins/memory/memories/memory-1", {
        headers: { authorization: "Bearer jr_pat_valid" },
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(401);
    expect(authenticatePersonalToken).not.toHaveBeenCalled();
    expect(dispatched).toBe(false);
  });

  it("passes sanitized auth context to plugin API route apps", async () => {
    let pluginContext: unknown;
    const authenticated = createDashboardApp({
      allowedGoogleDomains: ["sentry.io"],
      auth: auth({
        user: {
          email: "person@sentry.io",
          emailVerified: true,
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
          name: "Person",
        },
      },
      pluginName: "memory",
    });
  });

  it("does not pass core viewer state into plugin routes", async () => {
    const pluginApp = new Hono<{
      Variables: { viewer?: { email: string } };
    }>();
    pluginApp.get("/viewer", (c) =>
      c.json({ viewerEmail: c.get("viewer")?.email ?? null }),
    );
    const app = createDashboardApp({
      authRequired: false,
      allowedGoogleDomains: [],
      pluginRoutes: [{ app: pluginApp, pluginName: "viewer" }],
    });
    const response = await app.fetch(
      new Request("http://localhost/api/plugins/viewer/viewer"),
    );
    await expect(response.json()).resolves.toEqual({ viewerEmail: null });
    expect(resolveViewerUser).toHaveBeenCalledWith("dev@example.com");
  });
});
