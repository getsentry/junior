import type { AttachmentStorage } from "@/chat/attachments/storage";
import {
  AttachmentUploadError,
  type AttachmentUploadScope,
  verifyAttachmentUploads,
} from "@/chat/attachments/uploads";
import type { User } from "@sentry/junior-plugin-api";
import type { WebActor } from "@/chat/actor";
import {
  acceptsWebMessages,
  webActorFromUser,
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
  createConversationId,
} from "@/chat/conversations/web-input";
import { webMessageId } from "@/chat/conversations/web-message-id";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { getConversationWorkState } from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getProductionSlackAdapter } from "@/chat/app/production";
import { closeReviewItemsAnsweredByReply } from "@/chat/review-items/actions";
import { createSlackReviewItemShow } from "@/chat/slack/review-item-card-sync";
import { getStateAdapter } from "@/chat/state/adapter";
import { throwApiError } from "../http";
import type {
  AcceptedConversationMessage,
  CreateConversationBody,
  CreateConversationMessageBody,
} from "../schema/conversation";
import {
  canAddConversationMessages,
  readConversationAccessFromSql,
} from "./access";

/** Check uploads before accepting work. A bad upload is a request error. */
async function verifyUploads(
  scope: AttachmentUploadScope,
  uploadIds: string[] | undefined,
  storage: AttachmentStorage,
) {
  try {
    return await verifyAttachmentUploads({
      db: getSqlExecutor(),
      scope,
      storage,
      uploadIds: uploadIds ?? [],
    });
  } catch (error) {
    if (error instanceof AttachmentUploadError) {
      throwApiError(400, error.message);
    }
    throw error;
  }
}

/**
 * Return the Conversation that a viewer's web Message goes to.
 *
 * Without an id, it is the new root that the Message idempotency key names.
 * An existing Conversation must accept web Messages from this viewer.
 */
export async function requireWebMessageConversation(
  viewer: User,
  conversationId: string | undefined,
  idempotencyKey: string,
): Promise<string> {
  if (!conversationId) {
    return createConversationId({ actorEmail: viewer.email, idempotencyKey });
  }
  const conversation = await getConversationStore().get({
    conversationId,
  });
  if (!conversation) {
    throwApiError(404, "Conversation not found.");
  }
  if (!acceptsWebMessages(conversation)) {
    throwApiError(409, "Conversation does not accept web messages.");
  }

  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  if (!canAddConversationMessages(access.get(conversationId))) {
    throwApiError(
      403,
      "Only participants can add messages to a private conversation.",
    );
  }
  return conversationId;
}

function actorFromViewer(viewer: User): WebActor {
  const normalized = viewer.email.trim().toLowerCase();
  return webActorFromUser(viewer, {
    userName: normalized.split("@")[0] || normalized,
  });
}

/** Services that accept web input into the conversation work queue. */
export interface WebInputServices {
  attachmentStorage: AttachmentStorage;
  queue: ConversationWorkQueue;
}

/** Create a dashboard root conversation and enqueue its first message. */
export async function createConversationForViewer(
  viewer: User,
  body: CreateConversationBody,
  services: WebInputServices,
): Promise<AcceptedConversationMessage> {
  const uploads = await verifyUploads(
    {
      conversationId: await requireWebMessageConversation(
        viewer,
        undefined,
        body.idempotencyKey,
      ),
      idempotencyKey: body.idempotencyKey,
      userId: viewer.id,
    },
    body.uploadIds,
    services.attachmentStorage,
  );
  try {
    return await createAndEnqueueConversation(
      {
        actor: actorFromViewer(viewer),
        idempotencyKey: body.idempotencyKey,
        message: body.message,
        uploads,
        ...(body.title ? { title: body.title } : undefined),
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
  await requireWebMessageConversation(
    viewer,
    conversationId,
    body.idempotencyKey,
  );
  const uploads = await verifyUploads(
    { conversationId, idempotencyKey: body.idempotencyKey, userId: viewer.id },
    body.uploadIds,
    services.attachmentStorage,
  );
  const actor = actorFromViewer(viewer);
  const append = () =>
    appendAndEnqueueWebMessage(
      {
        actor,
        conversationId,
        idempotencyKey: body.idempotencyKey,
        message: body.message,
        uploads,
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
