import { Hono } from "hono";
import { botConfig } from "@/chat/config";
import { mapBounded } from "@/chat/fan-out";
import {
  readEnabledProviders,
  readServedProviders,
  saveEnabledProviders,
} from "@/chat/gateway-providers/routing";
import { logInfo } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  gatewayProvidersSchema,
  updateGatewayProvidersBodySchema,
  type GatewayProviders,
} from "../schema/gateway-providers";
import { validateRequest } from "../validation";
import { requireAdmin } from "../viewer";

async function readGatewayProviders(): Promise<GatewayProviders> {
  const state = getStateAdapter();
  // The agent model and its refusal fallback hold the largest prompt caches.
  const modelIds = [
    ...new Set([
      botConfig.modelId,
      ...(botConfig.refusalFallbackModelId
        ? [botConfig.refusalFallbackModelId]
        : []),
    ]),
  ];
  const [enabled, models] = await Promise.all([
    readEnabledProviders(state),
    mapBounded(modelIds, async (id) => ({
      id,
      providers: await readServedProviders(state, id),
    })),
  ]);
  const providers = new Set(models.flatMap((model) => model.providers));
  return {
    enabled,
    providers: [...providers].sort(),
    models,
  };
}

/**
 * Create the admin-only routes of the "Enabled providers" setting.
 *
 * The setting changes where every agent model call goes, and a narrow list
 * makes calls fail when its providers are down, so only a Junior admin can
 * read or change it.
 */
export function createGatewayProviderRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", requireAdmin, async () =>
    jsonResponse(gatewayProvidersSchema, await readGatewayProviders()),
  );

  app.put(
    "/",
    requireAdmin,
    validateRequest(
      "json",
      updateGatewayProvidersBodySchema,
      "Invalid request body.",
    ),
    async (context) => {
      const { enabled } = context.req.valid("json");
      await saveEnabledProviders(getStateAdapter(), enabled);
      logInfo("dashboard.gateway_providers.updated", {
        "app.gateway.enabled_providers": enabled ?? ["*"],
      });
      return jsonResponse(gatewayProvidersSchema, await readGatewayProviders());
    },
  );

  return app;
}
