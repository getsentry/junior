import type { QueryClient } from "@tanstack/react-query";
import type {
  ActorIdentity,
  ConversationDetailReport,
  ConversationPendingMessage,
  InputImage,
} from "@sentry/junior/api/schema";
import type { DashboardCoreData } from "../types";

/** Client-owned mailbox row waiting on accept, server visibility, or retry. */
export type ConversationOutboxMessage = {
  actorIdentity?: ActorIdentity;
  createdAt: string;
  idempotencyKey: string;
  /**
   * Sent while Junior was idle and the queue was empty. The transcript shows
   * the row in place, so it does not pass through the queue first.
   */
  inline?: boolean;
  message: string;
  images?: InputImage[];
  messageId: string;
  status: "accepted" | "failed" | "sending";
};

/** Pending mailbox row with optional client send lifecycle. */
export type ConversationMailboxMessage = ConversationPendingMessage & {
  images?: InputImage[];
  clientStatus?: ConversationOutboxMessage["status"];
  idempotencyKey?: string;
};

/**
 * Give each server mailbox row the photo of its author. The row names its
 * author by Identity id, and the Conversation `authors` carry the photo.
 */
export function withMailboxAuthorPhotos(
  messages: readonly ConversationPendingMessage[] | undefined,
  authors: ConversationDetailReport["authors"],
): readonly ConversationPendingMessage[] | undefined {
  if (!messages || !authors) return messages;
  return messages.map((message) => {
    const avatarUrl = message.actorIdentityId
      ? authors[message.actorIdentityId]?.avatarUrl
      : undefined;
    return avatarUrl && message.actorIdentity
      ? { ...message, actorIdentity: { ...message.actorIdentity, avatarUrl } }
      : message;
  });
}

/** Identity of the viewer, for the outbox rows that they send. */
export function outboxActorIdentity(
  queryClient: QueryClient,
): ActorIdentity | undefined {
  const user = queryClient.getQueryData<DashboardCoreData>([
    "dashboard",
    "core",
  ])?.me.user;
  if (!user?.email) return undefined;
  return {
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : undefined),
    email: user.email,
    fullName: user.name || undefined,
  };
}

/** Stable React Query key for one conversation's local send outbox. */
export function conversationOutboxQueryKey(conversationId: string | undefined) {
  return ["conversation", conversationId, "outbox"] as const;
}

/** Build one optimistic outbox row for a composer submit. */
export function conversationOutboxMessageForSubmit(input: {
  actorIdentity?: ActorIdentity;
  idempotencyKey: string;
  inline?: boolean;
  message: string;
  images?: InputImage[];
  messageId: string;
  now?: string;
}): ConversationOutboxMessage {
  const createdAt = input.now ?? new Date().toISOString();
  return {
    actorIdentity: input.actorIdentity,
    createdAt,
    idempotencyKey: input.idempotencyKey,
    ...(input.inline ? { inline: true } : undefined),
    message: input.message,
    ...(input.images?.length ? { images: input.images } : undefined),
    messageId: input.messageId,
    status: "sending",
  };
}

/** Project one outbox row into the composer-attached mailbox stack. */
export function mailboxMessageFromOutbox(
  message: ConversationOutboxMessage,
): ConversationMailboxMessage {
  return {
    actorIdentity: message.actorIdentity,
    clientStatus: message.status,
    createdAt: message.createdAt,
    delivery: "defer",
    idempotencyKey: message.idempotencyKey,
    inboundMessageId: message.messageId,
    messageId: message.messageId,
    receivedAt: message.createdAt,
    role: "user",
    source: "web",
    text: message.message,
    ...(message.images?.length ? { images: message.images } : undefined),
  };
}

/**
 * Merge accepted mailbox rows with local outbox rows.
 *
 * Server rows win once present. Local rows stay visible until the server sees them
 * so a submit never depends on restoring text into the composer.
 *
 * Preserve list identity when the visible rows did not change so live polls do
 * not re-render the composer footer while the reader is typing.
 */
export function mergeConversationMailboxMessages(
  server: readonly ConversationPendingMessage[] | undefined,
  outbox: readonly ConversationOutboxMessage[] | undefined,
  previous?: readonly ConversationMailboxMessage[],
): ConversationMailboxMessage[] {
  const serverMessages = server ?? [];
  const outboxMessages = outbox ?? [];
  let next: readonly ConversationMailboxMessage[] = serverMessages;
  if (outboxMessages.length > 0) {
    const serverIds = new Set(
      serverMessages.map((message) => message.messageId),
    );
    const extras = outboxMessages
      .filter((message) => !serverIds.has(message.messageId))
      .map(mailboxMessageFromOutbox);
    if (extras.length > 0) next = [...serverMessages, ...extras];
  }
  return reuseConversationMailboxMessages(previous, next);
}

