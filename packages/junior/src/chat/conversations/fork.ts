/**
 * Internal conversation fork.
 *
 * Creates a new root conversation and seeds it with the source conversation's
 * active agent history through a cutoff. Does not clone execution state,
 * mailbox, schedules, watches, approvals, or live tool side effects.
 */
import { createHash } from "node:crypto";
import {
  createWebSource,
  localDestinationSchema,
} from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type {
  ConversationEvent,
  ConversationEventStore,
} from "@/chat/conversations/history";
import {
  commitMessages,
  loadTurnProjection,
} from "@/chat/conversations/projection";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  conversationForkedEvent,
  JUNIOR_NATIVE_EVENT_NAMESPACE,
} from "@/chat/conversations/structured-events";
import {
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";

export type ForkConversationCutoff =
  | { kind: "seq"; throughSeq: number }
  | { kind: "message"; messageId: string };

export interface ForkConversationInput {
  sourceConversationId: string;
  cutoff: ForkConversationCutoff;
  /** Client-supplied key; retries with the same key return the same fork. */
  idempotencyKey: string;
  /** New fork root visibility. Defaults to public. */
  visibility?: ConversationPrivacy;
}

export interface ForkConversationResult {
  conversationId: string;
  sourceConversationId: string;
  throughSeq: number;
  sourceMessageId?: string;
  status: "created" | "duplicate";
}

export interface ForkConversationDeps {
  conversationStore?: ConversationStore;
  eventStore?: ConversationEventStore;
  nowMs?: number;
}

function stableHex(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

/** Deterministic fork conversation id for one source + idempotency key. */
export function createForkConversationId(args: {
  sourceConversationId: string;
  idempotencyKey: string;
}): string {
  return `local:fork:${stableHex(args.sourceConversationId, args.idempotencyKey)}`;
}

function forkIdempotencyKey(args: {
  sourceConversationId: string;
  idempotencyKey: string;
}): string {
  return `fork:${stableHex(args.sourceConversationId, args.idempotencyKey)}`;
}

function requireLocalDestination(conversationId: string) {
  const parsed = localDestinationSchema.safeParse({
    platform: "local",
    conversationId,
  });
  if (!parsed.success) {
    throw new Error(`Invalid local conversation id: ${conversationId}`);
  }
  return parsed.data;
}

/** Resolve a platform message id to the agent-history seq at that cutoff. */
export async function resolveForkCutoffSeq(args: {
  sourceConversationId: string;
  cutoff: ForkConversationCutoff;
  eventStore?: ConversationEventStore;
}): Promise<{ throughSeq: number; sourceMessageId?: string }> {
  const eventStore = args.eventStore ?? getConversationEventStore();
  if (args.cutoff.kind === "seq") {
    if (args.cutoff.throughSeq < 0) {
      throw new Error("Fork cutoff seq must be non-negative");
    }
    const history = await eventStore.loadHistoryContaining(
      args.sourceConversationId,
      args.cutoff.throughSeq,
      args.cutoff.throughSeq,
    );
    if (!history || history.length === 0) {
      throw new Error(
        `Fork cutoff seq ${args.cutoff.throughSeq} was not found in ${args.sourceConversationId}`,
      );
    }
    return { throughSeq: args.cutoff.throughSeq };
  }

  const messageId = args.cutoff.messageId.trim();
  if (!messageId) {
    throw new Error("Fork cutoff message id must not be empty");
  }

  // Walk the full log so the cutoff can sit on a platform message that is not
  // itself an agent-history item. Agent history is then cut at the latest
  // history-bearing seq at or before that message.
  const events = await eventStore.loadHistory(args.sourceConversationId);
  let messageSeq: number | undefined;
  for (const event of events) {
    if (
      (event.data.type === "message" ||
        event.data.type === "message_updated") &&
      event.data.messageId === messageId
    ) {
      messageSeq = event.seq;
      break;
    }
  }
  if (messageSeq === undefined) {
    throw new Error(
      `Fork cutoff message ${messageId} was not found in ${args.sourceConversationId}`,
    );
  }

  const throughSeq = latestAgentHistorySeqAtOrBefore(events, messageSeq);
  if (throughSeq === undefined) {
    throw new Error(
      `Fork cutoff message ${messageId} has no agent history at or before it in ${args.sourceConversationId}`,
    );
  }
  return { throughSeq, sourceMessageId: messageId };
}

function latestAgentHistorySeqAtOrBefore(
  events: ConversationEvent[],
  messageSeq: number,
): number | undefined {
  let throughSeq: number | undefined;
  for (const event of events) {
    if (event.seq > messageSeq) break;
    if (
      event.data.type === "user_message" ||
      event.data.type === "assistant_message" ||
      event.data.type === "tool_result" ||
      event.data.type === "compaction" ||
      event.data.type === "handoff" ||
      event.data.type === "authorization_completed"
    ) {
      throughSeq = event.seq;
    }
  }
  return throughSeq;
}

/**
 * Fork a conversation into a new root at an agent-history cutoff.
 *
 * The fork is a new independent root (not a subagent child). Agent history
 * through the cutoff is copied; runtime and task state are not.
 */
export async function forkConversation(
  input: ForkConversationInput,
  deps: ForkConversationDeps = {},
): Promise<ForkConversationResult> {
  const sourceConversationId = input.sourceConversationId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!sourceConversationId) {
    throw new Error("Fork source conversation id must not be empty");
  }
  if (!idempotencyKey) {
    throw new Error("Fork idempotency key must not be empty");
  }

  const conversationStore = deps.conversationStore ?? getConversationStore();
  const eventStore = deps.eventStore ?? getConversationEventStore();
  const nowMs = deps.nowMs ?? Date.now();

  const source = await conversationStore.get({
    conversationId: sourceConversationId,
  });
  if (!source) {
    throw new Error(`Fork source conversation ${sourceConversationId} not found`);
  }
  if (source.lineage) {
    throw new Error("Forking child conversations is not supported");
  }
  if (source.transcriptPurgedAtMs !== undefined) {
    throw new Error(
      `Fork source conversation ${sourceConversationId} has a purged transcript`,
    );
  }

  const conversationId = createForkConversationId({
    sourceConversationId,
    idempotencyKey,
  });
  const cutoff = await resolveForkCutoffSeq({
    sourceConversationId,
    cutoff: input.cutoff,
    eventStore,
  });

  const prior = await eventStore.loadLatestStructuredEvent(
    conversationId,
    JUNIOR_NATIVE_EVENT_NAMESPACE,
    conversationForkedEvent.eventName,
  );
  if (prior?.data.type === "structured_event") {
    const content = conversationForkedEvent.parse(prior.data.content) as {
      sourceConversationId: string;
      throughSeq: number;
      sourceMessageId?: string;
    };
    return {
      conversationId,
      sourceConversationId,
      throughSeq: content.throughSeq,
      ...(content.sourceMessageId
        ? { sourceMessageId: content.sourceMessageId }
        : {}),
      status: "duplicate",
    };
  }

  const projection = await loadTurnProjection({
    conversationId: sourceConversationId,
    committedSeq: cutoff.throughSeq,
    includeTail: false,
  });
  if (!projection) {
    throw new Error(
      `Fork cutoff seq ${cutoff.throughSeq} is not loadable in ${sourceConversationId}`,
    );
  }

  const visibility = input.visibility === "private" ? "private" : "public";
  const destination = requireLocalDestination(conversationId);
  await conversationStore.recordActivity({
    conversationId,
    destination,
    nowMs,
    source: "internal",
    sessionSource: createWebSource(conversationId, visibility),
    visibility,
    ...(source.title ? { title: source.title } : {}),
  });

  // Seed agent history before the fork marker. On retry after a partial write,
  // skip reseeding when history is already present. The fork marker is the
  // durable completion fact.
  if (projection.messages.length > 0) {
    const existingHistory = await eventStore.loadCurrentHistory(conversationId);
    if (existingHistory.length === 0) {
      await commitMessages({
        conversationId,
        messages: projection.messages,
        provenance: projection.provenance,
      });
    }
  }

  const forkContent = conversationForkedEvent.parse({
    sourceConversationId,
    throughSeq: cutoff.throughSeq,
    ...(cutoff.sourceMessageId
      ? { sourceMessageId: cutoff.sourceMessageId }
      : {}),
  });
  await eventStore.append(conversationId, [
    {
      createdAtMs: nowMs,
      idempotencyKey: forkIdempotencyKey({
        sourceConversationId,
        idempotencyKey,
      }),
      data: {
        type: "structured_event",
        namespace: JUNIOR_NATIVE_EVENT_NAMESPACE,
        name: conversationForkedEvent.eventName,
        version: conversationForkedEvent.version,
        content: forkContent,
      },
    },
  ]);

  return {
    conversationId,
    sourceConversationId,
    throughSeq: cutoff.throughSeq,
    ...(cutoff.sourceMessageId
      ? { sourceMessageId: cutoff.sourceMessageId }
      : {}),
    status: "created",
  };
}
