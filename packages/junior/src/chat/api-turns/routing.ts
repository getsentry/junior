import { z } from "zod";
import {
  getTurnRecord,
  listTurnSummaries,
} from "@/chat/task-execution/checkpoint";
import {
  isResourceEventMailboxMetadata,
  type ResourceEventMailboxMetadata,
} from "@/chat/resource-events/notification";
import type { InboundMessage } from "@/chat/task-execution/store";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";

const apiTurnMailboxMetadataSchema = z
  .object({
    authorEmail: z.string().email(),
    authorFullName: z.string().min(1).optional(),
    authorUserId: z.string().min(1),
    authorUserName: z.string().min(1).optional(),
    kind: z.literal("api_turn"),
    messageId: z.string().min(1),
  })
  .strict();

export type ApiTurnMailboxMetadata = z.output<
  typeof apiTurnMailboxMetadataSchema
>;

/** One validated mailbox entry owned by the conversation-only runner. */
type ConversationMailboxEntry =
  | { message: InboundMessage; metadata: ApiTurnMailboxMetadata }
  | { message: InboundMessage; metadata: ResourceEventMailboxMetadata };

/** Return the active root API Turn for one Conversation, if it has one. */
export async function getActiveApiTurnId(
  conversationId: string,
): Promise<string | undefined> {
  const summaries = await listTurnSummaries(conversationId);
  // Agent dispatch also writes surface "api". Those Turns own a dispatchId
  // and must stay on the dispatch router.
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

/** Return the idle auth-paused root API Turn for one Conversation. */
export async function getAuthPausedApiTurnId(
  conversationId: string,
): Promise<string | undefined> {
  const turnId = await getActiveApiTurnId(conversationId);
  if (!turnId) return undefined;
  const record = await getTurnRecord(conversationId, turnId);
  return record?.state === "paused" && record.resumeReason === "auth"
    ? turnId
    : undefined;
}

function parseApiTurnMessages(
  messages: readonly InboundMessage[],
): Array<{ message: InboundMessage; metadata: ApiTurnMailboxMetadata }> {
  if (messages.length === 0) {
    return [];
  }
  const parsed = messages.map((message) => ({
    message,
    metadata: apiTurnMailboxMetadataSchema.safeParse(message.input.metadata),
  }));
  if (parsed.every((entry) => !entry.metadata.success)) {
    return [];
  }
  if (parsed.some((entry) => !entry.metadata.success)) {
    throw new Error("Conversation mailbox mixes web turns and other input");
  }
  return parsed.map((entry) => {
    if (!entry.metadata.success) {
      throw new Error("API turn mailbox metadata failed validation");
    }
    return { message: entry.message, metadata: entry.metadata.data };
  });
}

function parseLocalResourceEventMessages(
  messages: readonly InboundMessage[],
): Array<{
  message: InboundMessage;
  metadata: ResourceEventMailboxMetadata;
}> {
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
      throw new Error("Resource-event mailbox metadata failed validation");
    }
    return { message, metadata: message.input.metadata };
  });
}

/**
 * Resolve conversation-only work from mailbox metadata or an active checkpoint.
 *
 * Covers dashboard API turns and local destination resource-event wakes. Empty
 * resume wakes after yield carry no mailbox rows; durable active Turn state keeps
 * those wakes on this runner instead of falling through to Slack.
 */
export async function resolveApiTurnWork(
  context: ConversationWorkerContext,
): Promise<
  | {
      kind: "mailbox";
      batch: ConversationMailboxEntry[];
    }
  | { kind: "resume"; turnId: string }
  | undefined
> {
  const batch = parseApiTurnMessages(context.attempt.messages);
  if (batch.length > 0) {
    return { kind: "mailbox", batch };
  }
  // Local resource events are ordinary conversation-only mailbox work. Slack
  // resource events stay on the Slack worker until it has a plain Turn entry.
  if (context.destination?.platform === "local") {
    const resourceBatch = parseLocalResourceEventMessages(
      context.attempt.messages,
    );
    if (resourceBatch.length > 0) {
      return { kind: "mailbox", batch: resourceBatch };
    }
  }
  if (context.attempt.messages.length > 0) {
    return undefined;
  }

  const turnId = await getActiveApiTurnId(context.conversationId);
  return turnId ? { kind: "resume", turnId } : undefined;
}

/** Return whether the leased attempt belongs to an API Turn. */
export async function isApiTurnWork(
  context: ConversationWorkerContext,
): Promise<boolean> {
  return (await resolveApiTurnWork(context)) !== undefined;
}
