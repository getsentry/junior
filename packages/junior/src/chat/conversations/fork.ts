import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { WebActor } from "@/chat/actor";
import type { ConversationEvent } from "./history";
import { loadTurnProjection } from "./projection";
import { contextProvenance } from "./provenance";
import {
  conversationForkedEvent,
  JUNIOR_NATIVE_EVENT_NAMESPACE,
} from "./structured-events";
import { withConversationEventLock } from "./sql/event-lock";
import { recordWebConversationActivity } from "./web-input";
import {
  getConversationEventStore,
  getConversationStore,
  getSqlExecutor,
} from "@/chat/db";
import {
  historyItemFromPiMessage,
  piMessageFromHistoryItem,
} from "@/chat/pi/conversation-events";
import { juniorConversations } from "@/db/schema";

export type ForkConversationCutoff =
  | { kind: "seq"; throughSeq: number }
  | { kind: "message"; messageId: string };

export interface ForkConversationInput {
  sourceConversationId: string;
  cutoff: ForkConversationCutoff;
  actor: WebActor;
  idempotencyKey: string;
}

export interface ForkConversationResult {
  conversationId: string;
  sourceConversationId: string;
  throughSeq: number;
  sourceMessageId?: string;
  status: "created" | "duplicate";
}

/** An unavailable history boundary is an expected fork request failure. */
export class ConversationForkError extends Error {}

