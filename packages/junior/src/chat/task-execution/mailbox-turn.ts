import pLimit from "p-limit";
import {
  createEventSource,
  createLocalSource,
  createWebSource,
  type Source,
} from "@sentry/junior-plugin-api";
import { createActor, type Actor, type WebActor } from "@/chat/actor";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { CredentialContext } from "@/chat/credentials/context";
import type { Location } from "@/chat/conversations/location";
import type {
  ConversationAuthor,
  ConversationMessage,
} from "@/chat/state/conversation";
import {
  getStoredTurnFields,
  getTurnRecord,
  listTurnSummaries,
  type StoredTurnFields,
  type TurnRecord,
  type TurnSummary,
} from "@/chat/task-execution/checkpoint";
import {
  isEventConversationMessage,
  EVENT_MESSAGE_AUTHOR,
  EVENT_SYSTEM_ACTOR,
} from "@/chat/events/actor";
import {
  EVENT_WAIT_MS,
  isEventMailboxMetadata,
} from "@/chat/events/notification";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { legacyWebMailboxMetadataSchema } from "@/chat/conversations/web-mailbox";

const MAILBOX_TURN_READ_CONCURRENCY = 8;

/** Mailbox Message with the Actor and Source facts needed to start a Turn. */
export type MailboxTurnInput = {
  actor: Actor;
  author: ConversationAuthor;
  /** Grants of a system Actor that a child agent's input continues. */
  credentialContext?: CredentialContext;
  message: InboundMessage;
  source: Source;
};

/** Actor and Source facts saved for one Turn. */
export type TurnInputFacts = Pick<
  MailboxTurnInput,
  "actor" | "author" | "source"
>;

/**
 * Restore Turn input facts, with saved Message fallback for legacy cursors.
 *
 * TODO(dcramer): Remove Actor and Source reconstruction from the saved Message
 * after no deployed Turn cursor can omit either field.
 */
export function turnInputFactsFromConversationMessage(
  message: ConversationMessage,
  args: {
    conversationId: string;
    location?: Location;
    savedActor?: Actor;
    savedSource?: Source;
    visibility?: ConversationPrivacy;
  },
): TurnInputFacts | undefined {
  if (isEventConversationMessage(message)) {
    return {
      actor: args.savedActor ?? EVENT_SYSTEM_ACTOR,
      author: message.author ?? EVENT_MESSAGE_AUTHOR,
      // Stored Turns written before Source was saved can only restore the old
      // provider stand-in from the Conversation.
      source:
        args.savedSource ??
        (args.location
          ? createWebSource(
              args.conversationId,
              args.visibility === "private" ? "private" : "public",
            )
          : createLocalSource(args.conversationId)),
    };
  }
  const actor =
    args.savedActor ??
    createActor(message.author, {
      platform: "web",
      userId: message.author?.userId,
    });
  if (actor?.platform !== "web") {
    return undefined;
  }
  return {
    actor,
    author: message.author ?? { userId: actor.userId },
    source:
      args.savedSource?.kind === "web"
        ? args.savedSource
        : createWebSource(
            args.conversationId,
            args.visibility === "private" ? "private" : "public",
          ),
  };
}

/** Normalize the selected mailbox Source with current Conversation visibility. */
export function sourceFromTurnInput(args: {
  conversationId: string;
  source: Source;
  visibility?: ConversationPrivacy;
}): Source {
  if (args.source.kind === "web") {
    return createWebSource(
      args.conversationId,
      args.visibility === "private" ? "private" : "public",
    );
  }
  return args.source;
}

function hasEventActor(actors: readonly Actor[] | undefined): boolean {
  return Boolean(
    actors?.some(
      (actor) =>
        actor.platform === "system" && actor.name === EVENT_SYSTEM_ACTOR.name,
    ),
  );
}

