/** Conversation API work runs a native Turn and keeps replies in the Conversation. */
import { createHash } from "node:crypto";
import type { StateAdapter } from "chat";
import {
  localDestinationSchema,
  type Destination,
  type LocalDestination,
} from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type StoredSlackActor, type WebActor } from "@/chat/actor";
import type { ConversationStore } from "@/chat/conversations/store";
import { loadProjection } from "@/chat/conversations/projection";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import { commitWebAcceptedReply } from "@/chat/api-turns/accepted-reply";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import type { ConversationTurnFailureCode } from "@/chat/conversations/history";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { logException, setTags, withLogContext } from "@/chat/logging";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { AgentRunError, executeTurn } from "@/chat/runtime/turn-execution";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import {
  getConversationTurnBoundaryError,
  isTurnInputCommitLostError,
  markTurnClosed,
  markTurnFailed,
  startActiveTurn,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import { completeAuthPauseTurn } from "@/chat/runtime/auth-pause-state";
import { getTurnUserMessage } from "@/chat/runtime/turn-user-message";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import {
  buildConversationContext,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { finalizeFailedTurnReplyWithEvent } from "@/chat/services/turn-failure-response";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  appendAndEnqueueInboundMessage,
  appendAndEnqueueExclusiveInboundMessage,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  abandonTurnRecord,
  getTurnRecord,
  listTurnSummaries,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  processPluginTask,
  scheduleSessionCompletedPluginTasks,
} from "@/chat/plugins/task-runner";
import type { SandboxRef } from "@/chat/sandbox/ref";
import {
  createWebAuthorization,
  deleteWebAuthorization,
} from "@/chat/api-turns/authorization";
import {
  completeCancelledApiTurn,
  type ApiTurnCancellation,
} from "@/chat/api-turns/cancellation";
import {
  isApiTurnWork,
  resolveApiTurnWork,
  sourceFromTurnInput,
  turnIdentityFromConversationMessage,
  type ApiTurnMailboxMetadata,
  type TurnIdentity,
} from "@/chat/api-turns/routing";
import { joinMailboxText } from "@/chat/api-turns/mailbox-input";

export { resolveApiTurnWork } from "@/chat/api-turns/routing";

type EnqueueOptions = {
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
};

export interface CreateApiConversationInput {
  actor: WebActor;
  message: string;
  /** Client-supplied idempotency key for the first message. */
  idempotencyKey: string;
  /** New roots default public. Continues never rewrite visibility. */
  visibility?: ConversationPrivacy;
}

export interface AppendApiConversationMessageInput {
  actor: WebActor;
  conversationId: string;
  message: string;
  idempotencyKey: string;
  /** Applied only when this call creates the conversation root. */
  rootVisibility?: ConversationPrivacy;
}

export interface ApiConversationMessageAccepted {
  conversationId: string;
  messageId: string;
  status: "accepted" | "duplicate";
}

export type ApiConversationMessageAdmission =
  | ApiConversationMessageAccepted
  | { conversationId: string; messageId: string; status: "active" };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function stableHex(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Build a durable API conversation id for one viewer + create key.
 *
 * Retries of POST /api/conversations with the same key must address the same
 * conversation before the mailbox message id is derived.
 */
export function createApiConversationId(args: {
  actorEmail: string;
  idempotencyKey: string;
}): string {
  return `local:web:${stableHex(
    normalizeEmail(args.actorEmail),
    args.idempotencyKey,
  )}`;
}

/** Build the retry-stable Message id used by one API mailbox request. */
export function apiConversationMessageId(args: {
  conversationId: string;
  idempotencyKey: string;
}): string {
  return `api-msg:${stableHex(args.conversationId, args.idempotencyKey)}`;
}

/** Stable turn id for one API mailbox message (matches getTurnUserMessage). */
export function apiTurnIdForMessage(messageId: string): string {
  return buildDeterministicTurnId(messageId);
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

/** Keep an existing destination, or create a local one for new dashboard roots. */
function resolveApiTurnDestination(args: {
  conversationId: string;
  existing?: Destination;
}): Destination {
  if (args.existing) {
    return args.existing;
  }
  return requireLocalDestination(args.conversationId);
}

/** Durable conversation actor fields for web/dashboard participants. */
function storedActorFromApi(actor: WebActor): StoredSlackActor {
  return {
    ...(actor.email ? { email: normalizeEmail(actor.email) } : undefined),
    ...(actor.fullName ? { fullName: actor.fullName } : undefined),
  };
}

/** Rebuild the dashboard actor from durable conversation identity. */
export function webActorFromEmail(
  email: string,
  profile?: { fullName?: string; userName?: string },
): WebActor {
  const normalized = normalizeEmail(email);
  return {
    platform: "web",
    userId: `dashboard:${stableHex(normalized)}`,
    email: normalized,
    ...(profile?.fullName ? { fullName: profile.fullName } : undefined),
    ...(profile?.userName ? { userName: profile.userName } : undefined),
  };
}

/** Build one API mailbox entry with conversation-only publish. */
export function buildApiTurnInboundMessage(args: {
  actor: WebActor;
  conversationId: string;
  createdAtMs?: number;
  /** Existing conversation destination; required when continuing a provider root. */
  destination?: Destination;
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
  const destination = resolveApiTurnDestination({
    conversationId: args.conversationId,
    existing: args.destination,
  });
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
        ...(args.actor.fullName && { authorFullName: args.actor.fullName }),
        authorUserId: args.actor.userId,
        ...(args.actor.userName && { authorUserName: args.actor.userName }),
        kind: "api_turn",
        messageId: args.messageId,
      } satisfies ApiTurnMailboxMetadata,
    },
    receivedAtMs: nowMs,
    publishExternally: false,
    source: "web",
  };
}

/** Record web activity and materialize a new API Conversation root when needed. */
export async function recordApiConversationActivity(args: {
  actor: WebActor;
  conversationId: string;
  conversationStore?: ConversationStore;
  nowMs: number;
  /** Applied only when this call creates the conversation root. */
  rootVisibility?: ConversationPrivacy;
}): Promise<Destination> {
  const store = args.conversationStore ?? getConversationStore();
  const existing = await store.get({ conversationId: args.conversationId });
  const destination = resolveApiTurnDestination({
    conversationId: args.conversationId,
    existing: existing?.destination,
  });
  // New dashboard roots default public. Continues inherit the existing root
  // visibility and keep the original session source (set-once).
  const isNewRoot = !existing;
  const visibility = args.rootVisibility === "private" ? "private" : "public";
  const source = isNewRoot
    ? sourceFromTurnInput({
        conversationId: args.conversationId,
        source: "web",
        visibility,
      })
    : undefined;
  await store.recordActivity({
    conversationId: args.conversationId,
    destination,
    nowMs: args.nowMs,
    actor: storedActorFromApi(args.actor),
    // Do not rewrite a Slack root's origin source when a dashboard participant
    // continues it. Mailbox entries still carry source "web" per turn.
    ...(isNewRoot ? { source: "web" as const } : undefined),
    ...(source ? { sessionSource: source } : undefined),
    ...(isNewRoot ? { visibility } : undefined),
  });
  return destination;
}

/** Create a dashboard root conversation and enqueue its first message. */
export async function createAndEnqueueApiConversation(
  input: CreateApiConversationInput,
  options: EnqueueOptions,
): Promise<ApiConversationMessageAccepted> {
  if (!input.actor.email) {
    throw new Error("API conversation actor requires a verified email");
  }
  const conversationId = createApiConversationId({
    actorEmail: input.actor.email,
    idempotencyKey: input.idempotencyKey,
  });
  return await appendAndEnqueueApiConversationMessage(
    {
      actor: input.actor,
      conversationId,
      idempotencyKey: input.idempotencyKey,
      message: input.message,
      rootVisibility: input.visibility === "private" ? "private" : "public",
    },
    options,
  );
}

/** Append one Conversation API message and optionally require an idle Conversation. */
export function appendAndEnqueueApiConversationMessage(
  input: AppendApiConversationMessageInput,
  options: EnqueueOptions & { exclusive: true },
): Promise<ApiConversationMessageAdmission>;
export function appendAndEnqueueApiConversationMessage(
  input: AppendApiConversationMessageInput,
  options: EnqueueOptions,
): Promise<ApiConversationMessageAccepted>;
export async function appendAndEnqueueApiConversationMessage(
  input: AppendApiConversationMessageInput,
  options: EnqueueOptions & { exclusive?: boolean },
): Promise<ApiConversationMessageAdmission> {
  const text = input.message.trim();
  if (!text) {
    throw new Error("API conversation message must not be empty");
  }
  if (!input.actor.email) {
    throw new Error("API conversation actor requires a verified email");
  }
  const nowMs = options.nowMs ?? Date.now();
  const messageId = apiConversationMessageId({
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
  });
  const destination = await recordApiConversationActivity({
    actor: input.actor,
    conversationId: input.conversationId,
    conversationStore: options.conversationStore,
    nowMs,
    ...(input.rootVisibility && { rootVisibility: input.rootVisibility }),
  });
  const enqueue = options.exclusive
    ? appendAndEnqueueExclusiveInboundMessage
    : appendAndEnqueueInboundMessage;
  const result = await enqueue({
    message: buildApiTurnInboundMessage({
      actor: input.actor,
      conversationId: input.conversationId,
      destination,
      message: text,
      messageId,
      nowMs,
    }),
    conversationStore: options.conversationStore,
    nowMs,
    queue: options.queue,
    state: options.state,
  });
  const status = result.status === "appended" ? "accepted" : result.status;
  return {
    conversationId: input.conversationId,
    messageId,
    status,
  };
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
    ...(args.runId ? { runId: args.runId } : undefined),
    turnId: args.turnId,
  });
  return typeof eventId === "string" ? eventId : undefined;
}

