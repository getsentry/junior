/** Store web input in a Conversation mailbox. */
import type { MessageAttachment } from "@/chat/attachments/input";
import { storeInputImages } from "@/chat/attachments/images";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { SandboxFileUpload } from "@/chat/tools/sandbox/file-uploads";
import { createHash } from "node:crypto";
import type { StateAdapter } from "chat";
import {
  createWebSource,
  type Destination,
  type User,
} from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { type StoredSlackActor, type WebActor } from "@/chat/actor";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import type { LegacyWebMailboxMetadata } from "@/chat/conversations/web-mailbox";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { getActiveTraceContext } from "@/chat/logging";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import type { ReviewItemChangeRecord } from "@/chat/review-items/change-record";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  appendAndEnqueueInboundMessage,
  appendAndEnqueueExclusiveInboundMessage,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { resolveConversationDestination } from "@/chat/conversations/destination";
import { sameDestination } from "@/chat/destination";
import { webMessageId } from "./web-message-id";

type EnqueueOptions = {
  attachmentStorage?: AttachmentStorage;
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
};

/** Input for a new Conversation from web input. */
export interface CreateConversationInput {
  actor: WebActor;
  message: string;
  images?: SandboxFileUpload[];
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
  images?: SandboxFileUpload[];
  idempotencyKey: string;
  /** Review item change that this Message reports. */
  reviewItemChange?: ReviewItemChangeRecord;
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

/**
 * Return whether a person can add a web Message to an existing
 * Conversation: a dashboard Conversation, a Slack thread, or a Thread.
 */
export function acceptsWebMessages(
  conversation: Pick<Conversation, "conversationId" | "destination" | "kind">,
): boolean {
  if (conversation.kind !== "root") return conversation.kind === "thread";
  const { conversationId, destination } = conversation;
  if (destination?.platform === "slack") return true;
  return (
    destination?.platform === "local" && conversationId.startsWith("local:web:")
  );
}

/**
 * Build the web Actor for one signed-in User. Junior is the web provider,
 * so the provider-scoped Actor id is the User id.
 */
export function webActorFromUser(
  user: Pick<User, "displayName" | "email" | "id">,
  profile?: { userName?: string },
): WebActor {
  return {
    platform: "web",
    userId: user.id,
    email: normalizeEmail(user.email),
    ...(user.displayName ? { fullName: user.displayName } : undefined),
    ...(profile?.userName ? { userName: profile.userName } : undefined),
  };
}

/** Build one web mailbox entry. */
export function buildWebInboundMessage(args: {
  actor: WebActor;
  /** Identity of the web Actor, resolved at ingress. */
  authorIdentityId?: string;
  conversationId: string;
  createdAtMs?: number;
  /** Existing Conversation Destination. A child's work keeps none. */
  destination?: Destination;
  message: string;
  attachments?: MessageAttachment[];
  messageId: string;
  nowMs?: number;
  reviewItemChange?: ReviewItemChangeRecord;
}): InboundMessage {
  const text = args.message.trim();
  if (!text && !args.attachments?.length) {
    throw new Error("Web Message must not be empty");
  }
  if (!args.actor.email) {
    throw new Error("Web Actor requires a verified email");
  }
  const nowMs = args.nowMs ?? Date.now();
  // The Turn continues the trace of the request that sent this Message.
  const traceContext = getActiveTraceContext();
  return {
    conversationId: args.conversationId,
    createdAtMs: args.createdAtMs ?? nowMs,
    delivery: "defer",
    // TODO(dcramer): Remove InboundMessage.destination after workers read the
    // Conversation Location and no mailbox reader requires Destination.
    ...(args.destination ? { destination: args.destination } : undefined),
    inboundMessageId: args.messageId,
    input: {
      authorId: args.actor.userId,
      ...(args.authorIdentityId
        ? { authorIdentityId: args.authorIdentityId }
        : undefined),
      text,
      ...(args.attachments?.length
        ? { attachments: args.attachments }
        : undefined),
      ...(args.reviewItemChange
        ? { reviewItemChange: args.reviewItemChange }
        : undefined),
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
    // TODO(dcramer): Replace this string after deployed mailbox readers and
    // writers use a complete web Source.
    source: "web",
    ...(traceContext ? { traceContext } : undefined),
  };
}

/**
 * Record web activity and create a Conversation root when needed. Returns the
 * Destination for the Message's work. A child's work keeps none, so its
 * workers read the Conversation.
 */
export async function recordWebConversationActivity(args: {
  actor: WebActor;
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs: number;
  /** Applied only when this call creates the Conversation root. */
  rootVisibility?: ConversationPrivacy;
}): Promise<Destination | undefined> {
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
    // readers use its stored Location. A stored Destination is not resent:
    // Continue in Slack may replace it after the read above.
    ...(existing?.destination ? undefined : { destination }),
    nowMs: args.nowMs,
    actor: storedActorFromWeb(args.actor),
    // A dashboard continuation does not replace the root Source.
    // TODO(dcramer): Remove the Conversation source and sessionSource writes
    // after every Turn stores Source and all resume readers use that Turn fact.
    ...(isNewRoot ? { source: "web" as const } : undefined),
    ...(source ? { sessionSource: source } : undefined),
    ...(isNewRoot ? { visibility } : undefined),
  });
  return existing && existing.kind !== "root" ? undefined : destination;
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
      images: input.images,
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
  if (!text && !input.images?.length) {
    throw new Error("Web Message must not be empty");
  }
  if (!input.actor.email) {
    throw new Error("Web Actor requires a verified email");
  }
  const nowMs = options.nowMs ?? Date.now();
  const messageId = await webMessageId({
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
  let attachments: MessageAttachment[] = [];
  if (input.images?.length) {
    if (!options.attachmentStorage)
      throw new Error("Attachment storage is unavailable.");
    attachments = await storeInputImages({
      conversationId: input.conversationId,
      files: input.images,
      storage: options.attachmentStorage,
    });
  }
  const enqueue = options.exclusive
    ? appendAndEnqueueExclusiveInboundMessage
    : appendAndEnqueueInboundMessage;
  const authorIdentityId = await resolveActorIdentityId(
    getSqlExecutor(),
    input.actor,
  );
  const enqueueTo = (destination: Destination | undefined) =>
    enqueue({
      message: buildWebInboundMessage({
        actor: input.actor,
        authorIdentityId,
        conversationId: input.conversationId,
        destination,
        message: text,
        attachments,
        messageId,
        nowMs,
        ...(input.reviewItemChange && {
          reviewItemChange: input.reviewItemChange,
        }),
      }),
      conversationStore: options.conversationStore,
      nowMs,
      queue: options.queue,
      state: options.state,
    });
  let result: Awaited<ReturnType<typeof enqueueTo>>;
  try {
    result = await enqueueTo(destination);
  } catch (error) {
    // Continue in Slack moves only a root.
    if (!destination) throw error;
    // Continue in Slack can move an idle Conversation between the read
    // above and the mailbox lock. The Message follows the move.
    const stored = await (
      options.conversationStore ?? getConversationStore()
    ).get({ conversationId: input.conversationId });
    const current = resolveConversationDestination({
      conversationId: input.conversationId,
      existing: stored?.destination,
    });
    if (sameDestination(current, destination)) throw error;
    result = await enqueueTo(current);
  }
  const status = result.status === "appended" ? "accepted" : result.status;
  return {
    conversationId: input.conversationId,
    messageId,
    status,
  };
}