/** Scope retry identity to the source and the requesting actor. */
function createForkConversationId(args: {
  sourceConversationId: string;
  actorEmail: string;
  idempotencyKey: string;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        args.sourceConversationId,
        args.actorEmail.trim().toLowerCase(),
        args.idempotencyKey,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `local:web:${hash}`;
}

/** Resolve only a completed assistant reply, never an unfinished tool batch. */
async function resolveForkCutoff(input: ForkConversationInput): Promise<{
  throughSeq: number;
  sourceMessageId?: string;
}> {
  const events = getConversationEventStore();
  let boundary: ConversationEvent | undefined;
  let sourceMessageId: string | undefined;
  if (input.cutoff.kind === "message") {
    sourceMessageId = input.cutoff.messageId;
    // Delivery commits this key before its visible Message in one transaction.
    // Do not guess from timestamps: fallback replies may have no agent history.
    boundary = await events.loadByIdempotencyKey(
      input.sourceConversationId,
      `message:${sourceMessageId}:agent`,
    );
  } else {
    const throughSeq = input.cutoff.throughSeq;
    const history = await events.loadHistoryContaining(
      input.sourceConversationId,
      throughSeq,
      throughSeq,
    );
    boundary = history?.find((event) => event.seq === throughSeq);
    if (
      boundary?.data.type === "message" &&
      boundary.data.role === "assistant"
    ) {
      sourceMessageId = boundary.data.messageId;
      boundary = await events.loadByIdempotencyKey(
        input.sourceConversationId,
        `message:${sourceMessageId}:agent`,
      );
    }
  }
  const message =
    boundary?.data.type === "assistant_message"
      ? piMessageFromHistoryItem(boundary.data)
      : undefined;
  if (
    !boundary ||
    message?.role !== "assistant" ||
    message.stopReason !== "stop" ||
    message.content.some((part) => part.type === "toolCall") ||
    !message.content.some((part) => part.type === "text" && part.text.trim())
  ) {
    throw new ConversationForkError(
      "Choose a completed assistant reply with saved agent history.",
    );
  }
  return {
    throughSeq: boundary.seq,
    ...(sourceMessageId ? { sourceMessageId } : undefined),
  };
}

/** Create an independent root from retained history, without copying live work. */
export async function forkConversation(
  input: ForkConversationInput,
): Promise<ForkConversationResult> {
  if (!input.actor.email || !input.idempotencyKey.trim()) {
    throw new ConversationForkError(
      "A verified actor and an idempotency key are required.",
    );
  }
  const conversationId = createForkConversationId({
    ...input,
    actorEmail: input.actor.email,
  });
  const executor = getSqlExecutor();
  const events = getConversationEventStore();
  const store = getConversationStore();
  // The source lock fixes the cutoff against compaction, appends, and retention.
  // The new-root lock makes all fork writes one retry-safe transaction.
  return withConversationEventLock(
    executor,
    input.sourceConversationId,
    async () =>
      withConversationEventLock(executor, conversationId, async () => {
        const prior = await events.loadByIdempotencyKey(
          conversationId,
          "fork:complete",
        );
        if (prior?.data.type === "structured_event") {
          const content = conversationForkedEvent.parse(
            prior.data.content,
          ) as Omit<ForkConversationResult, "conversationId" | "status">;
          return { conversationId, ...content, status: "duplicate" as const };
        }
        const source = await store.get({
          conversationId: input.sourceConversationId,
        });
        if (!source || source.transcriptPurgedAtMs !== undefined) {
          throw new ConversationForkError(
            "The source history is no longer available.",
          );
        }
        if (source.parentConversationId) {
          throw new ConversationForkError(
            "Forking child conversations is not supported.",
          );
        }
        const cutoff = await resolveForkCutoff(input);
        const projection = await loadTurnProjection({
          conversationId: input.sourceConversationId,
          committedSeq: cutoff.throughSeq,
          includeTail: false,
        });
        if (!projection?.messages.length)
          throw new ConversationForkError(
            "The selected history is no longer available.",
          );
        const pendingCalls = new Set<string>();
        for (const message of projection.messages) {
          if (message.role === "assistant") {
            for (const part of message.content)
              if (part.type === "toolCall") pendingCalls.add(part.id);
          } else if (message.role === "toolResult") {
            pendingCalls.delete(message.toolCallId);
          }
        }
        if (pendingCalls.size)
          throw new ConversationForkError(
            "This history contains unfinished tool calls. Choose another reply.",
          );
        const nowMs = Date.now();
        await recordWebConversationActivity({
          actor: input.actor,
          conversationId,
          nowMs,
          rootVisibility: source.visibility === "public" ? "public" : "private",
        });
        await executor
          .db()
          .update(juniorConversations)
          .set({
            forkedFromConversationId: source.conversationId,
            title: source.title
              ? `Fork: ${source.title}`
              : "Forked conversation",
          })
          .where(eq(juniorConversations.conversationId, conversationId));
        // Preserve exact model messages and attribution. Do not copy source
        // Message authors into membership, execution, credentials, or usage.
        await events.append(
          conversationId,
          projection.messages.map((message, index) => ({
            idempotencyKey: `fork:history:${index}`,
            createdAtMs: nowMs,
            data: historyItemFromPiMessage(
              message,
              projection.provenance[index] ?? contextProvenance,
            ),
          })),
        );
        await events.append(conversationId, [
          {
            createdAtMs: nowMs,
            idempotencyKey: "fork:context",
            data: {
              type: "user_message",
              provenance: contextProvenance,
              content: [
                {
                  type: "text",
                  text: "This is a new, independent conversation fork. Earlier messages are historical context. No Sandbox files, active work, watches, automations, approvals, credentials, or delivery location were copied. Earlier file paths and runtime context describe the source conversation, not this one. Use the current runtime context and the next user instruction. Verify files in the fresh Sandbox before relying on them.",
                },
              ],
              timestamp: nowMs,
            },
          },
          {
            createdAtMs: nowMs,
            idempotencyKey: "fork:complete",
            data: {
              type: "structured_event",
              namespace: JUNIOR_NATIVE_EVENT_NAMESPACE,
              name: conversationForkedEvent.eventName,
              version: conversationForkedEvent.version,
              content: {
                sourceConversationId: input.sourceConversationId,
                ...cutoff,
              },
            },
          },
        ]);
        return {
          conversationId,
          sourceConversationId: input.sourceConversationId,
          ...cutoff,
          status: "created" as const,
        };
      }),
  );
}
