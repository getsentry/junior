import {
  type AgentPluginRoute,
  defineJuniorPlugin,
  type JuniorPluginRegistration,
} from "@sentry/junior-plugin-api";
import { buildDashboardConversationURL, normalizeDashboardPath } from "./url";
import { createDashboardApp, type JuniorDashboardOptions } from "./app";

export { createDashboardApp, type JuniorDashboardOptions } from "./app";

export interface JuniorDashboardPluginOptions extends JuniorDashboardOptions {
  disabled?: boolean;
}

function dashboardRoutePaths(options: JuniorDashboardPluginOptions): string[] {
  const basePath = normalizeDashboardPath(options.basePath, "/");
  const authPath = normalizeDashboardPath(options.authPath, "/api/auth");
  const pagePaths =
    basePath === "/"
      ? [
          "/",
          "/conversations",
          "/conversations/*",
          "/plugins",
          "/sessions",
          "/sessions/*",
        ]
      : [basePath, `${basePath}/*`];

  return [
    ...pagePaths,
    "/favicon.ico",
    "/api/dashboard/*",
    authPath,
    `${authPath}/*`,
  ];
}

function dashboardRoutes(
  options: JuniorDashboardPluginOptions,
): AgentPluginRoute[] {
  let app: ReturnType<typeof createDashboardApp> | undefined;
  const fetch = (request: Request) => {
    app ??= createDashboardApp(options);
    return app.fetch(request);
  };

  return dashboardRoutePaths(options).map((path) => ({
    handler: fetch,
    path,
  }));
}

/** Register dashboard routes and Slack footer links through plugin hooks. */
export function juniorDashboardPlugin(
  options: JuniorDashboardPluginOptions = {},
): JuniorPluginRegistration {
  return defineJuniorPlugin({
    name: "dashboard",
    manifest: {
      name: "dashboard",
      description: "Junior dashboard routes and Slack footer links",
    },
    hooks: {
      routes() {
        if (options.disabled) {
          return [];
        }
        return dashboardRoutes(options);
      },
      slackConversationLink(ctx) {
        if (options.disabled) {
          return undefined;
        }
        return {
          url: buildDashboardConversationURL({
            basePath: options.basePath,
            baseURL: options.baseURL,
            conversationId: ctx.conversationId,
          }),
        };
      },
    },
  });
}
