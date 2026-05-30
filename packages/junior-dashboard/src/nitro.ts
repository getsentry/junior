import type { Nitro } from "nitro/types";

export interface JuniorDashboardNitroOptions {
  basePath?: string;
  authPath?: string;
  authRequired?: boolean;
  allowedGoogleDomains?: string[];
  allowedEmails?: string[];
  trustedOrigins?: string[];
  sessionMaxAgeSeconds?: number;
  disabled?: boolean;
}

type NitroRouteConfig = NonNullable<Nitro["options"]["routes"]>;

function normalizePath(path: string | undefined, fallback: string): string {
  const value = path?.trim() || fallback;
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

function routeEntry(handler: string): { handler: string } {
  return { handler };
}

function virtualHandler(config: Record<string, unknown>): string {
  return `import { defineHandler } from "nitro";
import { createDashboardApp } from "@sentry/junior-dashboard";

let app;

export default defineHandler(async (event) => {
  app ??= createDashboardApp(${JSON.stringify(config)});
  return app.fetch(event.req);
});
`;
}

function dashboardPageRoutes(
  basePath: string,
  handler: string,
): NitroRouteConfig {
  const sessionsPath = basePath === "/" ? "/sessions" : `${basePath}/sessions`;
  const conversationsPath =
    basePath === "/" ? "/conversations" : `${basePath}/conversations`;

  if (basePath === "/") {
    return {
      "/": routeEntry(handler),
      [conversationsPath]: routeEntry(handler),
      [`${conversationsPath}/**`]: routeEntry(handler),
      [sessionsPath]: routeEntry(handler),
      [`${sessionsPath}/**`]: routeEntry(handler),
    };
  }

  return {
    [basePath]: routeEntry(handler),
    [`${basePath}/**`]: routeEntry(handler),
  };
}

/** Mount the authenticated Junior dashboard into a Nitro deployment. */
export function juniorDashboardNitro(options: JuniorDashboardNitroOptions): {
  nitro: { setup(nitro: unknown): void };
} {
  return {
    nitro: {
      setup(nitro: Nitro) {
        if (options.disabled) {
          return;
        }

        const basePath = normalizePath(options.basePath, "/");
        const authPath = normalizePath(options.authPath, "/api/auth");
        const handler = "#junior-dashboard/handler";
        const dashboardConfig = {
          ...options,
          basePath,
          authPath,
          disabled: undefined,
        };

        nitro.options.virtual[handler] = virtualHandler(dashboardConfig);
        nitro.options.virtual["#junior-dashboard/config"] =
          `export const dashboard = ${JSON.stringify(dashboardConfig)};`;

        const dashboardRoutes: NitroRouteConfig = {
          ...dashboardPageRoutes(basePath, handler),
          "/api/dashboard/**": routeEntry(handler),
          [authPath]: routeEntry(handler),
          [`${authPath}/**`]: routeEntry(handler),
        };

        nitro.options.routes = {
          ...dashboardRoutes,
          ...(nitro.options.routes ?? {}),
        };
      },
    },
  };
}
