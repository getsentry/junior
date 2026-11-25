import type { User } from "@sentry/junior-plugin-api";
import { canMoveToSpace } from "@/chat/conversations/kind-behavior";
import { getConversationStore, getDb } from "@/chat/db";
import { setConversationSpace } from "@/chat/spaces/conversations";
import { readSpace, type Space } from "@/chat/spaces/store";
import { throwApiError } from "../http";
import type {
  SetConversationSpaceBody,
  SetConversationSpaceResponse,
} from "../schema/conversation-space";
import { readConversationAccessFromSql } from "./access";

/**
 * Return the Space that the viewer puts work in. Only a member starts or
 * moves work into a Space, and an archived Space takes no new work.
 */
export async function requireSpaceForWork(
  viewer: User,
  spaceId: string,
): Promise<Space> {
  const space = await readSpace(viewer.id, spaceId);
  if (!space) throwApiError(404, "Space was not found.");
  if (space.archivedAt) {
    throwApiError(409, "Restore the Space before you add work to it.");
  }
  if (!space.viewerIsMember) {
    throwApiError(403, "Join the Space to add work to it.");
  }
  return space;
}

/**
 * Put one root Conversation in a Space, or make it a one-off with null.
 * Only a participant moves it. They must be a member of the Space that it
 * leaves and of the Space that it joins. Only a public root joins a Space.
 * A root in a private Space stays there, so its data stays with the members.
 */
export async function setConversationSpaceForViewer(
  viewer: User,
  conversationId: string,
  body: SetConversationSpaceBody,
): Promise<SetConversationSpaceResponse> {
  const [conversation, access] = await Promise.all([
    getConversationStore().get({ conversationId }),
    readConversationAccessFromSql(getDb(), [conversationId], viewer).then(
      (byId) => byId.get(conversationId),
    ),
  ]);
  if (!conversation || !access?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  if (!canMoveToSpace(conversation.kind)) {
    throwApiError(
      409,
      "Only a top-level conversation moves. A child is in the Space of its root.",
    );
  }
  const currentSpaceId = conversation.spaceId ?? null;
  const target = body.spaceId
    ? await requireSpaceForWork(viewer, body.spaceId)
    : undefined;
  const response = {
    space: target ? { id: target.id, name: target.name } : null,
  };
  if (body.spaceId === currentSpaceId) return response;
  if (currentSpaceId) {
    const source = await readSpace(viewer.id, currentSpaceId);
    if (source && !source.viewerIsMember) {
      throwApiError(403, "Join the Space that it is in to move it.");
    }
  }
  if (target && access.visibility !== "public") {
    throwApiError(409, "Only a public conversation can join a Space.");
  }
  const refusal = await setConversationSpace(conversationId, body.spaceId);
  if (refusal === "not_found") throwApiError(404, "Conversation not found.");
  if (refusal === "leaves_private") {
    throwApiError(409, "A conversation in a private Space stays in it.");
  }
  if (refusal === "shared_location") {
    throwApiError(409, "A Slack conversation can't join a private Space.");
  }
  return response;
}
