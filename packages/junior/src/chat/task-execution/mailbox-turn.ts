import {
  createLocalSource,
  createWebSource,
  type Source,
} from "@sentry/junior-plugin-api";
import { createActor, type Actor, type WebActor } from "@/chat/actor";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { Location } from "@/chat/conversations/location";
import type {
  ConversationAuthor,
  ConversationMessage,
} from "@/chat/state/conversation";
import {
  getTurnRecord,
  listTurnSummaries,
} from "@/chat/task-execution/checkpoint";
import {
  isResourceEventConversationMessage,
  RESOURCE_EVENT_MESSAGE_AUTHOR,
  RESOURCE_EVENT_SYSTEM_ACTOR,
} from "@/chat/resource-events/actor";
import { isResourceEventMailboxMetadata } from "@/chat/resource-events/notification";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { legacyWebMailboxMetadataSchema } from "@/chat/conversations/web-mailbox";

/** Mailbox Message with the Actor and Source facts needed to start a Turn. */
export type MailboxTurnInput = {
  actor: Actor;
  author: ConversationAuthor;
  message: InboundMessage;
  // TODO(dcramer): Replace this legacy source name with Source after mailbox
  // Inbound messages store Source.kind.
  source: "resource_event" | "web";
};

/** Actor and Source facts saved for one Turn. */
export type TurnInputFacts = Pick<
  MailboxTurnInput,
  "actor" | "author" | "source"
>;

/** Restore the Turn input facts kept on one saved Message. */
export function turnInputFactsFromConversationMessage(
  message: ConversationMessage,
): TurnInputFacts | undefined {
  if (isResourceEventConversationMessage(message)) {
    return {
      actor: RESOURCE_EVENT_SYSTEM_ACTOR,
      author: message.author ?? RESOURCE_EVENT_MESSAGE_AUTHOR,
      source: "resource_event",
    };
  }
  const actor = createActor(message.author, {
    platform: "web",
    userId: message.author?.userId,
  });
  if (actor?.platform !== "web") {
    return undefined;
  }
  return {
    actor,
    author: message.author ?? { userId: actor.userId },
    source: "web",
  };
}

/** Build the AgentRun Source for one Turn input. */
export function sourceFromTurnInput(args: {
  conversationId: string;
  location?: Location;
  source: MailboxTurnInput["source"];
  visibility?: ConversationPrivacy;
}): Source {
  switch (args.source) {
    case "resource_event":
      // TODO(dcramer): Remove this temporary web Source after Turn checkpoints
      // can store a resource-event Source.kind.
      return args.location
        ? createWebSource(
            args.conversationId,
            args.visibility === "private" ? "private" : "public",
          )
        : createLocalSource(args.conversationId);
    case "web":
      return createWebSource(
        args.conversationId,
        args.visibility === "private" ? "private" : "public",
      );
  }
}

function hasResourceEventActor(actors: readonly Actor[] | undefined): boolean {
  return Boolean(
    actors?.some(
      (actor) =>
        actor.platform === "system" &&
        actor.name === RESOURCE_EVENT_SYSTEM_ACTOR.name,
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
    record.surface === "api" &&
    !record.dispatchId &&
    (record.state === "paused" || record.state === "running")
    ? turnId
    : undefined;
}

/** Return the active web or resource-event mailbox Turn. */
async function getActiveMailboxTurnId(
  conversationId: string,
): Promise<string | undefined> {
  const summaries = await listTurnSummaries(conversationId);
  const active = (
    await Promise.all(
      summaries
        .filter(
          (summary) =>
            !summary.dispatchId &&
            (summary.state === "paused" || summary.state === "running"),
        )
        .map((summary) => getTurnRecord(conversationId, summary.turnId)),
    )
  ).filter(
    (record) =>
      record &&
      !record.dispatchId &&
      (record.surface === "api" || hasResourceEventActor(record.actors)) &&
      (record.state === "paused" || record.state === "running"),
  );
  if (active.length > 1) {
    throw new Error(
      `Conversation ${conversationId} has multiple active mailbox Turns`,
    );
  }
  // TODO(dcramer): Remove Actor-based resource-event selection after Turn
  // checkpoints store Source.kind and resume reads it.
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

function parseWebMessages(
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
      source: "web" as const,
    };
  });
}

function parseResourceEventMessages(
  messages: readonly InboundMessage[],
): MailboxTurnInput[] {
  if (messages.length === 0) {
    return [];
  }
  if (
    !messages.every(
      (message) =>
        message.source === "resource_event" &&
        isResourceEventMailboxMetadata(message.input.metadata),
    )
  ) {
    return [];
  }
  return messages.map((message) => {
    if (!isResourceEventMailboxMetadata(message.input.metadata)) {
      throw new Error("Resource event has invalid metadata");
    }
    return {
      actor: RESOURCE_EVENT_SYSTEM_ACTOR,
      author: RESOURCE_EVENT_MESSAGE_AUTHOR,
      message,
      source: "resource_event" as const,
    };
  });
}

/** Web or resource-event mailbox work selected for one lease. */
export type MailboxTurnWork =
  | { kind: "mailbox"; batch: MailboxTurnInput[] }
  | { kind: "resume"; turnId: string };

/**
 * Select web or resource-event work from new mailbox input or a saved Turn.
 * Saved Actor data identifies a resumed resource-event Turn.
 */
export async function resolveMailboxTurnWork(
  context: ConversationWorkerContext,
): Promise<MailboxTurnWork | undefined> {
  const batch = parseWebMessages(context.attempt.messages);
  if (batch.length > 0) {
    return { kind: "mailbox", batch };
  }
  const resourceBatch = parseResourceEventMessages(context.attempt.messages);
  if (resourceBatch.length > 0) {
    return { kind: "mailbox", batch: resourceBatch };
  }
  if (context.attempt.messages.length > 0) {
    return undefined;
  }

  const turnId = await getActiveMailboxTurnId(context.conversationId);
  return turnId ? { kind: "resume", turnId } : undefined;
}
