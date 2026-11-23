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
  cancelConversationPendingMessagesBodySchema,
  cancelConversationPendingMessagesResponseSchema,
} from "../schema/conversation-pending-messages";
import {
  pinConversationBodySchema,
  pinConversationResponseSchema,
} from "../schema/conversation-pin";
import {
  renameConversationBodySchema,
  renameConversationResponseSchema,
} from "../schema/conversation-title";
import {
  conversationSubscriptionBodySchema,
  conversationSubscriptionResponseSchema,
} from "../schema/conversation-subscription";
import { stopConversationTurnResponseSchema } from "../schema/conversation-stop";
import { archiveConversation } from "./archive";
import {
  archiveViewerDoneConversations,
  setConversationAutoArchive,
} from "./auto-archive";
import { cancelConversationPendingMessagesForViewer } from "./cancel-pending-messages";
import { pinConversation } from "./pin";
import { renameConversation } from "./rename";
import { stopConversationTurnForViewer } from "./stop";
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

/** Rename one Conversation for everyone in it. */
export const renameConversationOperation = defineApiOperation({
  name: "renameConversation",
  title: "Rename conversation",
  description:
    "Rename one of your conversations for everyone in it. Later turns keep the new title. The Slack thread does not change. Returns the stored title.",
  scope: "conversations:manage",
  input: renameConversationBodySchema.extend(conversationIdInput),
  output: renameConversationResponseSchema,
  annotations: writeAnnotations,
  run: (viewer, { conversationId, ...body }) =>
    renameConversation(viewer, conversationId, body),
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

/** Stop the running Turn and every child agent below it. */
export const stopConversationOperation = defineApiOperation({
  name: "stopConversation",
  title: "Stop conversation",
  description:
    "Stop one of your conversations: its running turn and every child agent below it. Until you send the conversation a message, watch events of it and its child agents are saved to the conversation but start no turn. Messages that wait for the turn are dropped. It starts no new work.",
  scope: "conversations:manage",
  input: z.object(conversationIdInput).strict(),
  output: stopConversationTurnResponseSchema,
  annotations: { ...writeAnnotations, destructiveHint: true },
  run: (viewer, { conversationId }, services) =>
    stopConversationTurnForViewer(viewer, conversationId, services),
});

/** Drop the messages that wait for the running Turn. The Turn continues. */
export const cancelQueuedMessagesOperation = defineApiOperation({
  name: "cancelQueuedMessages",
  title: "Cancel queued messages",
  description:
    "Drop the messages that wait for the running turn of one of your conversations. Without a filter, it drops every one. The running turn continues.",
  scope: "conversations:manage",
  input:
    cancelConversationPendingMessagesBodySchema.extend(conversationIdInput),
  output: cancelConversationPendingMessagesResponseSchema,
  annotations: { ...writeAnnotations, destructiveHint: true },
  run: (viewer, { conversationId, ...body }) =>
    cancelConversationPendingMessagesForViewer(viewer, conversationId, body),
});

/** Every Conversation operation, for the MCP server. */
export const conversationOperations = [
  cancelQueuedMessagesOperation,
  archiveConversationOperation,
  archiveDoneConversationsOperation,
  pinConversationOperation,
  renameConversationOperation,
  setConversationAutoArchiveOperation,
  setConversationSubscriptionOperation,
  stopConversationOperation,
];
