import { Hono } from "hono";
import { joinSpace, leaveSpace, listSpaceMembers } from "@/chat/spaces/store";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import { spaceMemberListSchema } from "../schema/space-member";
import { requireViewer } from "../viewer";
import { requireSpace, spaceParamsValidator, spaceResponse } from "./access";

/** Create the routes that list a Space's members, and join or leave it. */
export function createSpaceMemberRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get(
    "/:spaceId/members",
    requireViewer,
    spaceParamsValidator,
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
    spaceParamsValidator,
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
    spaceParamsValidator,
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