/** Return the active web Turn for one Conversation, if it has one. */
export async function getActiveConversationTurnId(
  conversationId: string,
): Promise<string | undefined> {
  const summaries = await listTurnSummaries(conversationId);
  // TODO(dcramer): Remove the surface check after Turn checkpoints store
  // Source.kind and web Turn lookup reads it. Agent dispatch also writes the
  // "api" surface, so its Turns must be excluded by dispatchId until then.
  const active = summaries.filter(
    (summary) =>
      summary.surface === "api" &&
      !summary.dispatchId &&
      (summary.state === "paused" || summary.state === "running"),
  );
  if (active.length > 1) {
    throw new Error(
      `Conversation ${conversationId} has multiple active web turns`,
    );
  }
  const turnId = active[0]?.turnId;
  if (!turnId) return undefined;
  const record = await getTurnRecord(conversationId, turnId);
  return record &&
    (record.source?.kind === "web" ||
      (!record.source && record.surface === "api")) &&
    !record.dispatchId &&
    (record.state === "paused" || record.state === "running")
    ? turnId
    : undefined;
}

/** Return the web and event mailbox Turns that are paused or running. */
export async function listActiveMailboxTurns(
  conversationId: string,
): Promise<TurnRecord[]> {
  const summaries = await listTurnSummaries(conversationId);
  return (
    await Promise.all(
      summaries
        .filter(isOpenTurnSummary)
        .map((summary) => getTurnRecord(conversationId, summary.turnId)),
    )
  ).filter(
    (record): record is TurnRecord =>
      record !== undefined && isActiveMailboxTurn(record),
  );
}

/**
 * List the Source of each active mailbox Turn of several Conversations. It
 * reads the stored Turn cursors and not their Turn history, so unlike
 * `listActiveMailboxTurns` it keeps a Turn whose history was deleted.
 */
export async function listActiveMailboxTurnSources(
  conversationIds: readonly string[],
): Promise<Map<string, Array<Source | undefined>>> {
  const limit = pLimit(MAILBOX_TURN_READ_CONCURRENCY);
  const summaries = (
    await Promise.all(
      conversationIds.map((conversationId) =>
        limit(() => listTurnSummaries(conversationId)),
      ),
    )
  ).flatMap((list) => list.filter(isOpenTurnSummary));
  const stored = await getStoredTurnFields(summaries);
  const sources = new Map<string, Array<Source | undefined>>(
    conversationIds.map((conversationId) => [conversationId, []]),
  );
  await Promise.all(
    summaries.map((summary, index) =>
      limit(async () => {
        const fields = stored[index];
        // Only a legacy cursor with no Source needs its Actors, which come
        // from Turn history.
        const turn =
          fields && !fields.source && fields.surface !== "api"
            ? await getTurnRecord(summary.conversationId, summary.turnId)
            : fields;
        if (turn && isActiveMailboxTurn(turn)) {
          sources.get(summary.conversationId)?.push(turn.source);
        }
      }),
    ),
  );
  return sources;
}

function isOpenTurnSummary(summary: TurnSummary): boolean {
  return (
    !summary.dispatchId &&
    (summary.state === "paused" || summary.state === "running")
  );
}

// TODO(dcramer): Remove the legacy surface and Actor checks after deployed
// Turn cursors all store Source.kind.
function isActiveMailboxTurn(
  record: StoredTurnFields & Partial<Pick<TurnRecord, "actors">>,
): boolean {
  return (
    !record.dispatchId &&
    // An Agent invocation Turn is never a mailbox Turn, even with a web or
    // Event Source.
    record.surface !== "internal" &&
    (record.source?.kind === "web" ||
      record.source?.kind === "event" ||
      (!record.source &&
        (record.surface === "api" || hasEventActor(record.actors)))) &&
    (record.state === "paused" || record.state === "running")
  );
}

/** Return the active web or event mailbox Turn. */
async function getActiveMailboxTurnId(
  conversationId: string,
): Promise<string | undefined> {
  const active = await listActiveMailboxTurns(conversationId);
  if (active.length > 1) {
    throw new Error(
      `Conversation ${conversationId} has multiple active mailbox Turns`,
    );
  }
  return active[0]?.turnId;
}

/** Return the idle auth-paused web Turn for one Conversation. */
export async function getAuthPausedConversationTurnId(
  conversationId: string,
): Promise<string | undefined> {
  const turnId = await getActiveConversationTurnId(conversationId);
  if (!turnId) return undefined;
  const record = await getTurnRecord(conversationId, turnId);
  return record?.state === "paused" && record.resumeReason === "auth"
    ? turnId
    : undefined;
}

