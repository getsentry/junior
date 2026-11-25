import { Hono } from "hono";
import { getDb } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { readCachedUserByEmail } from "@/chat/identities/user-cache";
import { joinSpace, leaveSpace, listSpaceMembers } from "@/chat/spaces/store";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import { spaceSchema } from "../schema/space";
import {
  addSpaceMemberBodySchema,
  spaceMemberListSchema,
} from "../schema/space-member";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import {
  requireMemberSpace,
  requireSpace,
  spaceParamsValidator,
  spaceReport,
  spaceResponse,
} from "./access";

/**
 * Create the routes that list a Space's members, add a member, and join or
 * leave it.
 */
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

  // A person cannot find a private Space to join it, so a member adds them.
  app.post(
    "/:spaceId/members",
    requireViewer,
    spaceParamsValidator,
    validateRequest("json", addSpaceMemberBodySchema, "Invalid request body."),
    async (context) => {
      const viewerUserId = context.get("viewer").id;
      const { spaceId } = context.req.valid("param");
      await requireMemberSpace(viewerUserId, spaceId);
      const email = normalizeIdentityEmail(context.req.valid("json").email);
      const person = email
        ? await readCachedUserByEmail(getDb(), email)
        : undefined;
      if (!person) throwApiError(404, "No person has that email.");
      await joinSpace(spaceId, person.user.id);
      return await spaceResponse(viewerUserId, spaceId);
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
      const space = await requireSpace(viewerUserId, spaceId);
      const visibility = await leaveSpace(spaceId, viewerUserId);
      if (visibility === "last_member") {
        throwApiError(409, "The last member can't leave a private Space.");
      }
      // A private Space is no longer readable by the person who left it.
      // The visibility comes from the leave, so a Space made private since
      // the read above is not read again.
      if (visibility === "private") {
        return jsonResponse(spaceSchema, {
          ...spaceReport({ ...space, visibility }),
          memberCount: space.memberCount - 1,
          viewerIsMember: false,
        });
      }
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

  return app;
}
