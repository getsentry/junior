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
import { messagesNeedSpaceMembership } from "@/chat/conversations/kind-behavior";
import { webMessageId } from "@/chat/conversations/web-message-id";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import {
  getConversationWorkState,
  type InboundMessageDelivery,
} from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getProductionSlackAdapter } from "@/chat/app/production";
import { closeInboxItemsAnsweredByReply } from "@/chat/inbox-items/actions";
import { markConversationRead } from "./read-position";
import { createInboxItemShow } from "@/chat/notifications/inbox-item-show";
import { getStateAdapter } from "@/chat/state/adapter";
import { throwApiError } from "../http";
import type {
  AcceptedConversationMessage,
  CreateConversationBody,
  CreateConversationMessageBody,
} from "../schema/conversation-create";
import {
  canAddConversationMessages,
  readConversationAccessFromSql,
} from "./access";
import { getSpaceLead } from "@/chat/lead/conversation";
import { requireSpaceForWork } from "./space";
import { inviteMentionedPeople } from "./subscription";

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
  if (messagesNeedSpaceMembership(conversation.kind) && conversation.spaceId) {
    await requireSpaceForWork(viewer, conversation.spaceId);
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
  // A Conversation in a Space has the Space's visibility.
  const space = body.spaceId
    ? await requireSpaceForWork(viewer, body.spaceId)
    : undefined;
  if (space && body.visibility && body.visibility !== space.visibility) {
    throwApiError(400, `A conversation in this Space is ${space.visibility}.`);
  }
  const visibility = space?.visibility ?? body.visibility;
  // Work in a Space starts as a child of its Lead.
  const lead = space
    ? await getSpaceLead({ member: viewer, space })
    : undefined;
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
  let accepted: AcceptedConversationMessage;
  try {
    accepted = await createAndEnqueueConversation(
      {
        actor: actorFromViewer(viewer),
        idempotencyKey: body.idempotencyKey,
        message: body.message,
        uploads,
        ...(body.title ? { title: body.title } : undefined),
        ...(visibility ? { visibility } : undefined),
        ...(lead ? { leadConversationId: lead.conversationId } : undefined),
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
  await inviteMentionedPeople(viewer, accepted.conversationId, body.message);
  return accepted;
}

/** Append one viewer message to an existing conversation. */
export async function appendConversationMessageForViewer(
  viewer: User,
  conversationId: string,
  body: CreateConversationMessageBody,
  services: WebInputServices,
  delivery: InboundMessageDelivery,
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
        delivery,
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
  // this Conversation, like a typed Slack reply. The viewer also saw the
  // transcript so far. The message can wait as pending with no event, so
  // move the read position here: it closes the reply notice, and a reply
  // task that runs later sees the read and adds no notice. The people it
  // mentions join now too, not when its Turn starts.
  const applyAccepted = async () => {
    await inviteMentionedPeople(viewer, conversationId, body.message);
    await closeInboxItemsAnsweredByReply({
      conversationId,
      delivery: {
        queue: services.queue,
        show: createInboxItemShow(getProductionSlackAdapter),
      },
      resolveUser: async () => viewer,
      text: body.message,
    });
    await markConversationRead(viewer, conversationId, {
      lastReadSeq: Number.MAX_SAFE_INTEGER,
    });
  };
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
        await applyAccepted();
      }
      throw error;
    }
    await applyAccepted();
    return accepted;
  } catch (error) {
    throwApiError(500, "Unable to append message.", error);
  }
}
