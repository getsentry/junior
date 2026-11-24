import { Hono } from "hono";
import { createSpace, listSpaces, updateSpace } from "@/chat/spaces/store";
import { setSpaceArchive } from "@/chat/spaces/conversations";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  archiveSpaceBodySchema,
  createSpaceBodySchema,
  spaceListQuerySchema,
  spaceListSchema,
  spaceSchema,
  updateSpaceBodySchema,
} from "../schema/space";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import {
  requireMemberSpace,
  spaceParamsValidator,
  spaceReport,
  spaceResponse,
} from "./access";
import { createSpaceMemberRoutes } from "./members";

/**
 * Create the Space routes: list, create, read, change, and archive Spaces,
 * with the member routes under each Space.
 */
export function createSpaceRoutes(options: {
  /** Archive stops the Conversations of the Space through it. */
  queue: ConversationWorkQueue;
}): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get(
    "/",
    requireViewer,
    validateRequest("query", spaceListQuerySchema, "Invalid query parameters."),
    async (context) => {
      const spaces = await listSpaces(
        context.get("viewer").id,
        context.req.valid("query"),
      );
      return jsonResponse(spaceListSchema, { spaces: spaces.map(spaceReport) });
    },
  );

  app.post(
    "/",
    requireViewer,
    validateRequest("json", createSpaceBodySchema, "Invalid request body."),
    async (context) => {
      const body = context.req.valid("json");
      const space = await createSpace({
        creatorUserId: context.get("viewer").id,
        name: body.name,
        description: body.description ?? null,
      });
      return jsonResponse(spaceSchema, spaceReport(space), { status: 201 });
    },
  );

  app.get("/:spaceId", requireViewer, spaceParamsValidator, async (context) =>
    spaceResponse(context.get("viewer").id, context.req.valid("param").spaceId),
  );

  app.patch(
    "/:spaceId",
    requireViewer,
    spaceParamsValidator,
    validateRequest("json", updateSpaceBodySchema, "Invalid request body."),
    async (context) => {
      const viewerUserId = context.get("viewer").id;
      const { spaceId } = context.req.valid("param");
      await requireMemberSpace(viewerUserId, spaceId);
      await updateSpace(spaceId, context.req.valid("json"));
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

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

  app.route("/", createSpaceMemberRoutes());

  return app;
}
