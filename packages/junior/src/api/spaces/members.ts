import { Hono } from "hono";
import { getDb } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { readCachedUserByEmail } from "@/chat/identities/user-cache";
import { getSpaceLead } from "@/chat/lead/conversation";
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
        members,
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
      const viewer = context.get("viewer");
      const viewerUserId = viewer.id;
      const { spaceId } = context.req.valid("param");
      const space = await requireMemberSpace(viewerUserId, spaceId);
      const email = normalizeIdentityEmail(context.req.valid("json").email);
      const person = email
        ? await readCachedUserByEmail(getDb(), email)
        : undefined;
      if (!person) throwApiError(404, "No person has that email.");
      const lead = await getSpaceLead(space.id);
      await joinSpace(lead.conversationId, person.user.id);
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

  app.put(
    "/:spaceId/members/me",
    requireViewer,
    spaceParamsValidator,
    async (context) => {
      const viewer = context.get("viewer");
      const viewerUserId = viewer.id;
      const { spaceId } = context.req.valid("param");
      // An archived Space can be joined too, so a Space that every member
      // left stays restorable.
      const space = await requireSpace(viewerUserId, spaceId);
      const lead = await getSpaceLead(space.id);
      await joinSpace(lead.conversationId, viewerUserId);
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
      if ((await leaveSpace(spaceId, viewerUserId)) === "last_member") {
        throwApiError(409, "The last member can't leave a private Space.");
      }
      // A private Space is no longer readable by the person who left it.
      if (space.visibility === "private") {
        return jsonResponse(spaceSchema, {
          ...spaceReport(space),
          memberCount: space.memberCount - 1,
          viewerIsMember: false,
        });
      }
      return await spaceResponse(viewerUserId, spaceId);
    },
  );

  return app;
}