/** Keep the previous mailbox list when visible row identity is unchanged. */
export function reuseConversationMailboxMessages(
  previous: readonly ConversationMailboxMessage[] | undefined,
  next: readonly ConversationMailboxMessage[],
): ConversationMailboxMessage[] {
  if (!previous) return next as ConversationMailboxMessage[];
  if (previous === next) return previous as ConversationMailboxMessage[];
  if (previous.length !== next.length) {
    return next as ConversationMailboxMessage[];
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (!sameMailboxMessage(previous[index]!, next[index]!)) {
      return next as ConversationMailboxMessage[];
    }
  }
  return previous as ConversationMailboxMessage[];
}

function sameMailboxMessage(
  left: ConversationMailboxMessage,
  right: ConversationMailboxMessage,
): boolean {
  return (
    left.inboundMessageId === right.inboundMessageId &&
    left.messageId === right.messageId &&
    left.clientStatus === right.clientStatus &&
    left.delivery === right.delivery &&
    left.text === right.text &&
    left.images === right.images &&
    JSON.stringify(left.attachments) === JSON.stringify(right.attachments) &&
    left.redacted === right.redacted &&
    left.source === right.source &&
    left.role === right.role &&
    left.createdAt === right.createdAt &&
    left.receivedAt === right.receivedAt &&
    left.idempotencyKey === right.idempotencyKey &&
    // Pending rows render actorLabel(actorIdentity) and mention names. Live
    // polls may enrich them after the first accept; keep that change visible.
    sameActorIdentity(left.actorIdentity, right.actorIdentity) &&
    sameMentions(left.mentions, right.mentions)
  );
}

function sameMentions(
  left: ConversationMailboxMessage["mentions"],
  right: ConversationMailboxMessage["mentions"],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((person, index) => sameActorIdentity(person, right[index]));
}

function sameActorIdentity(
  left: ConversationMailboxMessage["actorIdentity"],
  right: ConversationMailboxMessage["actorIdentity"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.avatarUrl === right.avatarUrl &&
    left.email === right.email &&
    left.fullName === right.fullName &&
    left.slackUserId === right.slackUserId &&
    left.slackUserName === right.slackUserName
  );
}

/** True while an outbox row belongs in the transcript instead of the queue. */
export function isInlineOutboxMessage(
  message: ConversationOutboxMessage,
): boolean {
  // A failed send moves to the queue, which owns the retry action.
  return Boolean(message.inline) && message.status !== "failed";
}

/**
 * Split pending rows between the queue and the transcript.
 *
 * Inline rows prefer the server copy once the mailbox has it, so attachments
 * and identity match what the queue would show.
 */
export function splitInlineMailboxMessages(
  merged: readonly ConversationMailboxMessage[],
  server: readonly ConversationPendingMessage[] | undefined,
  outbox: readonly ConversationOutboxMessage[],
): {
  inline: ConversationMailboxMessage[];
  queued: ConversationMailboxMessage[];
} {
  const inlineRows = outbox.filter(isInlineOutboxMessage);
  if (inlineRows.length === 0) {
    return { inline: [], queued: merged as ConversationMailboxMessage[] };
  }
  const inlineIds = new Set(inlineRows.map((message) => message.messageId));
  const serverById = new Map(
    (server ?? []).map((message) => [message.messageId, message]),
  );
  return {
    inline: inlineRows.map(
      (message) =>
        serverById.get(message.messageId) ?? mailboxMessageFromOutbox(message),
    ),
    queued: merged.filter((message) => !inlineIds.has(message.messageId)),
  };
}

/** Append or replace one outbox row by idempotency key. */
export function upsertConversationOutboxMessage(
  current: readonly ConversationOutboxMessage[] | undefined,
  message: ConversationOutboxMessage,
): ConversationOutboxMessage[] {
  const rows = current ?? [];
  const index = rows.findIndex(
    (row) => row.idempotencyKey === message.idempotencyKey,
  );
  if (index < 0) return [...rows, message];
  const next = rows.slice();
  next[index] = message;
  return next;
}

/** Keep the local row until a server snapshot contains the accepted Message. */
export function acceptConversationOutboxMessage(
  current: readonly ConversationOutboxMessage[] | undefined,
  idempotencyKey: string,
  messageId: string,
): ConversationOutboxMessage[] {
  return (current ?? []).map((message) =>
    message.idempotencyKey === idempotencyKey
      ? { ...message, messageId, status: "accepted" }
      : message,
  );
}

/** Mark one outbox row failed after the accept request errors. */
export function failConversationOutboxMessage(
  current: readonly ConversationOutboxMessage[] | undefined,
  idempotencyKey: string,
): ConversationOutboxMessage[] {
  return (current ?? []).map((message) =>
    message.idempotencyKey === idempotencyKey
      ? { ...message, status: "failed" }
      : message,
  );
}
