/** Own the Conversation operations that the REST API and MCP share. */
import * as z from "zod";
import { mcpConversationIdSchema } from "../mcp/conversation";
import { defineApiOperation } from "../operation";
import {
  archiveConversationBodySchema,
  archiveConversationResponseSchema,
  archiveDoneConversationsResponseSchema,
  conversationAutoArchiveSchema,
} from "../schema/conversation-archive";
import {
  pinConversationBodySchema,
  pinConversationResponseSchema,
} from "../schema/conversation-pin";
import {
  conversationSubscriptionBodySchema,
  conversationSubscriptionResponseSchema,
} from "../schema/conversation-subscription";
import { archiveConversation } from "./archive";
import {
  archiveViewerDoneConversations,
  setConversationAutoArchive,
} from "./auto-archive";
import { pinConversation } from "./pin";
import { setConversationSubscription } from "./subscription";

// The route param, which MCP takes as an input field.
const conversationIdInput = { conversationId: mcpConversationIdSchema };

const writeAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  readOnlyHint: false,
};

/** Archive or restore one Conversation, and optionally its children. */
export const archiveConversationOperation = defineApiOperation({
  name: "archiveConversation",
  title: "Archive conversation",
  description:
    "Archive one of your conversations, or restore it, for everyone in it. Archiving a conversation hides it and its child conversations. A restore fails while a conversation above it is archived. A new message from a person restores the conversation and the archived conversations above it.",
  scope: "conversations:manage",
  input: archiveConversationBodySchema.extend(conversationIdInput),
  output: archiveConversationResponseSchema,
  annotations: writeAnnotations,
  run: (viewer, { conversationId, ...body }) =>
    archiveConversation(viewer, conversationId, body),
});

/** Archive every done Conversation of the viewer once. */
export const archiveDoneConversationsOperation = defineApiOperation({
  name: "archiveDoneConversations",
  title: "Archive done conversations",
  description:
    "Archive all of your conversations whose work is done and that stayed quiet for your auto-archive wait time, once. It skips conversations that anyone pinned or turned auto-archive off for, and conversations that wait on a person. Archive applies to everyone in the conversation.",
  scope: "conversations:manage",
  input: z.object({}).strict(),
  output: archiveDoneConversationsResponseSchema,
  annotations: writeAnnotations,
  run: (viewer) => archiveViewerDoneConversations(viewer),
});

/** Pin or unpin one top-level Conversation for the viewer. */
export const pinConversationOperation = defineApiOperation({
  name: "pinConversation",
  title: "Pin conversation",
  description:
    "Pin one of your top-level conversations, or unpin it. A child conversation cannot be pinned or unpinned; it uses the pin of its root. A pin applies only to you, restores an archived conversation, and keeps auto-archive from archiving it.",
  scope: "conversations:manage",
  input: pinConversationBodySchema.extend(conversationIdInput),
  output: pinConversationResponseSchema,
  annotations: writeAnnotations,
  run: (viewer, { conversationId, ...body }) =>
    pinConversation(viewer, conversationId, body),
});

/** Override the viewer's auto-archive default for one Conversation. */
export const setConversationAutoArchiveOperation = defineApiOperation({
  name: "setConversationAutoArchive",
  title: "Set conversation auto-archive",
  description:
    "Turn auto-archive on or off for one of your conversations. This overrides your default for that conversation only.",
  scope: "conversations:manage",
  input: conversationAutoArchiveSchema.extend(conversationIdInput),
  output: conversationAutoArchiveSchema,
  annotations: writeAnnotations,
  run: (viewer, { autoArchive, conversationId }) =>
    setConversationAutoArchive(viewer, conversationId, autoArchive),
});

/** Subscribe or unsubscribe the viewer. It never changes another person. */
export const setConversationSubscriptionOperation = defineApiOperation({
  name: "setConversationSubscription",
  title: "Set conversation subscription",
  description:
    "Subscribe to one of your conversations, or unsubscribe from it. Unsubscribe removes it only from your feed and clears your pin. When nobody else is subscribed, it archives the conversation for everyone. Your next mention of the bot in it subscribes you again.",
  scope: "conversations:manage",
  input: conversationSubscriptionBodySchema.extend(conversationIdInput),
  output: conversationSubscriptionResponseSchema,
  annotations: writeAnnotations,
  run: (viewer, { conversationId, ...body }) =>
    setConversationSubscription(viewer, conversationId, body),
});

/** Every Conversation operation, for the MCP server. */
export const conversationOperations = [
  archiveConversationOperation,
  archiveDoneConversationsOperation,
  pinConversationOperation,
  setConversationAutoArchiveOperation,
  setConversationSubscriptionOperation,
];
