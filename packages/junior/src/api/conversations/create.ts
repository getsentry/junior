import type { AttachmentStorage } from "@/chat/attachments/storage";
import { decodeInputImages } from "@/chat/attachments/images";
import type { InputImage } from "@/chat/attachments/input";
import type { User } from "@sentry/junior-plugin-api";
import type { WebActor } from "@/chat/actor";
import {
  acceptsWebMessages,
  webActorFromEmail,
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
} from "@/chat/conversations/web-input";
import { webMessageId } from "@/chat/conversations/web-message-id";
import { getConversationStore, getDb } from "@/chat/db";
import { getConversationWorkState } from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getProductionSlackAdapter } from "@/chat/app/production";
import { completeDecision } from "@/chat/pi/client";
import { closeReviewItemsAnsweredByReply } from "@/chat/review-items/actions";
import type { ReviewItemReplyDecision } from "@/chat/review-items/reply-match";
import { createSlackReviewItemShow } from "@/chat/slack/review-item-card-sync";
import { getStateAdapter } from "@/chat/state/adapter";
import { throwApiError } from "../http";
import type {
  AcceptedConversationMessage,
  CreateConversationBody,
  CreateConversationMessageBody,
} from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

/** Turn image validation failures into request errors before accepting work. */
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

/** Services that accept web input into the conversation work queue. */
export interface WebInputServices {
  attachmentStorage: AttachmentStorage;
  /** Decision model that matches a message to open Review items. */
  decideReviewItemReply?: ReviewItemReplyDecision;
  queue: ConversationWorkQueue;
}

/** Create a dashboard root conversation and enqueue its first message. */
export async function createConversationForViewer(
  viewer: User,
  body: CreateConversationBody,
  services: WebInputServices,
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
        attachmentStorage: services.attachmentStorage,
        queue: services.queue,
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
  services: WebInputServices,
): Promise<AcceptedConversationMessage> {
  const conversation = await getConversationStore().get({
    conversationId,
  });
  if (!conversation) {
    throwApiError(404, "Conversation not found.");
  }
  if (!acceptsWebMessages(conversationId, conversation.destination)) {
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
  const actor = actorFromViewer(viewer);
  const append = () =>
    appendAndEnqueueWebMessage(
      {
        actor,
        conversationId,
        idempotencyKey: body.idempotencyKey,
        message: body.message,
        images,
      },
      {
        conversationStore: getConversationStore(),
        attachmentStorage: services.attachmentStorage,
        queue: services.queue,
      },
    );
  // A dashboard message answers the open questions that the agent asked in
  // this Conversation, like a typed Slack reply.
  const closeAnswered = () =>
    closeReviewItemsAnsweredByReply({
      conversationId,
      decide: services.decideReviewItemReply ?? completeDecision,
      delivery: {
        queue: services.queue,
        show: createSlackReviewItemShow(getProductionSlackAdapter),
      },
      resolveUser: async () => viewer,
      text: body.message,
    });
  try {
    let accepted: AcceptedConversationMessage;
    try {
      accepted = await append();
    } catch (error) {
      // A failed queue send can follow a saved append. The message still
      // answers then.
      const state = getStateAdapter();
      await state.connect();
      const [messageId, work] = await Promise.all([
        webMessageId({ conversationId, idempotencyKey: body.idempotencyKey }),
        getConversationWorkState({ conversationId, state }),
      ]);
      if (work?.execution.inboundMessageIds.includes(messageId)) {
        await closeAnswered();
      }
      throw error;
    }
    await closeAnswered();
    return accepted;
  } catch (error) {
    throwApiError(500, "Unable to append message.", error);
  }
}
