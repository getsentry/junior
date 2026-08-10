/**
 * API-authored root conversation turns.
 *
 * Dashboard and product API messages enter the shared mailbox with
 * `publishExternally: false`. The worker leases the conversation, runs the
 * shared agent path, and accepts replies into the conversation log only.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateAdapter } from "chat";
import {
  createLocalSource,
  localDestinationSchema,
  type LocalDestination,
} from "@sentry/junior-plugin-api";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LocalActor } from "@/chat/actor";
import type { ConversationStore } from "@/chat/conversations/store";
import { loadProjection } from "@/chat/conversations/projection";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import {
  ConversationTurnLifecycleService,
  type ConversationTurnLifecycle,
} from "@/chat/conversations/turn-lifecycle";
import type { ConversationTurnFailureCode } from "@/chat/conversations/history";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { logException, setTags, withLogContext } from "@/chat/logging";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import {
  getConversationTurnBoundaryError,
  isTurnInputCommitLostError,
  markTurnFailed,
  startActiveTurn,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import {
  buildConversationContext,
  markConversationMessage,
  normalizeConversationText,
  recordDeliveredAssistantMessage,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { finalizeFailedTurnReplyWithEvent } from "@/chat/services/turn-failure-response";
import { persistWithRetry } from "@/chat/services/persist-retry";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  appendAndEnqueueInboundMessage,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  processPluginTask,
  scheduleSessionCompletedPluginTasks,
} from "@/chat/plugins/task-runner";
import type { SandboxRef } from "@/chat/sandbox/ref";
import type { AgentRunResult } from "@/chat/services/turn-result";

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

type ApiTurnMailboxMetadata = z.output<typeof apiTurnMailboxMetadataSchema>;

type EnqueueOptions = {
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
};

export interface CreateApiConversationInput {
  actor: LocalActor;
  message: string;
  /** Client-supplied idempotency key for the first message. */
  idempotencyKey: string;
}

export interface AppendApiConversationMessageInput {
  actor: LocalActor;
  conversationId: string;
  message: string;
  idempotencyKey: string;
}

