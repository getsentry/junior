import { Hono } from "hono";
import { setSpaceArchive } from "@/chat/spaces/conversations";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { JuniorApiEnv } from "../route";
import { archiveSpaceBodySchema } from "../schema/space";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import {
  requireMemberSpace,
  spaceParamsValidator,
  spaceResponse,
} from "./access";

/** Create the route that archives or restores a Space with its Conversations. */
export function createSpaceArchiveRoutes(options: {
  /** Archive stops the Conversations of the Space through it. */
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
      await requireMemberSpace(viewerUserId, spaceId);
      await setSpaceArchive({
        archived: context.req.valid("json").archived,
        queue: options.queue,
        spaceId,
      });
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

  return app;
}
