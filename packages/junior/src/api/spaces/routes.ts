import { Hono } from "hono";
import {
  createSpace,
  joinSpace,
  leaveSpace,
  listSpaceMembers,
  listSpaces,
  readSpace,
  setSpaceArchived,
  updateSpace,
  type Space,
} from "@/chat/spaces/store";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  archiveSpaceBodySchema,
  createSpaceBodySchema,
  spaceListQuerySchema,
  spaceListSchema,
  spaceMemberListSchema,
  spaceParamsSchema,
  spaceSchema,
  updateSpaceBodySchema,
  type SpaceReport,
} from "../schema/space";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

function view(space: Space): SpaceReport {
  return {
    ...space,
    createdAt: space.createdAt.toISOString(),
    updatedAt: space.updatedAt.toISOString(),
    archivedAt: space.archivedAt?.toISOString() ?? null,
  };
}

async function requireSpace(
  viewerUserId: string,
  spaceId: string,
): Promise<Space> {
  const space = await readSpace(viewerUserId, spaceId);
  if (!space) throwApiError(404, "Space was not found.");
  return space;
}

// Every Space is public, so anyone can read it. Only members change it.
async function requireMemberSpace(
  viewerUserId: string,
  spaceId: string,
): Promise<Space> {
  const space = await requireSpace(viewerUserId, spaceId);
  if (!space.viewerIsMember) {
    throwApiError(403, "Join the Space to change it.");
  }
  return space;
}

async function spaceResponse(
  viewerUserId: string,
  spaceId: string,
  init?: ResponseInit,
): Promise<Response> {
  return jsonResponse(
    spaceSchema,
    view(await requireSpace(viewerUserId, spaceId)),
    init,
  );
}

const paramsValidator = validateRequest(
  "param",
  spaceParamsSchema,
  "Invalid route parameters.",
);

/** Create the routes that list, create, change, archive, and join Spaces. */
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
      return jsonResponse(spaceListSchema, { spaces: spaces.map(view) });
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
      return jsonResponse(spaceSchema, view(space), { status: 201 });
    },
  );

  app.get("/:spaceId", requireViewer, paramsValidator, async (context) =>
    spaceResponse(context.get("viewer").id, context.req.valid("param").spaceId),
  );

  app.patch(
    "/:spaceId",
    requireViewer,
    paramsValidator,
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
    paramsValidator,
    validateRequest("json", archiveSpaceBodySchema, "Invalid request body."),
    async (context) => {
      const viewerUserId = context.get("viewer").id;
      const { spaceId } = context.req.valid("param");
      await requireMemberSpace(viewerUserId, spaceId);
      await setSpaceArchived(spaceId, context.req.valid("json").archived);
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

  app.get(
    "/:spaceId/members",
    requireViewer,
    paramsValidator,
    async (context) => {
      const { spaceId } = context.req.valid("param");
      await requireSpace(context.get("viewer").id, spaceId);
      const members = await listSpaceMembers(spaceId);
      return jsonResponse(spaceMemberListSchema, {
        members: members.map((member) => ({
          ...member,
          joinedAt: member.joinedAt.toISOString(),
        })),
      });
    },
  );

  app.put(
    "/:spaceId/members/me",
    requireViewer,
    paramsValidator,
    async (context) => {
      const viewerUserId = context.get("viewer").id;
      const { spaceId } = context.req.valid("param");
      // An archived Space can be joined too, so a Space that every member
      // left stays restorable.
      await requireSpace(viewerUserId, spaceId);
      await joinSpace(spaceId, viewerUserId);
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

  app.delete(
    "/:spaceId/members/me",
    requireViewer,
    paramsValidator,
    async (context) => {
      const viewerUserId = context.get("viewer").id;
      const { spaceId } = context.req.valid("param");
      await requireSpace(viewerUserId, spaceId);
      await leaveSpace(spaceId, viewerUserId);
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

  return app;
}
