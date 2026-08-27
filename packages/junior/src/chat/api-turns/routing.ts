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

type ConversationInput =
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
    throw new Error(
      "Conversation input mixes dashboard messages and other input",
    );
  }
  return parsed.map((entry) => {
    if (!entry.metadata.success) {
      throw new Error("Dashboard message metadata failed validation");
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
      throw new Error("Resource event metadata failed validation");
    }
    return { message, metadata: message.input.metadata };
  });
}

/**
 * Find a direct Junior Turn from new input or a saved active Turn.
 *
 * Dashboard messages and local resource events run directly in Junior. A
 * resumed Turn has no new input, so saved Turn state identifies it.
 */
export async function resolveApiTurnWork(
  context: ConversationWorkerContext,
): Promise<
  | {
      kind: "mailbox";
      batch: ConversationInput[];
    }
  | { kind: "resume"; turnId: string }
  | undefined
> {
  const batch = parseApiTurnMessages(context.attempt.messages);
  if (batch.length > 0) {
    return { kind: "mailbox", batch };
  }
  // Local resource events run through Junior directly. Slack resource events
  // stay with Slack because they still need thread context.
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
