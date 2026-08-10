import type { User } from "@sentry/junior-plugin-api";
import type { WebActor } from "@/chat/actor";
import {
  webActorFromEmail,
  appendAndEnqueueApiConversationMessage,
  createAndEnqueueApiConversation,
} from "@/chat/api-turns/work";
import { getConversationStore, getDb } from "@/chat/db";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { parseBody, parseParams, throwApiError } from "../http";
import { defineApiRoute } from "../route";
import {
  acceptedConversationMessageSchema,
  conversationParamsSchema,
  createConversationBodySchema,
  createConversationMessageBodySchema,
} from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

function actorFromViewer(viewer: User): WebActor {
  const normalized = viewer.email.trim().toLowerCase();
  return webActorFromEmail(normalized, {
    ...(viewer.displayName ? { fullName: viewer.displayName } : {}),
    userName: normalized.split("@")[0] || normalized,
  });
}

/** Create a public root conversation and enqueue its first message. */
export const createConversationRoute = defineApiRoute({
  auth: true,
  method: "post",
  path: "/",
  responseSchema: acceptedConversationMessageSchema,
  handler: async (c) => {
    const viewer = c.get("viewer");
    let input: unknown;
    try {
      input = await c.req.json();
    } catch (error) {
      throwApiError(400, "Invalid request body.", error);
    }
    const body = parseBody(createConversationBodySchema, input);
    try {
      return await createAndEnqueueApiConversation(
        {
          actor: actorFromViewer(viewer),
          idempotencyKey: body.idempotencyKey,
          message: body.message,
        },
        {
          conversationStore: getConversationStore(),
          queue: getVercelConversationWorkQueue(),
        },
      );
    } catch (error) {
      throwApiError(500, "Unable to create conversation.", error);
    }
  },
});

/** Append one dashboard message to an existing conversation. */
export const createConversationMessageRoute = defineApiRoute({
  auth: true,
  method: "post",
  path: "/:conversationId/messages",
  responseSchema: acceptedConversationMessageSchema,
  handler: async (c) => {
    const viewer = c.get("viewer");
    const params = parseParams(conversationParamsSchema, {
      conversationId: c.req.param("conversationId") ?? "",
    });
    let input: unknown;
    try {
      input = await c.req.json();
    } catch (error) {
      throwApiError(400, "Invalid request body.", error);
    }
    const body = parseBody(createConversationMessageBodySchema, input);

    const conversation = await getConversationStore().get({
      conversationId: params.conversationId,
    });
    if (!conversation) {
      throwApiError(404, "Conversation not found.");
    }
    const destinationPlatform = conversation.destination?.platform;
    const acceptsApiMessages =
      (destinationPlatform === "local" &&
        params.conversationId.startsWith("local:web:")) ||
      destinationPlatform === "slack";
    if (!acceptsApiMessages) {
      throwApiError(409, "Conversation does not accept API messages.");
    }

    const access = await readConversationAccessFromSql(
      getDb(),
      [params.conversationId],
      viewer,
    );
    if (!access.get(params.conversationId)?.isParticipant) {
      throwApiError(403, "Only conversation participants can add messages.");
    }

    try {
      return await appendAndEnqueueApiConversationMessage(
        {
          actor: actorFromViewer(viewer),
          conversationId: params.conversationId,
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
  },
});
