import { Hono } from "hono";
import { setConversationArchive } from "../conversations/archive";
import { readSpaceLead } from "@/chat/lead/conversation";
import { throwApiError } from "../http";
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
 * so this archives or restores the Lead's tree, as for any root.
 */
export function createSpaceArchiveRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.patch(
    "/:spaceId/archive",
    requireViewer,
    spaceParamsValidator,
    validateRequest("json", archiveSpaceBodySchema, "Invalid request body."),
    async (context) => {
      const viewerUserId = context.get("viewer").id;
      const { spaceId } = context.req.valid("param");
      const space = await requireMemberSpace(viewerUserId, spaceId);
      const archived = context.req.valid("json").archived;
      if (archived !== (space.archivedAt !== null)) {
        const lead = await readSpaceLead(spaceId);
        if (!lead) throwApiError(404, "Space was not found.");
        const result = await setConversationArchive(
          archived
            ? {
                applyToChildren: true,
                archived: true,
                conversationId: lead.conversationId,
                lastSeenAt: new Date(lead.lastActivityAtMs).toISOString(),
              }
            : {
                applyToChildren: true,
                archived: false,
                conversationId: lead.conversationId,
                userId: viewerUserId,
              },
        );
        if (result.status === "conflict") {
          throwApiError(409, "The Space received new activity.");
        }
      }
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

  return app;
}
