import type { AttachmentStorage } from "@/chat/attachments/storage";
import { decodeInputImages } from "@/chat/attachments/web";
import type { InputImage } from "@/chat/attachments/input";
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

function parseImages(images: InputImage[] | undefined) {
  try {
    return decodeInputImages(images ?? []);
  } catch (error) {
    throwApiError(
      400,
      error instanceof Error ? error.message : "Unable to read images.",
    );
  }
}

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
  attachmentStorage: AttachmentStorage,
): Promise<AcceptedConversationMessage> {
  const images = parseImages(body.images);
  try {
    return await createAndEnqueueConversation(
      {
        actor: actorFromViewer(viewer),
        idempotencyKey: body.idempotencyKey,
        message: body.message,
        images,
        ...(body.visibility ? { visibility: body.visibility } : undefined),
      },
      {
        conversationStore: getConversationStore(),
        attachmentStorage,
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
  attachmentStorage: AttachmentStorage,
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

  const images = parseImages(body.images);
  try {
    return await appendAndEnqueueWebMessage(
      {
        actor: actorFromViewer(viewer),
        conversationId,
        idempotencyKey: body.idempotencyKey,
        message: body.message,
        images,
      },
      {
        conversationStore: getConversationStore(),
        attachmentStorage,
        queue: getVercelConversationWorkQueue(),
      },
    );
  } catch (error) {
    throwApiError(500, "Unable to append message.", error);
  }
}
