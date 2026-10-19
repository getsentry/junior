import type { AttachmentStorage } from "@/chat/attachments/storage";
import { decodeInputImages } from "@/chat/attachments/images";
import type { InputImage } from "@/chat/attachments/input";
import type { User } from "@sentry/junior-plugin-api";
import type { WebActor } from "@/chat/actor";
import {
  webActorFromEmail,
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
} from "@/chat/conversations/web-input";
import { getConversationStore, getDb } from "@/chat/db";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getStateAdapter } from "@/chat/state/adapter";
import { webUserInputAnswerNote } from "@/chat/slack/user-input";
import { persistSlackUserInputReply } from "@/chat/slack/user-input-state";
import { parseSlackThreadId } from "@/chat/slack/context";
import { runWithWorkspaceTeamId } from "@/chat/slack/workspace-context";
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
  const destination = conversation.destination;
  try {
    if (destination?.platform !== "slack") return await append();
    // A dashboard message answers an open request in the Slack thread, like a
    // typed Slack reply, so its buttons close and a later click does nothing.
    return await runWithWorkspaceTeamId(destination.teamId, async () => {
      const state = getStateAdapter();
      await state.connect();
      return persistSlackUserInputReply({
        channelId: destination.channelId,
        claimedBy: viewer.email,
        // The web append cannot tell a failed queue send from a failed save.
        isSaved: () => false,
        note: () => webUserInputAnswerNote(viewer.displayName ?? viewer.email),
        persist: append,
        state,
        // Destination is the channel. Location keeps the Slack thread.
        threadTs:
          conversation.location?.threadTs ??
          parseSlackThreadId(conversationId)?.threadTs,
      });
    });
  } catch (error) {
    throwApiError(500, "Unable to append message.", error);
  }
}
