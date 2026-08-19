import { z } from "zod";
import {
  getTurnRecord,
  listTurnSummaries,
} from "@/chat/task-execution/checkpoint";
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

/**
 * True when an empty wake belongs to a local web root conversation.
 *
 * Agent-invocation children may inherit a parent local Destination while using
 * a different conversation id. Only claim the root itself so those children
 * still reach the invocation router.
 */
function isIdleLocalApiTurnWake(
  context: ConversationWorkerContext,
): boolean {
  if (context.destination?.platform === "local") {
    return context.destination.conversationId === context.conversationId;
  }
  // Dashboard roots keep the local:web prefix even when Destination is missing
  // from a stale queue wake.
  return context.conversationId.startsWith("local:web:");
}

/**
 * Resolve API Turn work from mailbox metadata, an active checkpoint, or an
 * idle local web wake.
 *
 * Empty resume wakes after yield carry no mailbox rows. Active Turn state owns
 * those resumes. Idle local web wakes still belong here so they do not fall
 * through to Slack paused-turn recovery.
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
  | { kind: "resume"; turnId: string }
  | { kind: "idle" }
  | undefined
> {
  const batch = parseApiTurnMessages(context.attempt.messages);
  if (batch.length > 0) {
    return { kind: "mailbox", batch };
  }
  if (context.attempt.messages.length > 0) {
    return undefined;
  }

  const summaries = await listTurnSummaries(context.conversationId);
  // Agent dispatch also writes surface "api". Those Turns own a dispatchId
  // and must stay on the dispatch router, which runs after this route.
  const active = summaries.filter(
    (summary) =>
      summary.surface === "api" &&
      !summary.dispatchId &&
      (summary.state === "paused" || summary.state === "running"),
  );
  if (active.length > 1) {
    throw new Error(
      `Conversation ${context.conversationId} has multiple active web turns`,
    );
  }
  const turnId = active[0]?.turnId;
  if (turnId) {
    const record = await getTurnRecord(context.conversationId, turnId);
    if (
      record &&
      record.surface === "api" &&
      !record.dispatchId &&
      (record.state === "paused" || record.state === "running")
    ) {
      return { kind: "resume", turnId };
    }
  }

  if (isIdleLocalApiTurnWake(context)) {
    return { kind: "idle" };
  }
  return undefined;
}

/** Return whether the leased attempt belongs to an API Turn. */
export async function isApiTurnWork(
  context: ConversationWorkerContext,
): Promise<boolean> {
  return (await resolveApiTurnWork(context)) !== undefined;
}
