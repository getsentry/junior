import type { User } from "@sentry/junior-plugin-api";
import { attachObjectLinkForUser } from "@/chat/conversations/object-attach";
import { throwApiError } from "../http";
import type { AttachObjectLinkResponse } from "../schema/object-link";

/**
 * Attach a linked object to a Conversation for one participant, as
 * `attachObjectLinkForUser` does, and answer the dashboard route.
 */
export async function attachObjectLink(
  viewer: User,
  conversationId: string,
  url: string,
): Promise<AttachObjectLinkResponse> {
  const outcome = await attachObjectLinkForUser(viewer, conversationId, url);
  switch (outcome) {
    case "attached":
    case "unchanged":
      return { status: outcome };
    case "not_participant":
      throwApiError(404, "Conversation not found.");
    case "no_web_input":
      throwApiError(409, "Conversation does not accept attached objects.");
    case "not_found":
      throwApiError(404, "Object not found.");
  }
}
