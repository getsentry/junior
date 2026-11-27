import { Hono } from "hono";
import { getSpaceLead } from "@/chat/lead/conversation";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  setConversationArchive,
  stopArchivedWork,
} from "../conversations/archive";
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
 * Create the route that archives or restores a Space. A Space is its Lead,
 * so this archives or restores the Lead's tree, as for any root, and an
 * archive stops the tree's running work.
 */
export function createSpaceArchiveRoutes(options: {
  queue: ConversationWorkQueue;
}): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.patch(
    "/:spaceId/archive",
    requireViewer,
    spaceParamsValidator,
    validateRequest("json", archiveSpaceBodySchema, "Invalid request body."),
    async (context) => {
      const viewerUserId = context.get("viewer").id;
      const { spaceId } = context.req.valid("param");
      const { archived } = context.req.valid("json");
      const space = await requireMemberSpace(viewerUserId, spaceId);
      const lead = await getSpaceLead(spaceId);
      if (archived !== (space.archivedAt !== null)) {
        // A Space archive applies whatever the Lead did since the page read
        // it, so it does not check the Lead's activity.
        await setConversationArchive(
          archived
            ? {
                applyToChildren: true,
                archived: true,
                conversationId: lead.conversationId,
              }
            : {
                applyToChildren: true,
                archived: false,
                conversationId: lead.conversationId,
                userId: viewerUserId,
              },
        );
      }
      // A retry after a failed stop finds the Space archived, so it stops
      // what is still running.
      if (archived) await stopArchivedWork(lead.conversationId, options.queue);
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

  return app;
}
