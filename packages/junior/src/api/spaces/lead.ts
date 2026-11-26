import { Hono } from "hono";
import { getSpaceLead, readSpaceLead } from "@/chat/lead/conversation";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import { leadSchema } from "../schema/lead";
import { requireViewer } from "../viewer";
import { requireSpace, spaceParamsValidator } from "./access";

/**
 * Create the route that finds a Space's Lead. A member's first read creates
 * it. Anyone who reads the Space reads its Lead, which is public like the
 * Space.
 */
export function createSpaceLeadRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get(
    "/:spaceId/lead",
    requireViewer,
    spaceParamsValidator,
    async (context) => {
      const viewer = context.get("viewer");
      const space = await requireSpace(
        viewer.id,
        context.req.valid("param").spaceId,
      );
      const lead = space.viewerIsMember
        ? await getSpaceLead({ member: viewer, space })
        : await readSpaceLead(space.id);
      if (!lead) throwApiError(404, "This Space has no Lead yet.");
      return jsonResponse(
        leadSchema,
        { conversationId: lead.conversationId },
        { headers: { "cache-control": "private, no-store" } },
      );
    },
  );

  return app;
}
