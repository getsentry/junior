import { afterEach, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@sentry/junior";
import { createDashboardApp } from "../src/app";

function concreteRoutePath(path: string): string | undefined {
  if (path === "*" || path === "/*") {
    return undefined;
  }
  return path.replaceAll(/:[^/]+/g, "contract").replace(/\*$/, "contract");
}

afterEach(() => {
  vi.doUnmock("#junior/config");
});

it("forwards every dashboard route through the Junior app", async () => {
  const registeredDashboard = createDashboardApp({
    authRequired: false,
    componentGallery: true,
  });
  const registeredRoutes = registeredDashboard.routes
    .map((route) => ({
      method: route.method === "ALL" ? "GET" : route.method,
      path: concreteRoutePath(route.path),
    }))
    .filter(
      (route): route is { method: string; path: string } =>
        route.path !== undefined,
    );
  const createForwardingDashboard = vi.fn(() => ({
    fetch(request: Request) {
      return new Response(`dashboard:${new URL(request.url).pathname}`);
    },
  }));
  vi.doMock("#junior/config", () => ({
    createDashboardApp: createForwardingDashboard,
    functionMaxDurationSeconds: undefined,
    dashboard: {
      authRequired: false,
      componentGallery: true,
    },
    pluginRuntimeRegistrations: [],
    pluginSet: defineJuniorPlugins([]),
    plugins: undefined,
  }));
  const app = await createApp();

  for (const route of registeredRoutes) {
    const response = await app.fetch(
      new Request(`http://localhost${route.path}`, {
        method: route.method,
      }),
    );
    expect(
      await response.text(),
      `${route.method} ${route.path} was not forwarded`,
    ).toBe(`dashboard:${route.path}`);
  }
});
