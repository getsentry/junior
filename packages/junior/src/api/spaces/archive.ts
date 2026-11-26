import { Hono } from "hono";
import { stopConversation } from "@/chat/conversations/stop";
import { getSpaceLead } from "@/chat/lead/conversation";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { archiveConversation } from "../conversations/archive";
import type { JuniorApiEnv } from "../route";
import { archiveSpaceBodySchema } from "../schema/space";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import {
  requireMemberSpace,
  spaceParamsValidator,
  spaceResponse,
} from "./access";

/**
 * Create the route that archives or restores a Space: its Lead, with the
 * Conversations below it, as any root archives with its children.
 */
export function createSpaceArchiveRoutes(options: {
  /** Archive stops the Lead, with every child agent below it, through it. */
  queue: ConversationWorkQueue;
}): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.patch(
    "/:spaceId/archive",
    requireViewer,
    spaceParamsValidator,
    validateRequest("json", archiveSpaceBodySchema, "Invalid request body."),
    async (context) => {
      const viewer = context.get("viewer");
      const { spaceId } = context.req.valid("param");
      const { archived } = context.req.valid("json");
      const space = await requireMemberSpace(viewer.id, spaceId);
      const lead = await getSpaceLead(spaceId);
      // A repeat archive keeps the Lead's time. A restore of an active Space
      // would still turn off the viewer's auto-archive, so it does nothing.
      if (archived || space.archivedAt) {
        await archiveConversation(viewer, lead.conversationId, {
          applyToChildren: true,
          archived,
          lastSeenAt: new Date(lead.lastActivityAtMs).toISOString(),
        });
      }
      // A retry stops what an earlier try left running.
      if (archived) {
        await stopConversation({
          conversationId: lead.conversationId,
          queue: options.queue,
        });
      }
      return await spaceResponse(viewer.id, spaceId);
    },
  );

  return app;
}