function hasLostTurnInputCommit(error: unknown): boolean {
  const cause = getConversationTurnBoundaryError(error)?.cause ?? error;
  return isTurnInputCommitLostError(error) || isTurnInputCommitLostError(cause);
}

/** Create the worker for Turns that need no provider delivery. */
export function createApiTurnWorker(
  agentRunner: AgentRunner,
  cancellation?: ApiTurnCancellation,
) {
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const resolved = await resolveApiTurnWork(context);
    if (!resolved) {
      throw new Error(
        `Unsupported input for Conversation ${context.conversationId}`,
      );
    }
    if (context.publishExternally) {
      throw new Error(
        `publishExternally must be false for Conversation ${context.conversationId}`,
      );
    }

    const lifecycle = new ConversationTurnLifecycleService(
      getConversationEventStore(),
    );

    const isResume = resolved.kind === "resume";
    let turnIdentity: TurnIdentity | undefined;
    let text = "";
    let turnId = "";
    let userMessageId = "";
    let startedAtMs = Date.now();
    let inputMessageIds: string[] = [];

    const storedConversation = await getConversationStore().get({
      conversationId: context.conversationId,
    });
    const mailboxDestination =
      resolved.kind === "mailbox"
        ? resolved.batch[0]?.message.destination
        : undefined;
    const destination = resolveApiTurnDestination({
      conversationId: context.conversationId,
      existing:
        context.destination ??
        mailboxDestination ??
        storedConversation?.destination,
    });
    if (resolved.kind === "mailbox") {
      const first = resolved.batch[0]!;
      text = joinMailboxText(resolved.batch.map((entry) => entry.message));
      startedAtMs = first.message.createdAtMs;
      userMessageId = first.message.inboundMessageId;
      turnId = apiTurnIdForMessage(userMessageId);
      inputMessageIds = resolved.batch.map(
        (entry) => entry.message.inboundMessageId,
      );
      turnIdentity = first;
    } else {
      turnId = resolved.turnId;
    }

    const persisted = await getPersistedThreadState(context.conversationId);
    const conversation = coerceThreadConversationState(persisted);
    await hydrateConversationMessages({
      conversation,
      conversationId: context.conversationId,
    });
    if (isResume) {
      const userMessage = getTurnUserMessage(conversation, turnId);
      if (!userMessage) {
        throw new Error(
          `Unable to locate the persisted user message for Turn "${turnId}"`,
        );
      }
      // Resume has no new input. Restore the Actor from the saved Turn input.
      turnIdentity = turnIdentityFromConversationMessage(userMessage);
      userMessageId = userMessage.id;
      text = userMessage.text;
      startedAtMs = userMessage.createdAtMs;
      inputMessageIds = [userMessageId];
    }
    if (!turnIdentity) {
      throw new Error(
        `Resumed Turn is missing an Actor for Conversation ${context.conversationId}`,
      );
    }
    const { actor, author } = turnIdentity;
    const source = sourceFromTurnInput({
      conversationId: context.conversationId,
      source: turnIdentity.source,
      visibility: storedConversation?.visibility,
    });
    const webActor = actor.platform === "web" ? actor : undefined;

    return await withLogContext(
      {
        conversationId: context.conversationId,
        platform: actor.platform,
        ...(webActor
          ? {
              userId: webActor.userId,
              ...(webActor.userName
                ? { userName: webActor.userName }
                : undefined),
            }
          : undefined),
      },
      async () => {
        let acknowledged = isResume || context.attempt.messages.length === 0;
        const acknowledge = async (): Promise<void> => {
          if (acknowledged) {
            return;
          }
          try {
            await context.attempt.ack();
          } catch {
            throw new TurnInputCommitLostError(
              `Conversation work lease lost before Conversation API message acknowledgement for ${context.conversationId}`,
            );
          }
          acknowledged = true;
        };

        let sandboxRef: SandboxRef | undefined =
          getPersistedSandboxState(persisted);
        const initialSandboxRef = sandboxRef;
        const appSignal = cancellation?.signal(context.conversationId);
        const stopSignal = context.stopSignal?.();
        const cancellationSignal =
          appSignal && stopSignal
            ? AbortSignal.any([appSignal, stopSignal])
            : (appSignal ?? stopSignal);
        const finishCancellation = (): void => {
          if (appSignal) {
            cancellation?.finish(context.conversationId, appSignal);
          }
        };
        const completeCancelledTurn =
          async (): Promise<ConversationWorkerResult> => {
            try {
              await completeCancelledApiTurn({
                acknowledge,
                cancellation,
                conversation,
                conversationId: context.conversationId,
                sandboxRef,
                signal: appSignal,
                turnId,
                userMessageId,
              });
            } catch (error) {
              if (hasLostTurnInputCommit(error)) {
                return { status: "lost_lease" };
              }
              throw error;
            }
            return { status: "completed" };
          };

        if (isResume) {
          if (cancellationSignal?.aborted) {
            return await completeCancelledTurn();
          }
        } else {
          upsertConversationMessage(conversation, {
            id: userMessageId,
            role: "user",
            text: normalizeConversationText(text),
            createdAtMs: startedAtMs,
            author,
            meta: {
              explicitMention: true,
              replied: false,
              ...(turnIdentity.source === "web"
                ? { source: "web" as const }
                : undefined),
            },
          });
          await persistConversationMessages({
            conversation,
            conversationId: context.conversationId,
          });
          await lifecycle.start({
            conversationId: context.conversationId,
            createdAtMs: Date.now(),
            inputMessageIds,
            surface: "api",
            turnId,
          });
          if (cancellationSignal?.aborted) {
            return await completeCancelledTurn();
          }
          startActiveTurn({
            conversation,
            nextTurnId: turnId,
          });
        }

        let currentRunId: string | undefined;
        let assistantMessageDelivered = false;
        let failureCode: ConversationTurnFailureCode = "persistence_failed";
        let modelFailureEventId: string | undefined;
        let modelFailureCaptureAttempted = false;
        let completedSuccessfully = false;

        const deliverAssistantMessage = async (
          value: AssistantMessage | string,
        ): Promise<void> => {
          const agentMessage = typeof value === "string" ? undefined : value;
          const replyText =
            typeof value === "string" ? value : getAssistantReplyText(value);
          if (!replyText?.trim()) {
            return;
          }
          failureCode = "delivery_failed";
          assistantMessageDelivered = true;
          await commitWebAcceptedReply({
            ...(agentMessage ? { agentMessage } : undefined),
            conversation,
            conversationId: context.conversationId,
            sessionId: turnId,
            text: replyText,
            userMessageId,
          });
          failureCode = "agent_run_failed";
        };

        try {
          if (cancellationSignal?.aborted) {
            return await completeCancelledTurn();
          }
          if (!isResume) {
            // Match Slack: new input supersedes an auth-paused Turn
            // instead of leaving two active Turns or letting a late OAuth
            // wake resume stale work.
            const pendingAuthorizationActorId =
              conversation.processing.pendingAuth?.actorId;
            const authParked = (
              await listTurnSummaries(context.conversationId)
            ).filter(
              (summary) =>
                summary.surface === "api" &&
                !summary.dispatchId &&
                summary.state === "paused" &&
                summary.resumeReason === "auth",
            );
            for (const parked of authParked) {
              if (cancellationSignal?.aborted) {
                return await completeCancelledTurn();
              }
              await abandonTurnRecord({
                conversationId: context.conversationId,
                turnId: parked.turnId,
                errorMessage: "Auth-paused Turn superseded by new input",
              });
              // Keep pendingAuth: MCP OAuth still needs it to accept an in-flight
              // connect and store credentials. The abandoned turn record makes a
              // late callback a resume no-op, matching Slack supersede behavior.
              markTurnClosed({
                conversation,
                nowMs: Date.now(),
                sessionId: parked.turnId,
              });
            }
            if (authParked.length > 0 && pendingAuthorizationActorId) {
              // Drop the dashboard connect prompt so a superseded OAuth flow
              // cannot leave a stale banner after the user moves on.
              await deleteWebAuthorization({
                actorId: pendingAuthorizationActorId,
                conversationId: context.conversationId,
              });
            }
          }
          await persistThreadStateById(context.conversationId, {
            conversation,
          });
          if (cancellationSignal?.aborted) {
            return await completeCancelledTurn();
          }
          const piMessages = await loadProjection({
            conversationId: context.conversationId,
          });
          failureCode = "agent_run_failed";
          currentRunId = `api-run:${stableHex(turnId, String(startedAtMs))}`;
          setTags({ runId: currentRunId });

          const outcome = await executeTurn(
            agentRunner,
            {
              conversationId: context.conversationId,
              turnId,
              runId: currentRunId,
              instruction: {
                text,
                context: buildConversationContext(conversation, {
                  excludeMessageId: userMessageId,
                }),
              },
              history: piMessages,
              actor,
              credentialContext: credentialContextForActor(actor),
              destination,
              publishExternally: false,
              source,
              surface: "api",
              ...(cancellationSignal
                ? { signal: cancellationSignal }
                : undefined),
              ...(webActor
                ? {
                    authorization: createWebAuthorization({
                      actorId: webActor.userId,
                      conversationId: context.conversationId,
                    }),
                  }
                : { disabledFeatures: ["interactive-auth"] as const }),
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
                recordPendingAuth: async (pendingAuth) => {
                  conversation.processing.pendingAuth = pendingAuth;
                  await persistThreadStateById(context.conversationId, {
                    conversation,
                    sandboxRef,
                  });
                },
              },
            },
            async (result) => {
              if (cancellationSignal?.aborted) {
                throw (
                  cancellationSignal.reason ??
                  new DOMException("Turn cancelled", "AbortError")
                );
              }

              finishCancellation();
              modelFailureCaptureAttempted =
                result.diagnostics.outcome !== "success";
              const finalized = finalizeFailedTurnReplyWithEvent({
                reply: result,
                logException,
              });
              const modelFailureReason = finalized.failureReason;
              const reply = finalized.reply;
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
                // Prefer the live checkpoint slice after yield/resume; first
                // completion has no prior record and starts at slice 1.
                const latest = await getTurnRecord(
                  context.conversationId,
                  turnId,
                );
                await saveTurnCheckpoint({
                  mode: "completed",
                  conversationId: context.conversationId,
                  turnId,
                  sliceId: latest?.sliceId ?? 1,
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

              completedSuccessfully = reply.diagnostics.outcome === "success";
              return completedSuccessfully
                ? {
                    outcome: assistantMessageDelivered ? "success" : "no_reply",
                  }
                : {
                    ...(modelFailureEventId
                      ? { eventId: modelFailureEventId }
                      : undefined),
                    failureCode: "model_execution_failed",
                    ...(modelFailureReason
                      ? { failureReason: modelFailureReason }
                      : undefined),
                    outcome: "failed",
                  };
            },
          );

          if (outcome.status !== "completed" && cancellationSignal?.aborted) {
            return await completeCancelledTurn();
          }

          if (outcome.status === "suspended") {
            return { status: "yielded" };
          }
          if (outcome.status === "awaiting_auth") {
            // Close the live turn the same way Slack does after private-link
            // delivery. The turn record stays paused for OAuth resume; only
            // the conversation active pointer is cleared.
            completeAuthPauseTurn({
              conversation,
              sessionId: turnId,
            });
            await persistThreadStateById(context.conversationId, {
              conversation,
              sandboxRef,
            });
            if (appSignal) {
              cancellation?.park(context.conversationId, appSignal);
            }
            await acknowledge();
            return { status: "paused" };
          }
          if (completedSuccessfully) {
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
          }

          await acknowledge();
          return { status: "completed" };
        } catch (error) {
          const failure = error instanceof AgentRunError ? error.cause : error;
          if (hasLostTurnInputCommit(failure)) {
            return { status: "lost_lease" };
          }
          if (cancellationSignal?.aborted) {
            return await completeCancelledTurn();
          }
          if (!context.attempt.isFinalAttempt) {
            throw failure;
          }

          const failureEventId =
            modelFailureCaptureAttempted && failureCode === "agent_run_failed"
              ? modelFailureEventId
              : captureApiBoundaryFailure({
                  conversationId: context.conversationId,
                  error: failure,
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
            ...(failureEventId ? { eventId: failureEventId } : undefined),
            failureCode,
            turnId,
          });
          finishCancellation();
          await acknowledge();
          return { status: "completed" };
        }
      },
    );
  };
}

/** Route Conversation API work before other work. */
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
    return (await isApiTurnWork(context))
      ? await options.apiTurnWorker(context)
      : await options.fallbackWorker(context);
  };
}
