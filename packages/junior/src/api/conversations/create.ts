import type { User } from "@sentry/junior-plugin-api";
import type { WebActor } from "@/chat/actor";
import {
  webActorFromEmail,
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
} from "@/chat/conversations/web-input";
import { getConversationStore, getDb } from "@/chat/db";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { throwApiError } from "../http";
import type {
  AcceptedConversationMessage,
  CreateConversationBody,
  CreateConversationMessageBody,
} from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

function actorFromViewer(viewer: User): WebActor {
  const normalized = viewer.email.trim().toLowerCase();
  return webActorFromEmail(normalized, {
    ...(viewer.displayName ? { fullName: viewer.displayName } : undefined),
    userName: normalized.split("@")[0] || normalized,
  });
}

/** Create a dashboard root conversation and enqueue its first message. */
export async function createConversationForViewer(
  viewer: User,
  body: CreateConversationBody,
): Promise<AcceptedConversationMessage> {
  try {
    return await createAndEnqueueConversation(
      {
        actor: actorFromViewer(viewer),
        idempotencyKey: body.idempotencyKey,
        message: body.message,
        ...(body.visibility ? { visibility: body.visibility } : undefined),
      },
      {
        conversationStore: getConversationStore(),
        queue: getVercelConversationWorkQueue(),
      },
    );
  } catch (error) {
    throwApiError(500, "Unable to create conversation.", error);
  }
}

/** Append one dashboard message to an existing conversation. */
export async function appendConversationMessageForViewer(
  viewer: User,
  conversationId: string,
  body: CreateConversationMessageBody,
): Promise<AcceptedConversationMessage> {
  const conversation = await getConversationStore().get({
    conversationId,
  });
  if (!conversation) {
    throwApiError(404, "Conversation not found.");
  }
  const destinationPlatform = conversation.destination?.platform;
  const acceptsWebMessages =
    (destinationPlatform === "local" &&
      conversationId.startsWith("local:web:")) ||
    destinationPlatform === "slack";
  if (!acceptsWebMessages) {
    throwApiError(409, "Conversation does not accept web messages.");
  }

  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(403, "Only conversation participants can add messages.");
  }

  try {
    return await appendAndEnqueueWebMessage(
      {
        actor: actorFromViewer(viewer),
        conversationId,
        idempotencyKey: body.idempotencyKey,
        message: body.message,
      },
      {
        conversationStore: getConversationStore(),
        queue: getVercelConversationWorkQueue(),
      },
    );
  } catch (error) {
    throwApiError(500, "Unable to append message.", error);
  }
}
