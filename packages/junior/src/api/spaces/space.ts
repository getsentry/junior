import { Hono } from "hono";
import { createSpace, listSpaces, updateSpace } from "@/chat/spaces/store";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
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

/** Create the routes that list, create, read, and change Spaces. */
export function createSpaceRoutes(): Hono<JuniorApiEnv> {
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
        visibility: body.visibility,
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
      const { visibility, ...changes } = context.req.valid("json");
      // A Space keeps the visibility it was created with. A different
      // audience needs a new Space.
      if (visibility !== undefined) {
        throwApiError(
          400,
          "A Space's visibility is set when it is created. Create a new Space for a different audience.",
        );
      }
      await requireMemberSpace(viewerUserId, spaceId);
      await updateSpace(spaceId, changes);
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

  return app;
}