/** Read one web input batch as Turn input. A batch with no web input gives []. */
export function parseWebMessages(
  messages: readonly InboundMessage[],
): MailboxTurnInput[] {
  if (messages.length === 0) {
    return [];
  }
  const parsed = messages.map((message) => ({
    message,
    metadata: legacyWebMailboxMetadataSchema.safeParse(message.input.metadata),
  }));
  if (parsed.every((entry) => !entry.metadata.success)) {
    return [];
  }
  if (parsed.some((entry) => !entry.metadata.success)) {
    throw new Error("A Turn cannot combine different kinds of input");
  }
  return parsed.map((entry) => {
    if (!entry.metadata.success) {
      throw new Error("User message has invalid metadata");
    }
    const metadata = entry.metadata.data;
    const actor: WebActor = {
      platform: "web",
      userId: metadata.authorUserId,
      email: metadata.authorEmail.trim().toLowerCase(),
      ...(metadata.authorFullName
        ? { fullName: metadata.authorFullName }
        : undefined),
      ...(metadata.authorUserName
        ? { userName: metadata.authorUserName }
        : undefined),
    };
    return {
      actor,
      author: {
        email: actor.email,
        ...(actor.fullName ? { fullName: actor.fullName } : undefined),
        userId: actor.userId,
        ...(actor.userName ? { userName: actor.userName } : undefined),
      },
      message: entry.message,
      source: createWebSource(entry.message.conversationId),
    };
  });
}

/** Extra debounce time added per additional event already batched. */
const EVENT_WAIT_PER_EXTRA_MESSAGE_MS = 5_000;
/** Upper bound on the debounce window regardless of batch size. */
const EVENT_MAX_WAIT_MS = 60_000;

/**
 * Return how long an event batch must wait before its Turn starts.
 *
 * A resource-event burst (e.g. several check runs on one PR) should produce
 * one Turn instead of one per event. The window grows with batch size up to
 * EVENT_MAX_WAIT_MS, so later events in the same burst land in this batch.
 * Returns 0 when the batch can run now or does not start with an event.
 */
export function getEventBatchDelayMs(
  messages: readonly InboundMessage[],
  nowMs = Date.now(),
): number {
  const first = messages[0];
  if (!first || !isEventMailboxMetadata(first.input.metadata)) {
    return 0;
  }
  const waitMs = Math.min(
    EVENT_MAX_WAIT_MS,
    EVENT_WAIT_MS + EVENT_WAIT_PER_EXTRA_MESSAGE_MS * (messages.length - 1),
  );
  return Math.max(0, first.receivedAtMs + waitMs - nowMs);
}

/** Read an event batch as Turn input, or return [] when it is not only events. */
export function parseEventMessages(
  messages: readonly InboundMessage[],
): MailboxTurnInput[] {
  if (messages.length === 0) {
    return [];
  }
  if (
    !messages.every(
      (message) =>
        message.source === "event" &&
        isEventMailboxMetadata(message.input.metadata),
    )
  ) {
    return [];
  }
  return messages.map((message) => {
    if (!isEventMailboxMetadata(message.input.metadata)) {
      throw new Error("Event has invalid metadata");
    }
    return {
      actor: EVENT_SYSTEM_ACTOR,
      author: EVENT_MESSAGE_AUTHOR,
      message,
      source: createEventSource({
        eventKey: message.input.metadata.event.eventKey,
        eventType: message.input.metadata.event.eventType,
        identifier: message.input.metadata.event.identifier,
        namespace: message.input.metadata.event.namespace,
      }),
    };
  });
}

/** Web or event mailbox work selected for one lease. */
export type MailboxTurnWork =
  | { kind: "mailbox"; batch: MailboxTurnInput[] }
  | { kind: "resume"; turnId: string };

/**
 * Select web or event work from new mailbox input or a saved Turn.
 * Saved Actor data identifies a resumed event Turn.
 */
export async function resolveMailboxTurnWork(
  context: ConversationWorkerContext,
): Promise<MailboxTurnWork | undefined> {
  const batch = parseWebMessages(context.attempt.messages);
  if (batch.length > 0) {
    return { kind: "mailbox", batch };
  }
  const resourceBatch = parseEventMessages(context.attempt.messages);
  if (resourceBatch.length > 0) {
    return { kind: "mailbox", batch: resourceBatch };
  }
  if (context.attempt.messages.length > 0) {
    return undefined;
  }

  const turnId = await getActiveMailboxTurnId(context.conversationId);
  return turnId ? { kind: "resume", turnId } : undefined;
}
