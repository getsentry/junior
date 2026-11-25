import { Hono } from "hono";
import { listSpaceConfiguration } from "@/chat/spaces/configuration";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import { spaceConfigurationSchema } from "../schema/space-configuration";
import { requireViewer } from "../viewer";
import { requireSpace, spaceParamsValidator } from "./access";

/**
 * Create the route that reads a Space's configuration. Anyone who reads the
 * Space reads it. Junior changes it with its `setSpaceConfiguration` tool,
 * when a member asks.
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
      const entries = await listSpaceConfiguration(spaceId);
      return jsonResponse(spaceConfigurationSchema, {
        entries: entries.map((entry) => ({
          ...entry,
          updatedAt: entry.updatedAt.toISOString(),
        })),
      });
    },
  );

  return app;
}
