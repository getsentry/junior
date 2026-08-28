/** Store web input in a Conversation mailbox. */
import { createHash } from "node:crypto";
import type { StateAdapter } from "chat";
import { createWebSource, type Destination } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { type StoredSlackActor, type WebActor } from "@/chat/actor";
import type { ConversationStore } from "@/chat/conversations/store";
import type { LegacyWebMailboxMetadata } from "@/chat/conversations/web-mailbox";
import { getConversationStore } from "@/chat/db";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  appendAndEnqueueInboundMessage,
  appendAndEnqueueExclusiveInboundMessage,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { resolveConversationDestination } from "@/chat/conversations/destination";

type EnqueueOptions = {
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
};

/** Input for a new Conversation from web input. */
export interface CreateConversationInput {
  actor: WebActor;
  message: string;
  /** Client-supplied idempotency key for the first message. */
  idempotencyKey: string;
  /** New roots default public. Continues never rewrite visibility. */
  visibility?: ConversationPrivacy;
}

/** Input for one web Message. */
export interface AppendWebMessageInput {
  actor: WebActor;
  conversationId: string;
  message: string;
  idempotencyKey: string;
  /** Applied only when this call creates the conversation root. */
  rootVisibility?: ConversationPrivacy;
}

/** Accepted web Message, including an earlier matching request. */
export interface WebMessageAccepted {
  conversationId: string;
  messageId: string;
  status: "accepted" | "duplicate";
}