export interface ApiConversationMessageAccepted {
  conversationId: string;
  messageId: string;
  status: "accepted" | "duplicate";
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function stableHex(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

/** Build a local conversation id valid for destination/source contracts. */
export function createApiConversationId(): string {
  return `local:api:${randomUUID().replaceAll("-", "")}`;
}

function apiMessageId(args: {
  conversationId: string;
  idempotencyKey: string;
}): string {
  return `api-msg:${stableHex(args.conversationId, args.idempotencyKey)}`;
}

/** Stable turn id for one API mailbox message. */
export function apiTurnIdForMessage(messageId: string): string {
  return `api-turn:${stableHex(messageId)}`;
}

function requireLocalDestination(conversationId: string): LocalDestination {
  const parsed = localDestinationSchema.safeParse({
    platform: "local",
    conversationId,
  });
  if (!parsed.success) {
    throw new Error(`Invalid local conversation id: ${conversationId}`);
  }
  return parsed.data;
}

function actorFromMetadata(metadata: ApiTurnMailboxMetadata): LocalActor {
  return {
    platform: "local",
    userId: metadata.authorUserId,
    email: normalizeEmail(metadata.authorEmail),
    ...(metadata.authorFullName ? { fullName: metadata.authorFullName } : {}),
    ...(metadata.authorUserName ? { userName: metadata.authorUserName } : {}),
  };
}

function storedActorFromLocal(actor: LocalActor) {
  return {
    ...(actor.email ? { email: normalizeEmail(actor.email) } : {}),
    ...(actor.fullName ? { fullName: actor.fullName } : {}),
    ...(actor.userName ? { slackUserName: actor.userName } : {}),
  };
}

/** Build one API mailbox entry with conversation-only publish. */
export function buildApiTurnInboundMessage(args: {
  actor: LocalActor;
  conversationId: string;
  createdAtMs?: number;
  message: string;
  messageId: string;
  nowMs?: number;
}): InboundMessage {
  const text = args.message.trim();
  if (!text) {
    throw new Error("API conversation message must not be empty");
  }
  if (!args.actor.email) {
    throw new Error("API conversation actor requires a verified email");
  }
  const destination = requireLocalDestination(args.conversationId);
  const nowMs = args.nowMs ?? Date.now();
  return {
    conversationId: args.conversationId,
    createdAtMs: args.createdAtMs ?? nowMs,
    delivery: "defer",
    destination,
    inboundMessageId: args.messageId,
    input: {
      authorId: args.actor.userId,
      text,
      metadata: {
        authorEmail: normalizeEmail(args.actor.email),
        ...(args.actor.fullName ? { authorFullName: args.actor.fullName } : {}),
        authorUserId: args.actor.userId,
        ...(args.actor.userName ? { authorUserName: args.actor.userName } : {}),
        kind: "api_turn",
        messageId: args.messageId,
      } satisfies ApiTurnMailboxMetadata,
    },
    receivedAtMs: nowMs,
    publishExternally: false,
    source: "api",
  };
}

async function recordApiConversationActivity(args: {
  actor: LocalActor;
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs: number;
}): Promise<LocalDestination> {
  const destination = requireLocalDestination(args.conversationId);
  const source = createLocalSource(args.conversationId);
  await (args.conversationStore ?? getConversationStore()).recordActivity({
    conversationId: args.conversationId,
    destination,
    nowMs: args.nowMs,
    actor: storedActorFromLocal(args.actor),
    source: "api",
    sessionSource: source,
    visibility: "private",
  });
  return destination;
}

/** Create a private root conversation and enqueue its first message. */
export async function createAndEnqueueApiConversation(
  input: CreateApiConversationInput,
  options: EnqueueOptions,
): Promise<ApiConversationMessageAccepted> {
  const conversationId = createApiConversationId();
  return await appendAndEnqueueApiConversationMessage(
    {
      actor: input.actor,
      conversationId,
      idempotencyKey: input.idempotencyKey,
      message: input.message,
    },
    options,
  );
}

/** Append one API message to an existing conversation and wake the worker. */
export async function appendAndEnqueueApiConversationMessage(
  input: AppendApiConversationMessageInput,
  options: EnqueueOptions,
): Promise<ApiConversationMessageAccepted> {
  const text = input.message.trim();
  if (!text) {
    throw new Error("API conversation message must not be empty");
  }
  if (!input.actor.email) {
    throw new Error("API conversation actor requires a verified email");
  }
  requireLocalDestination(input.conversationId);
  const nowMs = options.nowMs ?? Date.now();
  const messageId = apiMessageId({
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
  });
  await recordApiConversationActivity({
    actor: input.actor,
    conversationId: input.conversationId,
    conversationStore: options.conversationStore,
    nowMs,
  });
  const result = await appendAndEnqueueInboundMessage({
    message: buildApiTurnInboundMessage({
      actor: input.actor,
      conversationId: input.conversationId,
      message: text,
      messageId,
      nowMs,
    }),
    conversationStore: options.conversationStore,
    nowMs,
    queue: options.queue,
    state: options.state,
  });
  return {
    conversationId: input.conversationId,
    messageId,
    status: result.status === "duplicate" ? "duplicate" : "accepted",
  };
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
    throw new Error("Conversation mailbox mixes API turns and other input");
  }
  return parsed.map((entry) => {
    if (!entry.metadata.success) {
      throw new Error("API turn mailbox metadata failed validation");
    }
    return { message: entry.message, metadata: entry.metadata.data };
  });
}

/** True when this leased attempt is API-authored root work. */
export function isApiTurnWork(context: ConversationWorkerContext): boolean {
  return parseApiTurnMessages(context.attempt.messages).length > 0;
}

function captureApiBoundaryFailure(args: {
  conversationId: string;
  error: unknown;
  failureCode: ConversationTurnFailureCode;
  runId?: string;
  turnId: string;
}): string | undefined {
  const eventId = logException(args.error, `api.turn.${args.failureCode}`, {
    conversationId: args.conversationId,
    ...(args.runId ? { runId: args.runId } : {}),
    turnId: args.turnId,
  });
  return typeof eventId === "string" ? eventId : undefined;
}

/** Build the mailbox consumer for API-authored root turns. */
export function createApiTurnWorker(options: {
  agentRunner: AgentRunner;
  turnLifecycle?: ConversationTurnLifecycle;
}) {
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const batch = parseApiTurnMessages(context.attempt.messages);
    if (batch.length === 0) {
      throw new Error(
        `API turn worker received non-API work for ${context.conversationId}`,
      );
    }
    if (context.publishExternally) {
      throw new Error(
        `API turn work must not publish externally for ${context.conversationId}`,
      );
    }

    const first = batch[0]!;
    const text = batch
      .map((entry) => entry.message.input.text.trim())
      .filter(Boolean)
      .join("\n\n");
    const actor = actorFromMetadata(first.metadata);
    const destination = requireLocalDestination(context.conversationId);
    const source = createLocalSource(context.conversationId);
    const turnId = apiTurnIdForMessage(first.metadata.messageId);
    const userMessageId = first.metadata.messageId;
    const lifecycle =
      options.turnLifecycle ??
      new ConversationTurnLifecycleService(getConversationEventStore());

    return await withLogContext(
      {
        conversationId: context.conversationId,
        platform: "local",
        userId: actor.userId,
        ...(actor.userName ? { userName: actor.userName } : {}),
      },
      async () => {
        let acknowledged = false;
        const acknowledge = async (): Promise<void> => {
          if (acknowledged) {
            return;
          }
          try {
            await context.attempt.ack();
          } catch {
            throw new TurnInputCommitLostError(
              `Conversation work lease lost before API turn inbox ack for ${context.conversationId}`,
            );
          }
          acknowledged = true;
        };

        const persisted = await getPersistedThreadState(context.conversationId);
        const conversation = coerceThreadConversationState(persisted);
        await hydrateConversationMessages({
          conversation,
          conversationId: context.conversationId,
        });
        let sandboxRef: SandboxRef | undefined =
          getPersistedSandboxState(persisted);
        const initialSandboxRef = sandboxRef;
        const startedAtMs = first.message.createdAtMs;

        upsertConversationMessage(conversation, {
          id: userMessageId,
          role: "user",
          text: normalizeConversationText(text),
          createdAtMs: startedAtMs,
          author: {
            ...(actor.fullName ? { fullName: actor.fullName } : {}),
            userId: actor.userId,
            ...(actor.userName ? { userName: actor.userName } : {}),
          },
          meta: {
            explicitMention: true,
            replied: false,
          },
        });
        await persistConversationMessages({
          conversation,
          conversationId: context.conversationId,
        });
        await lifecycle.start({
          conversationId: context.conversationId,
          createdAtMs: Date.now(),
          inputMessageIds: batch.map((entry) => entry.metadata.messageId),
          surface: "api",
          turnId,
        });
        startActiveTurn({
          conversation,
          nextTurnId: turnId,
        });

        let currentRunId: string | undefined;
        let assistantMessageDelivered = false;
        let failureCode: ConversationTurnFailureCode = "persistence_failed";
        let modelFailureEventId: string | undefined;
        let modelFailureCaptureAttempted = false;
        let reply: AgentRunResult | undefined;

        const deliverAssistantMessage = async (
          value: AssistantMessage | string,
        ): Promise<void> => {
          const replyText =
            typeof value === "string" ? value : getAssistantReplyText(value);
          if (!replyText?.trim()) {
            return;
          }
          failureCode = "delivery_failed";
          assistantMessageDelivered = true;
          // Visible conversation messages feed the dashboard transcript.
          // Agent history is committed once by the completed checkpoint.
          recordDeliveredAssistantMessage({
            conversation,
            sessionId: turnId,
            text: replyText,
            userMessageId,
          });
          try {
            await persistWithRetry(() =>
              persistConversationMessages({
                conversation,
                conversationId: context.conversationId,
              }),
            );
          } catch (error) {
            logException(
              new Error("Accepted assistant message persistence failed"),
              "api.assistant.message_post_delivery_persist.failed",
              {
                "error.type":
                  error instanceof Error ? error.name : typeof error,
              },
            );
          }
          failureCode = "agent_run_failed";
        };

        try {
          await persistThreadStateById(context.conversationId, {
            conversation,
          });
          const piMessages = await loadProjection({
            conversationId: context.conversationId,
          });
          failureCode = "agent_run_failed";
          currentRunId = `api-run:${stableHex(turnId, String(startedAtMs))}`;
          setTags({ runId: currentRunId });

          const outcome = await options.agentRunner.run({
            conversationId: context.conversationId,
            turnId,
            runId: currentRunId,
            input: {
              messageText: text,
              conversationContext: buildConversationContext(conversation, {
                excludeMessageId: userMessageId,
              }),
              piMessages,
            },
            routing: {
              actor,
              credentialContext: credentialContextForActor(actor),
              destination,
              publishExternally: false,
              source,
              surface: "api",
            },
            policy: {
              disabledFeatures: ["interactive-auth"] as const,
            },
            state: {
              pendingAuth: conversation.processing.pendingAuth,
              sandboxRef,
            },
            delivery: deliverAssistantMessage,
            durability: {
              onInputCommitted: acknowledge,
              shouldYield: context.shouldYield,
              onSandboxRefChanged: async (nextSandboxRef) => {
                sandboxRef = nextSandboxRef;
                await persistThreadStateById(context.conversationId, {
                  conversation,
                  sandboxRef,
                });
              },
            },
          });

          if (outcome.status === "suspended") {
            return { status: "yielded" };
          }
          if (outcome.status !== "completed") {
            throw new Error(`API agent run ended with ${outcome.status}`);
          }

          reply = outcome.result;
          modelFailureCaptureAttempted = reply.diagnostics.outcome !== "success";
          const finalized = finalizeFailedTurnReplyWithEvent({
            reply,
            logException,
          });
          reply = finalized.reply;
          modelFailureEventId = finalized.eventId;
          if (reply.diagnostics.outcome !== "success") {
            await deliverAssistantMessage(reply.text);
          }

          const completedState = buildDeliveredTurnStatePatch({
            conversation,
            reply,
            sessionId: turnId,
            userMessageId,
          });
          await persistThreadStateById(context.conversationId, {
            conversation: completedState.conversation,
            sandboxRef: reply.sandboxRef ?? sandboxRef,
          });
          if (reply.piMessages?.length) {
            await saveTurnCheckpoint({
              mode: "completed",
              conversationId: context.conversationId,
              turnId,
              sliceId: 1,
              messages: reply.piMessages,
              durationMs: reply.diagnostics.durationMs,
              usage: reply.diagnostics.usage,
              destination,
              publishExternally: false,
              source,
              actor,
              surface: "api",
            });
          }

          if (reply.diagnostics.outcome === "success") {
            await lifecycle.complete({
              conversationId: context.conversationId,
              createdAtMs: Date.now(),
              outcome: assistantMessageDelivered ? "success" : "no_reply",
              turnId,
            });
            try {
              await scheduleSessionCompletedPluginTasks(
                {
                  conversationId: context.conversationId,
                  sessionId: turnId,
                },
                {
                  send: async (message) => {
                    try {
                      await processPluginTask(message);
                    } catch (error) {
                      logException(
                        error,
                        "api.plugin.session_completion_task.failed",
                        {
                          conversationId: context.conversationId,
                          pluginName: message.plugin,
                          taskName: message.name,
                          turnId,
                        },
                      );
                    }
                  },
                },
              );
            } catch (error) {
              logException(error, "api.plugin.session_completion_task.failed", {
                conversationId: context.conversationId,
                turnId,
              });
            }
          } else {
            await lifecycle.fail({
              conversationId: context.conversationId,
              createdAtMs: Date.now(),
              ...(modelFailureEventId ? { eventId: modelFailureEventId } : {}),
              failureCode: "model_execution_failed",
              turnId,
            });
          }

          await acknowledge();
          return { status: "completed" };
        } catch (error) {
          const cause = getConversationTurnBoundaryError(error)?.cause ?? error;
          if (
            isTurnInputCommitLostError(error) ||
            isTurnInputCommitLostError(cause)
          ) {
            return { status: "lost_lease" };
          }
          if (!context.attempt.isFinalAttempt) {
            throw error;
          }

          const failureEventId =
            modelFailureCaptureAttempted && failureCode === "agent_run_failed"
              ? modelFailureEventId
              : captureApiBoundaryFailure({
                  conversationId: context.conversationId,
                  error,
                  failureCode,
                  runId: currentRunId,
                  turnId,
                });
          try {
            markTurnFailed({
              conversation,
              nowMs: Date.now(),
              sessionId: turnId,
              userMessageId,
              markConversationMessage,
            });
            await persistThreadStateById(context.conversationId, {
              conversation,
              sandboxRef: initialSandboxRef ?? null,
            });
          } catch (persistenceError) {
            captureApiBoundaryFailure({
              conversationId: context.conversationId,
              error: persistenceError,
              failureCode: "persistence_failed",
              runId: currentRunId,
              turnId,
            });
          }
          await lifecycle.fail({
            conversationId: context.conversationId,
            createdAtMs: Date.now(),
            ...(failureEventId ? { eventId: failureEventId } : {}),
            failureCode,
            turnId,
          });
          await acknowledge();
          return { status: "completed" };
        }
      },
    );
  };
}

/** Route API turn work before falling through to other consumers. */
export function routeApiTurnWork(options: {
  apiTurnWorker: (
    context: ConversationWorkerContext,
  ) => Promise<ConversationWorkerResult>;
  fallbackWorker: (
    context: ConversationWorkerContext,
  ) => Promise<ConversationWorkerResult>;
}) {
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    return isApiTurnWork(context)
      ? await options.apiTurnWorker(context)
      : await options.fallbackWorker(context);
  };
}
