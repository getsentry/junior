import type {
  ActorIdentity,
  ConversationPendingMessage,
  ConversationReportEvent,
  InputImage,
} from "@sentry/junior/api/schema";

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
  /** A server snapshot listed this inline row in the mailbox. */
  inlineSeenQueued?: boolean;
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

/** True while an outbox row belongs in the transcript instead of the queue. */
export function isInlineOutboxMessage(
  message: ConversationOutboxMessage,
): boolean {
  // A failed send moves to the queue, which owns the retry action.
  return Boolean(message.inline) && message.status !== "failed";
}

/** Ids of history Messages and of the input that started each Turn. */
function historyMessageIds(events: readonly ConversationReportEvent[]): {
  messageIds: Set<string>;
  turnInputIds: Set<string>;
} {
  const messageIds = new Set<string>();
  const turnInputIds = new Set<string>();
  for (const event of events) {
    if (event.data.type === "message") messageIds.add(event.data.messageId);
    if (event.data.type === "turn_lifecycle" && event.data.state === "started")
      for (const id of event.data.inputMessageIds ?? []) turnInputIds.add(id);
  }
  return { messageIds, turnInputIds };
}

/**
 * Drop local sends that one server snapshot already shows.
 *
 * A queued row leaves when the mailbox or history has it. An inline row stays
 * until history has it. The snapshot reads the mailbox before history, so an
 * inline row that the mailbox listed and then lost is in history or was
 * removed, for example by another participant.
 */
export function settleConversationOutboxMessages(
  current: ConversationOutboxMessage[],
  snapshot: {
    events: readonly ConversationReportEvent[];
    queued: readonly ConversationPendingMessage[];
  },
): ConversationOutboxMessage[] {
  const queuedIds = new Set(
    snapshot.queued.map((message) => message.messageId),
  );
  const { messageIds, turnInputIds } = historyMessageIds(snapshot.events);
  const settle = (
    message: ConversationOutboxMessage,
  ): ConversationOutboxMessage | undefined => {
    const queued = queuedIds.has(message.messageId);
    // A Turn joins several sends into the Message of the first one, so a
    // joined send has only its Turn input id. The Turn starts before the
    // mailbox drops the send. Until then, keep the row, or the mailbox copy
    // would show in the queue.
    const read =
      messageIds.has(message.messageId) ||
      (!queued && turnInputIds.has(message.messageId));
    if (read) return undefined;
    if (!isInlineOutboxMessage(message)) return queued ? undefined : message;
    if (queued) {
      return message.inlineSeenQueued
        ? message
        : { ...message, inlineSeenQueued: true };
    }
    return message.inlineSeenQueued ? undefined : message;
  };
  const next = current.flatMap((message) => settle(message) ?? []);
  const unchanged =
    next.length === current.length &&
    next.every((message, index) => message === current[index]);
  return unchanged ? current : next;
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
