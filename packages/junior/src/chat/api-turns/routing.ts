import { z } from "zod";
import {
  getTurnRecord,
  listTurnSummaries,
} from "@/chat/task-execution/checkpoint";
import { isResourceEventMailboxMetadata } from "@/chat/resource-events/notification";
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

/**
 * Local destination resource-event mailbox rows share the conversation-only runner.
 *
 * TODO(resource-events): Remove the dedicated `resource_event` work kind once
 * local/web destinations run plain mailbox system wakes the same way as any
 * other deferred conversation turn (no special batch/actor fork).
 */
export type LocalResourceEventMailboxEntry = {
  message: InboundMessage;
  kind: "resource_event";
};

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
): LocalResourceEventMailboxEntry[] {
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
  return messages.map((message) => ({
    message,
    kind: "resource_event" as const,
  }));
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
      batch: Array<{
        message: InboundMessage;
        metadata: ApiTurnMailboxMetadata;
      }>;
    }
  | {
      kind: "resource_event";
      batch: LocalResourceEventMailboxEntry[];
    }
  | { kind: "resume"; turnId: string }
  | undefined
> {
  const batch = parseApiTurnMessages(context.attempt.messages);
  if (batch.length > 0) {
    return { kind: "mailbox", batch };
  }
  // Local destination resource events share the conversation-only runner. Slack
  // destination resource events stay on the Slack worker for thread metadata.
  // TODO(resource-events): Fold into normal mailbox work; see LocalResourceEventMailboxEntry.
  if (context.destination?.platform === "local") {
    const resourceBatch = parseLocalResourceEventMessages(
      context.attempt.messages,
    );
    if (resourceBatch.length > 0) {
      return { kind: "resource_event", batch: resourceBatch };
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
