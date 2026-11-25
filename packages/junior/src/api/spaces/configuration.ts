import { Hono } from "hono";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  listSpaceConfiguration,
  setSpaceConfiguration,
  unsetSpaceConfiguration,
} from "@/chat/spaces/configuration";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  setSpaceConfigBodySchema,
  spaceConfigKeyParamsSchema,
  spaceConfigurationSchema,
} from "../schema/space-configuration";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import {
  requireMemberSpace,
  requireSpace,
  spaceParamsValidator,
} from "./access";

const keyParamsValidator = validateRequest(
  "param",
  spaceConfigKeyParamsSchema,
  "Invalid route parameters.",
);

async function configurationResponse(spaceId: string): Promise<Response> {
  const entries = await listSpaceConfiguration(spaceId);
  const keys = [
    ...new Set(
      pluginCatalogRuntime
        .getProviders()
        .flatMap((plugin) => plugin.manifest.configKeys),
    ),
  ].sort();
  return jsonResponse(spaceConfigurationSchema, {
    entries: entries.map((entry) => ({
      ...entry,
      updatedAt: entry.updatedAt.toISOString(),
    })),
    keys,
  });
}

/**
 * Create the routes that read and change a Space's configuration. Anyone who
 * reads the Space reads it. Only members change it.
 */
export function createSpaceConfigurationRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get(
    "/:spaceId/configuration",
    requireViewer,
    spaceParamsValidator,
    async (context) => {
      const { spaceId } = context.req.valid("param");
      await requireSpace(context.get("viewer").id, spaceId);
      return await configurationResponse(spaceId);
    },
  );

  app.put(
    "/:spaceId/configuration/:key",
    requireViewer,
    keyParamsValidator,
    validateRequest("json", setSpaceConfigBodySchema, "Invalid request body."),
    async (context) => {
      const viewerUserId = context.get("viewer").id;
      const { key, spaceId } = context.req.valid("param");
      await requireMemberSpace(viewerUserId, spaceId);
      const error = await setSpaceConfiguration({
        key,
        spaceId,
        updatedByUserId: viewerUserId,
        value: context.req.valid("json").value,
      });
      if (error) throwApiError(400, error);
      return await configurationResponse(spaceId);
    },
  );

  app.delete(
    "/:spaceId/configuration/:key",
    requireViewer,
    keyParamsValidator,
    async (context) => {
      const { key, spaceId } = context.req.valid("param");
      await requireMemberSpace(context.get("viewer").id, spaceId);
      await unsetSpaceConfiguration(spaceId, key);
      return await configurationResponse(spaceId);
    },
  );

  return app;
}
