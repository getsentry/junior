import { Hono } from "hono";
import {
  disconnectServiceAccount,
  finishServiceAccountSignIn,
  getServiceAccountStatus,
  serviceAccountPlugins,
  startServiceAccountSignIn,
} from "@/chat/credentials/service-account";
import { logInfo } from "@/chat/logging";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { PluginDefinition } from "@/chat/plugins/types";
import { escapeXml } from "@/chat/xml";
import { htmlCallbackResponse } from "@/handlers/oauth-html";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  disconnectServiceAccountResponseSchema,
  serviceAccountListSchema,
  serviceAccountParamsSchema,
  startServiceAccountSignInResponseSchema,
} from "../schema/service-account";
import { validateRequest } from "../validation";
import { requireAdmin } from "../viewer";

/**
 * Public URL of the OAuth callback for one plugin's service account.
 *
 * It uses the request origin unless `JUNIOR_BASE_URL` is set, so the
 * provider sends the Admin back to the dashboard session that started it.
 */
function callbackUrl(request: Request, provider: string): string {
  const base =
    process.env.JUNIOR_BASE_URL?.trim() || new URL(request.url).origin;
  return new URL(
    `api/service-accounts/${encodeURIComponent(provider)}/callback`,
    base.endsWith("/") ? base : `${base}/`,
  ).toString();
}

function requirePlugin(provider: string): PluginDefinition {
  const plugin = pluginCatalogRuntime.getDefinition(provider);
  if (!plugin?.manifest.serviceAccount) {
    throwApiError(404, "Service account not found.");
  }
  return plugin;
}

function callbackPage(title: string, message: string, status: number) {
  return htmlCallbackResponse(escapeXml(title), escapeXml(message), status, {
    footerMessage: "You can close this tab and return to the dashboard.",
  });
}

/**
 * Create admin-only routes that list, connect, and disconnect plugin service
 * accounts.
 *
 * Whoever signs in decides which account everyone falls back to, so every
 * route, including the OAuth callback, requires a Junior admin. The callback
 * also accepts only a sign-in that the same Admin started.
 */
export function createServiceAccountRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", requireAdmin, async () =>
    jsonResponse(serviceAccountListSchema, {
      serviceAccounts: await Promise.all(
        serviceAccountPlugins(pluginCatalogRuntime.getProviders()).map(
          getServiceAccountStatus,
        ),
      ),
    }),
  );

  app.post(
    "/:provider",
    requireAdmin,
    validateRequest("param", serviceAccountParamsSchema, "Invalid provider."),
    async (context) => {
      const { provider } = context.req.valid("param");
      const { authorizationUrl } = await startServiceAccountSignIn({
        plugin: requirePlugin(provider),
        redirectUrl: callbackUrl(context.req.raw, provider),
        startedBy: context.get("viewer").email,
      });
      return jsonResponse(startServiceAccountSignInResponseSchema, {
        authorizationUrl: authorizationUrl.toString(),
      });
    },
  );

  app.get(
    "/:provider/callback",
    requireAdmin,
    validateRequest("param", serviceAccountParamsSchema, "Invalid provider."),
    async (context) => {
      const { provider } = context.req.valid("param");
      const plugin = requirePlugin(provider);
      const viewer = context.get("viewer");
      const result = await finishServiceAccountSignIn({
        callback: new URL(context.req.url).searchParams,
        connectedBy: viewer.email,
        plugin,
      });
      if (!result.ok) {
        return callbackPage("Connection failed", result.message, 400);
      }
      logInfo("dashboard.service_account.connected", {
        "app.credential.provider": provider,
      });
      return callbackPage(
        `${plugin.manifest.displayName} service account connected`,
        `People who have not connected ${plugin.manifest.displayName} now use this account for what its policy allows.`,
        200,
      );
    },
  );

  app.delete(
    "/:provider",
    requireAdmin,
    validateRequest("param", serviceAccountParamsSchema, "Invalid provider."),
    async (context) => {
      const { provider } = context.req.valid("param");
      await disconnectServiceAccount(requirePlugin(provider));
      logInfo("dashboard.service_account.disconnected", {
        "app.credential.provider": provider,
      });
      return jsonResponse(disconnectServiceAccountResponseSchema, {
        disconnected: true as const,
      });
    },
  );

  return app;
}
