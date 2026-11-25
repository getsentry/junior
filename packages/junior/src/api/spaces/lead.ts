import { Hono } from "hono";
import { getSqlExecutor } from "@/chat/db";
import { CONVERSATION_RESOURCE_TYPE } from "@/chat/conversations/watch-events";
import { CORE_EVENT_NAMESPACE } from "@/chat/events/catalog";
import { listWatches } from "@/chat/events/store";
import { getSpaceLead, readSpaceLead } from "@/chat/lead/conversation";
import { readConversationLastEventSeq } from "../conversations/event-page";
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
      // Read the seq first: a Watch that changes after it adds a later event.
      const lastSeq = await readConversationLastEventSeq(
        getSqlExecutor(),
        lead.conversationId,
      );
      const watches = await listWatches({
        conversationId: lead.conversationId,
      });
      const watchedConversationIds = [
        ...new Set(
          watches
            .filter(
              (watch) =>
                watch.namespace === CORE_EVENT_NAMESPACE &&
                watch.resourceType === CONVERSATION_RESOURCE_TYPE,
            )
            .map((watch) => watch.identifier),
        ),
      ];
      return jsonResponse(
        leadSchema,
        {
          conversationId: lead.conversationId,
          lastSeq,
          watchedConversationIds,
        },
        { headers: { "cache-control": "private, no-store" } },
      );
    },
  );

  return app;
}