/** Result when a request can also find an active Turn. */
export type WebMessageResult =
  | WebMessageAccepted
  | { conversationId: string; messageId: string; status: "active" };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function stableHex(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Build a durable Conversation id for one web Actor and create key.
 *
 * Retries with the same key must address the same Conversation before the
 * mailbox Message id is derived.
 */
export function createConversationId(args: {
  actorEmail: string;
  idempotencyKey: string;
}): string {
  return `local:web:${stableHex(
    normalizeEmail(args.actorEmail),
    args.idempotencyKey,
  )}`;
}

/**
 * Build the retry-stable id for one web Message.
 *
 * TODO(dcramer): Replace the `api-msg` prefix after deployed request retries
 * no longer need to derive ids written by the old web input code.
 */
export function webMessageId(args: {
  conversationId: string;
  idempotencyKey: string;
}): string {
  return `api-msg:${stableHex(args.conversationId, args.idempotencyKey)}`;
}

/** Return the stable Turn id for one mailbox Message. */
export function conversationTurnIdForMessage(messageId: string): string {
  return buildDeterministicTurnId(messageId);
}

/**
 * Store the dashboard participant in the current Conversation actor field.
 *
 * TODO(dcramer): Remove this StoredSlackActor conversion after Conversation
 * actor storage accepts web Actors directly.
 */
function storedActorFromWeb(actor: WebActor): StoredSlackActor {
  return {
    ...(actor.email ? { email: normalizeEmail(actor.email) } : undefined),
    ...(actor.fullName ? { fullName: actor.fullName } : undefined),
  };
}

/** Rebuild the web Actor from durable Conversation identity. */
export function webActorFromEmail(
  email: string,
  profile?: { fullName?: string; userName?: string },
): WebActor {
  const normalized = normalizeEmail(email);
  return {
    platform: "web",
    userId: `dashboard:${stableHex(normalized)}`,
    email: normalized,
    ...(profile?.fullName ? { fullName: profile.fullName } : undefined),
    ...(profile?.userName ? { userName: profile.userName } : undefined),
  };
}

/** Build one web mailbox entry. */
export function buildWebInboundMessage(args: {
  actor: WebActor;
  conversationId: string;
  createdAtMs?: number;
  /** Existing Conversation Destination, when the root already exists. */
  destination?: Destination;
  message: string;
  messageId: string;
  nowMs?: number;
}): InboundMessage {
  const text = args.message.trim();
  if (!text) {
    throw new Error("Web Message must not be empty");
  }
  if (!args.actor.email) {
    throw new Error("Web Actor requires a verified email");
  }
  const destination = resolveConversationDestination({
    conversationId: args.conversationId,
    existing: args.destination,
  });
  const nowMs = args.nowMs ?? Date.now();
  return {
    conversationId: args.conversationId,
    createdAtMs: args.createdAtMs ?? nowMs,
    delivery: "defer",
    // TODO(dcramer): Remove InboundMessage.destination after workers read the
    // Conversation Location and no mailbox reader requires Destination.
    destination,
    inboundMessageId: args.messageId,
    input: {
      authorId: args.actor.userId,
      text,
      metadata: {
        authorEmail: normalizeEmail(args.actor.email),
        ...(args.actor.fullName && { authorFullName: args.actor.fullName }),
        authorUserId: args.actor.userId,
        ...(args.actor.userName && { authorUserName: args.actor.userName }),
        // TODO(dcramer): Remove api_turn after deployed mailbox readers use
        // Inbound message Source.kind to identify web input.
        kind: "api_turn",
        messageId: args.messageId,
      } satisfies LegacyWebMailboxMetadata,
    },
    receivedAtMs: nowMs,
    // TODO(dcramer): Rename this stored field to publish after deployed
    // mailbox readers and writers use the new name.
    publishExternally: false,
    // TODO(dcramer): Replace this string after deployed mailbox readers and
    // writers use a complete web Source.
    source: "web",
  };
}

/** Record web activity and create a Conversation root when needed. */
export async function recordWebConversationActivity(args: {
  actor: WebActor;
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs: number;
  /** Applied only when this call creates the Conversation root. */
  rootVisibility?: ConversationPrivacy;
}): Promise<Destination> {
  const store = args.conversationStore ?? getConversationStore();
  const existing = await store.get({ conversationId: args.conversationId });
  const destination = resolveConversationDestination({
    conversationId: args.conversationId,
    existing: existing?.destination,
  });
  const isNewRoot = !existing;
  const visibility = args.rootVisibility === "private" ? "private" : "public";
  const source = isNewRoot
    ? createWebSource(args.conversationId, visibility)
    : undefined;
  await store.recordActivity({
    conversationId: args.conversationId,
    // TODO(dcramer): Remove the Conversation destination write after all
    // readers use its stored Location.
    destination,
    nowMs: args.nowMs,
    actor: storedActorFromWeb(args.actor),
    // A dashboard continuation does not replace the root Source.
    // TODO(dcramer): Remove the Conversation source and sessionSource writes
    // after every Turn stores Source and all resume readers use that Turn fact.
    ...(isNewRoot ? { source: "web" as const } : undefined),
    ...(source ? { sessionSource: source } : undefined),
    ...(isNewRoot ? { visibility } : undefined),
  });
  return destination;
}

/** Create a Conversation from web input and enqueue its first Message. */
export async function createAndEnqueueConversation(
  input: CreateConversationInput,
  options: EnqueueOptions,
): Promise<WebMessageAccepted> {
  if (!input.actor.email) {
    throw new Error("Web Actor requires a verified email");
  }
  const conversationId = createConversationId({
    actorEmail: input.actor.email,
    idempotencyKey: input.idempotencyKey,
  });
  return await appendAndEnqueueWebMessage(
    {
      actor: input.actor,
      conversationId,
      idempotencyKey: input.idempotencyKey,
      message: input.message,
      rootVisibility: input.visibility === "private" ? "private" : "public",
    },
    options,
  );
}

/** Append one web Message and optionally require an idle Conversation. */
export function appendAndEnqueueWebMessage(
  input: AppendWebMessageInput,
  options: EnqueueOptions & { exclusive: true },
): Promise<WebMessageResult>;
export function appendAndEnqueueWebMessage(
  input: AppendWebMessageInput,
  options: EnqueueOptions,
): Promise<WebMessageAccepted>;
export async function appendAndEnqueueWebMessage(
  input: AppendWebMessageInput,
  options: EnqueueOptions & { exclusive?: boolean },
): Promise<WebMessageResult> {
  const text = input.message.trim();
  if (!text) {
    throw new Error("Web Message must not be empty");
  }
  if (!input.actor.email) {
    throw new Error("Web Actor requires a verified email");
  }
  const nowMs = options.nowMs ?? Date.now();
  const messageId = webMessageId({
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
  });
  const destination = await recordWebConversationActivity({
    actor: input.actor,
    conversationId: input.conversationId,
    conversationStore: options.conversationStore,
    nowMs,
    ...(input.rootVisibility && { rootVisibility: input.rootVisibility }),
  });
  const enqueue = options.exclusive
    ? appendAndEnqueueExclusiveInboundMessage
    : appendAndEnqueueInboundMessage;
  const result = await enqueue({
    message: buildWebInboundMessage({
      actor: input.actor,
      conversationId: input.conversationId,
      destination,
      message: text,
      messageId,
      nowMs,
    }),
    conversationStore: options.conversationStore,
    nowMs,
    queue: options.queue,
    state: options.state,
  });
  const status = result.status === "appended" ? "accepted" : result.status;
  return {
    conversationId: input.conversationId,
    messageId,
    status,
  };
}
