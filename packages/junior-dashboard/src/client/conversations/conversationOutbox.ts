import type { ConversationPendingMessage } from "@sentry/junior/api/schema";

/** Client-owned mailbox row waiting on accept or retry. */
export type ConversationOutboxMessage = {
  createdAt: string;
  idempotencyKey: string;
  message: string;
  messageId: string;
  status: "failed" | "sending";
};

/** Pending mailbox row with optional client send lifecycle. */
export type ConversationMailboxMessage = ConversationPendingMessage & {
  clientStatus?: ConversationOutboxMessage["status"];
  idempotencyKey?: string;
};

/** Stable React Query key for one conversation's local send outbox. */
export function conversationOutboxQueryKey(conversationId: string | undefined) {
  return ["conversation", conversationId, "outbox"] as const;
}

/** Build one optimistic outbox row for a composer submit. */
export function conversationOutboxMessageForSubmit(input: {
  idempotencyKey: string;
  message: string;
  now?: string;
}): ConversationOutboxMessage {
  const createdAt = input.now ?? new Date().toISOString();
  return {
    createdAt,
    idempotencyKey: input.idempotencyKey,
    message: input.message,
    messageId: `client:${input.idempotencyKey}`,
    status: "sending",
  };
}

/** Project one outbox row into the composer-attached mailbox stack. */
export function mailboxMessageFromOutbox(
  message: ConversationOutboxMessage,
): ConversationMailboxMessage {
  return {
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
  };
}

/**
 * Merge accepted mailbox rows with local outbox rows.
 *
 * Server rows win once present. Outbox rows stay visible while sending or failed
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
    const serverIds = new Set(serverMessages.map((message) => message.messageId));
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
    left.redacted === right.redacted &&
    left.source === right.source &&
    left.role === right.role &&
    left.createdAt === right.createdAt &&
    left.receivedAt === right.receivedAt &&
    left.idempotencyKey === right.idempotencyKey &&
    // Pending rows render actorLabel(actorIdentity). Live polls may enrich
    // identity after the first accept; keep that change visible.
    sameActorIdentity(left.actorIdentity, right.actorIdentity)
  );
}

function sameActorIdentity(
  left: ConversationMailboxMessage["actorIdentity"],
  right: ConversationMailboxMessage["actorIdentity"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.email === right.email &&
    left.fullName === right.fullName &&
    left.slackUserId === right.slackUserId &&
    left.slackUserName === right.slackUserName
  );
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

/** Drop one outbox row after the server accepts it. */
export function removeConversationOutboxMessage(
  current: readonly ConversationOutboxMessage[] | undefined,
  idempotencyKey: string,
): ConversationOutboxMessage[] {
  return (current ?? []).filter(
    (message) => message.idempotencyKey !== idempotencyKey,
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
