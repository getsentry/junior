/**
 * API-authored conversation turns.
 *
 * Dashboard and product API messages enter the shared mailbox with
 * `publishExternally: false`. The worker leases the conversation, runs the
 * shared agent path, and accepts replies into the conversation log only.
 * Continues of Slack-rooted conversations keep the Slack destination for
 * location context and never publish back to Slack.
 */
import { createHash } from "node:crypto";
import type { StateAdapter } from "chat";
import {
  createWebSource,
  localDestinationSchema,
  type Destination,
  type LocalDestination,
  type Source,
} from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { WebActor } from "@/chat/actor";
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
  recordDeliveredAssistantMessage,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { finalizeFailedTurnReplyWithEvent } from "@/chat/services/turn-failure-response";
import { persistWithRetry } from "@/chat/services/persist-retry";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import {
  appendAndEnqueueInboundMessage,
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
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { StoredSlackActor } from "@/chat/actor";
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
  type ApiTurnMailboxMetadata,
} from "@/chat/api-turns/routing";

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

function apiMessageId(args: {
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

/** Build the web Source for one dashboard turn, inheriting conversation privacy. */
function webSourceForConversation(args: {
  conversationId: string;
  visibility?: ConversationPrivacy;
}): Source {
  return createWebSource(
    args.conversationId,
    args.visibility === "private" ? "private" : "public",
  );
}

function actorFromMetadata(metadata: ApiTurnMailboxMetadata): WebActor {
  return {
    platform: "web",
    userId: metadata.authorUserId,
    email: normalizeEmail(metadata.authorEmail),
    ...(metadata.authorFullName ? { fullName: metadata.authorFullName } : {}),
    ...(metadata.authorUserName ? { userName: metadata.authorUserName } : {}),
  };
}

/** Durable conversation actor fields for web/dashboard participants. */
function storedActorFromApi(actor: WebActor): StoredSlackActor {
  return {
    ...(actor.email ? { email: normalizeEmail(actor.email) } : {}),
    ...(actor.fullName ? { fullName: actor.fullName } : {}),
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
    ...(profile?.fullName ? { fullName: profile.fullName } : {}),
    ...(profile?.userName ? { userName: profile.userName } : {}),
  };
}

function actorFromStoredConversation(
  stored?: StoredSlackActor,
): WebActor | undefined {
  const email = stored?.email?.trim().toLowerCase();
  if (!email) {
    return undefined;
  }
  return webActorFromEmail(
    email,
    stored?.fullName ? { fullName: stored.fullName } : undefined,
  );
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
        ...(args.actor.fullName ? { authorFullName: args.actor.fullName } : {}),
        authorUserId: args.actor.userId,
        ...(args.actor.userName ? { authorUserName: args.actor.userName } : {}),
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
    ? webSourceForConversation({
        conversationId: args.conversationId,
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
    ...(isNewRoot ? { source: "web" as const } : {}),
    ...(source ? { sessionSource: source } : {}),
    ...(isNewRoot ? { visibility } : {}),
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
  const nowMs = options.nowMs ?? Date.now();
  const messageId = apiMessageId({
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
  });
  const destination = await recordApiConversationActivity({
    actor: input.actor,
    conversationId: input.conversationId,
    conversationStore: options.conversationStore,
    nowMs,
    ...(input.rootVisibility ? { rootVisibility: input.rootVisibility } : {}),
  });
  const result = await appendAndEnqueueInboundMessage({
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
  return {
    conversationId: input.conversationId,
    messageId,
    status: result.status === "duplicate" ? "duplicate" : "accepted",
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
    ...(args.runId ? { runId: args.runId } : {}),
    turnId: args.turnId,
  });
  return typeof eventId === "string" ? eventId : undefined;
}

/** Build the mailbox consumer for API-authored root turns. */
export function createApiTurnWorker(options: {
  agentRunner: AgentRunner;
  cancellation?: ApiTurnCancellation;
  turnLifecycle?: ConversationTurnLifecycle;
}) {
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const resolved = await resolveApiTurnWork(context);
    if (!resolved) {
      throw new Error(
        `API turn worker received non-API work for ${context.conversationId}`,
      );
    }
    if (context.publishExternally) {
      throw new Error(
        `API turn work must not publish externally for ${context.conversationId}`,
      );
    }

    const lifecycle =
      options.turnLifecycle ??
      new ConversationTurnLifecycleService(getConversationEventStore());

    const isResume = resolved.kind === "resume";
    let actor: WebActor;
    let text: string;
    let turnId: string;
    let userMessageId: string;
    let startedAtMs: number;
    let inputMessageIds: string[];

    const storedConversation = await getConversationStore().get({
      conversationId: context.conversationId,
    });

    if (resolved.kind === "mailbox") {
      const first = resolved.batch[0]!;
      text = resolved.batch
        .map((entry) => entry.message.input.text.trim())
        .filter(Boolean)
        .join("\n\n");
      actor = actorFromMetadata(first.metadata);
      turnId = apiTurnIdForMessage(first.metadata.messageId);
      userMessageId = first.metadata.messageId;
      startedAtMs = first.message.createdAtMs;
      inputMessageIds = resolved.batch.map((entry) => entry.metadata.messageId);
    } else {
      turnId = resolved.turnId;
      // Execution actor is rebuilt at resume from the durable conversation
      // identity. For Slack-rooted continues, the root actor keeps the verified
      // participant email used by dashboard access.
      const resumedActor = actorFromStoredConversation(
        storedConversation?.actor,
      );
      if (!resumedActor) {
        throw new Error(
          `API turn resume missing actor for ${context.conversationId}`,
        );
      }
      actor = resumedActor;
      // User message text/id are recovered from thread state below.
      text = "";
      userMessageId = "";
      startedAtMs = Date.now();
      inputMessageIds = [];
    }

    // Prefer the leased mailbox destination, then durable conversation state.
    const destination = resolveApiTurnDestination({
      conversationId: context.conversationId,
      existing:
        context.destination ??
        (resolved.kind === "mailbox"
          ? resolved.batch[0]?.message.destination
          : undefined) ??
        storedConversation?.destination,
    });
    const source = webSourceForConversation({
      conversationId: context.conversationId,
      visibility: storedConversation?.visibility,
    });

    return await withLogContext(
      {
        conversationId: context.conversationId,
        platform: "web",
        userId: actor.userId,
        ...(actor.userName ? { userName: actor.userName } : {}),
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

        if (isResume) {
          const userMessage = getTurnUserMessage(conversation, turnId);
          if (!userMessage) {
            throw new Error(
              `Unable to locate the persisted user message for API turn "${turnId}"`,
            );
          }
          userMessageId = userMessage.id;
          text = userMessage.text;
          startedAtMs = userMessage.createdAtMs;
          inputMessageIds = [userMessageId];
        } else {
          // Match Slack: a newer user message supersedes an auth-parked turn
          // instead of leaving two active API turns or letting a late OAuth
          // wake resume stale work.
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
            await abandonTurnRecord({
              conversationId: context.conversationId,
              turnId: parked.turnId,
              errorMessage:
                "Auth-parked session superseded by a new user message",
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
          if (authParked.length > 0) {
            // Drop the dashboard connect prompt so a superseded OAuth flow
            // cannot leave a stale banner after the user moves on.
            await deleteWebAuthorization({
              actorId: actor.userId,
              conversationId: context.conversationId,
            });
          }
          upsertConversationMessage(conversation, {
            id: userMessageId,
            role: "user",
            text: normalizeConversationText(text),
            createdAtMs: startedAtMs,
            author: {
              ...(actor.email ? { email: actor.email } : {}),
              ...(actor.fullName ? { fullName: actor.fullName } : {}),
              userId: actor.userId,
              ...(actor.userName ? { userName: actor.userName } : {}),
            },
            meta: {
              explicitMention: true,
              replied: false,
              source: "web",
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
        let reply: AgentRunResult | undefined;
        const cancellationSignal = options.cancellation?.signal(
          context.conversationId,
        );
        const finishCancellation = (): void => {
          if (cancellationSignal) {
            options.cancellation?.finish(
              context.conversationId,
              cancellationSignal,
            );
          }
        };

        const completeCancelledTurn =
          async (): Promise<ConversationWorkerResult> => {
            await completeCancelledApiTurn({
              acknowledge,
              actorId: actor.userId,
              cancellation: options.cancellation,
              conversation,
              conversationId: context.conversationId,
              lifecycle,
              sandboxRef,
              signal: cancellationSignal,
              turnId,
              userMessageId,
            });
            return { status: "completed" };
          };

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
            source: "web",
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
          if (cancellationSignal?.aborted) {
            return await completeCancelledTurn();
          }
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
            ...(cancellationSignal ? { signal: cancellationSignal } : {}),
            authorization: createWebAuthorization({
              actorId: actor.userId,
              conversationId: context.conversationId,
            }),
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
          });

          if (cancellationSignal?.aborted) {
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
            if (cancellationSignal) {
              options.cancellation?.park(
                context.conversationId,
                cancellationSignal,
              );
            }
            await acknowledge();
            return { status: "completed" };
          }
          finishCancellation();
          reply = outcome.result;
          modelFailureCaptureAttempted =
            reply.diagnostics.outcome !== "success";
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
            // Prefer the live checkpoint slice after yield/resume; first
            // completion has no prior record and starts at slice 1.
            const latest = await getTurnRecord(context.conversationId, turnId);
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
          if (cancellationSignal?.aborted) {
            return await completeCancelledTurn();
          }
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
          finishCancellation();
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
    return (await isApiTurnWork(context))
      ? await options.apiTurnWorker(context)
      : await options.fallbackWorker(context);
  };
}
