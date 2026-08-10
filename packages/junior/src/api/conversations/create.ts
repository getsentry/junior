import { createHash } from "node:crypto";
import type { LocalActor } from "@/chat/actor";
import {
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

function actorFromViewerEmail(email: string): LocalActor {
  const normalized = email.trim().toLowerCase();
  return {
    platform: "local",
    userId: `dashboard:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`,
    email: normalized,
    userName: normalized.split("@")[0] || normalized,
  };
}

/** Create a private root conversation and enqueue its first message. */
export const createConversationRoute = defineApiRoute({
  method: "post",
  path: "/",
  responseSchema: acceptedConversationMessageSchema,
  handler: async (c) => {
    const email = c.get("verifiedViewerEmail");
    if (!email) throwApiError(403, "Verified viewer email required.");
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
          actor: actorFromViewerEmail(email),
          idempotencyKey: body.idempotencyKey,
          message: body.message,
        },
        {
          conversationStore: getConversationStore(),
          queue: getVercelConversationWorkQueue(),
        },
      );
    } catch (error) {
      throwApiError(
        400,
        error instanceof Error ? error.message : "Unable to create conversation.",
        error,
      );
    }
  },
});

/** Append one dashboard message to an existing conversation. */
export const createConversationMessageRoute = defineApiRoute({
  method: "post",
  path: "/:conversationId/messages",
  responseSchema: acceptedConversationMessageSchema,
  handler: async (c) => {
    const email = c.get("verifiedViewerEmail");
    if (!email) throwApiError(403, "Verified viewer email required.");
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
    if (conversation.destination?.platform === "slack") {
      // Continuing Slack-rooted conversations from the dashboard needs source
      // and destination decoupling. This slice covers private local roots only.
      throwApiError(
        409,
        "Dashboard messages on Slack conversations are not enabled yet.",
      );
    }
    if (
      !conversation.destination ||
      conversation.destination.platform !== "local" ||
      !params.conversationId.startsWith("local:api:")
    ) {
      throwApiError(409, "Conversation does not accept API messages.");
    }

    const access = await readConversationAccessFromSql(
      getDb(),
      [params.conversationId],
      email,
    );
    if (!access.get(params.conversationId)?.isParticipant) {
      throwApiError(403, "Only conversation participants can add messages.");
    }

    try {
      return await appendAndEnqueueApiConversationMessage(
        {
          actor: actorFromViewerEmail(email),
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
      throwApiError(
        400,
        error instanceof Error ? error.message : "Unable to append message.",
        error,
      );
    }
  },
});
