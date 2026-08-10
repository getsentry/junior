/**
 * Conversation-only turn runtime.
 *
 * This module owns a provider-neutral execution boundary for turns whose
 * assistant output stays in the canonical conversation log. An adapter may
 * observe accepted assistant messages, but this runtime never publishes them
 * to the conversation Destination.
 */
import type { AgentRunResult } from "@/chat/services/turn-result";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { randomUUID } from "node:crypto";
import type { UserActor } from "@/chat/actor";
import type { AgentTurnSurface } from "@/chat/task-execution/checkpoint";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { PiMessage } from "@/chat/pi/messages";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Destination, Source } from "@sentry/junior-plugin-api";
import { logException, setTags, withLogContext } from "@/chat/logging";
import {
  processPluginTask,
  scheduleSessionCompletedPluginTasks,
} from "@/chat/plugins/task-runner";
import type { ToolExecutionReport } from "@/chat/tool-support/tool-execution-report";
import {
  stripRuntimeTurnContext,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { startActiveTurn, markTurnFailed } from "@/chat/runtime/turn";
import { finalizeFailedTurnReplyWithEvent } from "@/chat/services/turn-failure-response";
import { saveTurnCheckpoint } from "@/chat/task-execution/checkpoint";
import {
  buildConversationContext,
  markConversationMessage,
  normalizeConversationText,
  recordDeliveredAssistantMessage,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import {
  commitAcceptedReply,
  loadProjection,
} from "@/chat/conversations/projection";
import { credentialContextForActor } from "@/chat/credentials/context";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import {
  ConversationTurnLifecycleService,
  type ConversationTurnLifecycle,
} from "@/chat/conversations/turn-lifecycle";
import type { ConversationTurnFailureCode } from "@/chat/conversations/history";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { persistWithRetry } from "@/chat/services/persist-retry";
import { completeAuthPauseTurn } from "@/chat/runtime/auth-pause-state";
import { recordAuthorizationCompleted } from "@/chat/conversations/projection";
import {
  authorizationId,
  type OAuthAuthorization,
} from "@/chat/oauth-authorization";
import type { SandboxEgressSignalTransport } from "@/chat/sandbox/egress/signals";

const SENTRY_EVENT_ID_PATTERN = /^[a-f0-9]{32}$/i;

function failureEventName(
  prefix: string,
  failureCode: ConversationTurnFailureCode,
): string {
  switch (failureCode) {
    case "agent_run_failed":
      return `${prefix}.agent_run.failed`;
    case "delivery_failed":
      return `${prefix}.reply.acceptance.failed`;
    case "model_execution_failed":
      return `${prefix}.model.execution.failed`;
    case "persistence_failed":
      return `${prefix}.turn.persistence.failed`;
  }
}

export interface ConversationOnlyTurnInput {
  actor: UserActor;
  conversationId: string;
  destination: Destination;
  message: string;
  source: Source;
  surface: AgentTurnSurface;
}

export interface ConversationOnlyReply {
  text: string;
}

export interface ConversationOnlyToolInvocation {
  params: Record<string, unknown>;
  toolName: string;
}

export type ConversationOnlyToolResult = ToolExecutionReport;

export interface ConversationOnlyTurnDeps {
  agentRunner: AgentRunner;
  /** Complete OAuth callback lifecycle; omit to disable interactive auth. */
  authorization?: OAuthAuthorization & {
    cancel: () => void;
    wait: () => Promise<void>;
  };
  /** Post-acceptance checkpoint write. */
  saveTurnCheckpoint?: typeof saveTurnCheckpoint;
  /** Adapter-owned telemetry event prefix. */
  eventNamePrefix?: string;
  /** Adapter-owned run identity. */
  createRunId?: () => string;
  /** Adapter-owned turn identity. */
  createTurnId?: () => string;
  /** Observe one reply after conversation-only acceptance. */
  acceptReply?: (reply: ConversationOnlyReply) => Promise<void>;
  sandboxEgressSignals?: SandboxEgressSignalTransport;
  /** Pre-agent durable Pi projection boundary. */
  loadPiMessages?: typeof loadConversationOnlyPiMessages;
  /** Injectable failure capture boundary for deterministic runtime integration tests. */
  logException?: typeof logException;
  /** Canonical lifecycle writer; defaults to the production SQL service. */
  turnLifecycle?: ConversationTurnLifecycle;
  now?: () => number;
  onStatus?: (status: string) => void | Promise<void>;
  onToolInvocation?: (
    invocation: ConversationOnlyToolInvocation,
  ) => void | Promise<void>;
  onToolResult?: (result: ConversationOnlyToolResult) => void | Promise<void>;
}

export interface ConversationOnlyTurnResult {
  conversationId: string;
  outcome: AgentRunResult["diagnostics"]["outcome"];
}

function conversationOnlyTurnId(): string {
  return `conversation-turn-${randomUUID()}`;
}

function conversationOnlyRunId(): string {
  return `conversation-run-${randomUUID()}`;
}

function captureConversationOnlyBoundaryFailure(args: {
  capture: typeof logException;
  conversationId: string;
  error: unknown;
  failureCode: ConversationTurnFailureCode;
  eventNamePrefix: string;
  runId?: string;
}): string | undefined {
  setTags({
    conversationId: args.conversationId,
    ...(args.runId ? { runId: args.runId } : {}),
  });
  const eventId = args.capture(
    args.error,
    failureEventName(args.eventNamePrefix, args.failureCode),
    { "app.ai.failure_code": args.failureCode },
  );
  return eventId && SENTRY_EVENT_ID_PATTERN.test(eventId) ? eventId : undefined;
}

/** Load durable Pi history from the conversation-event projection. */
async function loadConversationOnlyPiMessages(args: {
  conversationId: string;
}): Promise<PiMessage[] | undefined> {
  const projection = await loadProjection({
    conversationId: args.conversationId,
  });
  if (projection.length === 0) {
    return undefined;
  }
  return stripRuntimeTurnContext(trimTrailingAssistantMessages(projection));
}

/** Run one message without publishing assistant output to its Destination. */
export async function runConversationOnlyTurn(
  input: ConversationOnlyTurnInput,
  deps: ConversationOnlyTurnDeps,
): Promise<ConversationOnlyTurnResult> {
  return withLogContext(
    {
      conversationId: input.conversationId,
      destinationName:
        input.destination.platform === "slack"
          ? input.destination.channelId
          : input.destination.conversationId,
      messageConversationId: input.conversationId,
      platform: input.source.platform,
      userId: input.actor.userId,
      userName: input.actor.userName,
    },
    () => runConversationOnlyTurnInContext(input, deps),
  );
}

async function runConversationOnlyTurnInContext(
  input: ConversationOnlyTurnInput,
  deps: ConversationOnlyTurnDeps,
): Promise<ConversationOnlyTurnResult> {
  const text = input.message.trim();
  if (!text) {
    throw new Error("Conversation message must not be empty");
  }
  const { actor, destination, source, surface } = input;
  const eventNamePrefix = deps.eventNamePrefix ?? "conversation_only";
  const lifecycle =
    deps.turnLifecycle ??
    new ConversationTurnLifecycleService(getConversationEventStore());

  const now = deps.now ?? (() => Date.now());
  // Match turn-cursor activity mapping: local destinations stay `local`, and a
  // non-local destination uses the turn surface. Do not invent Slack-or-local.
  const activitySource =
    destination.platform === "local" ? "local" : surface;
  await getConversationStore().recordActivity({
    conversationId: input.conversationId,
    destination,
    nowMs: now(),
    source: activitySource,
    sessionSource: source,
  });
  const persisted = await getPersistedThreadState(input.conversationId);
  const conversation = coerceThreadConversationState(persisted);
  await hydrateConversationMessages({
    conversation,
    conversationId: input.conversationId,
  });
  let sandboxRef = getPersistedSandboxState(persisted);
  const initialSandboxRef = sandboxRef;

  const turnId = deps.createTurnId?.() ?? conversationOnlyTurnId();
  const userMessageId = `${turnId}:user`;
  const startedAtMs = now();
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
  // The source message is durable before execution begins or an active turn is
  // advertised. A caller may safely retry lifecycle start by its stable key.
  await persistConversationMessages({
    conversation,
    conversationId: input.conversationId,
  });
  await lifecycle.start({
    conversationId: input.conversationId,
    createdAtMs: now(),
    inputMessageIds: [userMessageId],
    surface,
    turnId,
  });
  startActiveTurn({
    conversation,
    nextTurnId: turnId,
  });

  let reply: AgentRunResult | undefined;
  let completedState: ReturnType<typeof buildDeliveredTurnStatePatch>;
  let failureCode: ConversationTurnFailureCode = "persistence_failed";
  let modelFailureEventId: string | undefined;
  let modelFailureCaptureAttempted = false;
  let currentRunId: string | undefined;
  let completionSliceId = 1;
  let assistantMessageDelivered = false;
  /** Accept and record one completed assistant message in conversation order. */
  const deliverAssistantMessage = async (
    reply: AssistantMessage | string,
  ): Promise<void> => {
    const message = typeof reply === "string" ? undefined : reply;
    const text =
      typeof reply === "string" ? reply : getAssistantReplyText(reply);
    if (!text?.trim()) {
      return;
    }
    failureCode = "delivery_failed";
    await deps.acceptReply?.({ text });
    assistantMessageDelivered = true;
    const recordedMessageId = recordDeliveredAssistantMessage({
      conversation,
      sessionId: turnId,
      text,
      userMessageId,
    });
    try {
      await persistWithRetry(() =>
        message
          ? commitAcceptedReply({
              agentMessage: message,
              conversation,
              conversationMessageId: recordedMessageId,
              conversationId: input.conversationId,
            })
          : persistConversationMessages({
              conversation,
              conversationId: input.conversationId,
            }),
      );
    } catch (error) {
      logException(
        new Error("Accepted assistant message persistence failed"),
        `${eventNamePrefix}.assistant.message_post_acceptance_persist.failed`,
        { "error.type": error instanceof Error ? error.name : typeof error },
      );
    }
    failureCode = "agent_run_failed";
  };
  try {
    await persistThreadStateById(input.conversationId, { conversation });
    const piMessages = await (
      deps.loadPiMessages ?? loadConversationOnlyPiMessages
    )({
      conversationId: input.conversationId,
    });
    failureCode = "agent_run_failed";
    const runAgent = async (messages: PiMessage[] | undefined) => {
      currentRunId = deps.createRunId?.() ?? conversationOnlyRunId();
      setTags({ runId: currentRunId });
      const authorization = deps.authorization
        ? {
            createState: deps.authorization.createState,
            deliver: deps.authorization.deliver,
          }
        : undefined;
      return await deps.agentRunner.run({
        conversationId: input.conversationId,
        turnId,
        runId: currentRunId,
        input: {
          messageText: text,
          conversationContext: buildConversationContext(conversation, {
            excludeMessageId: userMessageId,
          }),
          piMessages: messages,
        },
        routing: {
          actor: actor,
          credentialContext: credentialContextForActor(actor),
          destination,
          publishExternally: false,
          source,
          surface,
        },
        authorization,
        policy: {
          ...(deps.authorization
            ? {}
            : { disabledFeatures: ["interactive-auth"] as const }),
          sandboxEgressSignals: deps.sandboxEgressSignals,
        },
        state: {
          pendingAuth: conversation.processing.pendingAuth,
          sandboxRef,
        },
        observers: {
          onStatus: async (status) => {
            await deps.onStatus?.(status.text);
          },
          onToolInvocation: async (invocation) => {
            await deps.onToolInvocation?.(invocation);
          },
          onToolResult: async (result) => {
            await deps.onToolResult?.(result);
          },
        },
        delivery: deliverAssistantMessage,
        durability: {
          onSandboxRefChanged: async (nextSandboxRef) => {
            sandboxRef = nextSandboxRef;
            await persistThreadStateById(input.conversationId, {
              conversation,
              sandboxRef,
            });
          },
          recordPendingAuth: async (pendingAuth) => {
            conversation.processing.pendingAuth = pendingAuth;
            await persistThreadStateById(input.conversationId, {
              conversation,
              sandboxRef,
            });
          },
        },
      });
    };

    let outcome = await runAgent(piMessages);
    while (outcome.status === "awaiting_auth") {
      const pendingAuth = conversation.processing.pendingAuth;
      if (!pendingAuth || !deps.authorization) {
        throw new Error(
          "Conversation authorization requires an active callback and delivery adapter.",
        );
      }
      completeAuthPauseTurn({ conversation, sessionId: turnId });
      await persistThreadStateById(input.conversationId, {
        conversation,
        sandboxRef,
      });
      await deps.authorization.wait();
      await recordAuthorizationCompleted({
        conversationId: input.conversationId,
        kind: pendingAuth.kind,
        provider: pendingAuth.provider,
        actorId: pendingAuth.actorId,
        authorizationId: authorizationId({
          sessionId: turnId,
          kind: pendingAuth.kind,
          provider: pendingAuth.provider,
        }),
      });
      // Resuming after authorization starts the next durable session slice.
      completionSliceId += 1;
      outcome = await runAgent(
        await (deps.loadPiMessages ?? loadConversationOnlyPiMessages)({
          conversationId: input.conversationId,
        }),
      );
    }
    if (outcome.status !== "completed") {
      throw new Error(
        `Conversation-only agent run ended with ${outcome.status}`,
      );
    }
    reply = outcome.result;

    // Failed turns deliver the sanitized fallback (or genuine partial model
    // text), never raw exception strings and never silence.
    modelFailureCaptureAttempted = reply.diagnostics.outcome !== "success";
    const finalized = finalizeFailedTurnReplyWithEvent({
      reply,
      logException: deps.logException ?? logException,
    });
    reply = finalized.reply;
    modelFailureEventId = finalized.eventId;

    if (reply.diagnostics.outcome !== "success") {
      await deliverAssistantMessage(reply.text);
    }

    completedState = buildDeliveredTurnStatePatch({
      conversation,
      reply,
      sessionId: turnId,
      userMessageId,
    });
  } catch (error) {
    deps.authorization?.cancel();
    const failureEventId =
      modelFailureCaptureAttempted && failureCode === "agent_run_failed"
        ? modelFailureEventId
        : captureConversationOnlyBoundaryFailure({
            capture: deps.logException ?? logException,
            conversationId: input.conversationId,
            error,
            failureCode,
            runId: currentRunId,
            eventNamePrefix,
          });
    try {
      markTurnFailed({
        conversation,
        nowMs: now(),
        sessionId: turnId,
        userMessageId,
        markConversationMessage,
      });
      await persistThreadStateById(input.conversationId, {
        conversation,
        sandboxRef: initialSandboxRef ?? null,
      });
    } catch (persistenceError) {
      const persistenceEventId = captureConversationOnlyBoundaryFailure({
        capture: deps.logException ?? logException,
        conversationId: input.conversationId,
        error: persistenceError,
        failureCode: "persistence_failed",
        runId: currentRunId,
        eventNamePrefix,
      });
      await lifecycle.fail({
        conversationId: input.conversationId,
        createdAtMs: now(),
        ...(persistenceEventId ? { eventId: persistenceEventId } : {}),
        failureCode: "persistence_failed",
        turnId,
      });
      throw new AggregateError(
        [error, persistenceError],
        "Conversation-only turn failure state could not be persisted",
      );
    }
    await lifecycle.fail({
      conversationId: input.conversationId,
      createdAtMs: now(),
      ...(failureEventId ? { eventId: failureEventId } : {}),
      failureCode,
      turnId,
    });
    throw error;
  }

  deps.authorization?.cancel();
  try {
    await persistThreadStateById(input.conversationId, {
      conversation: completedState.conversation,
      sandboxRef: reply.sandboxRef ?? sandboxRef,
    });
    if (reply.piMessages?.length) {
      // Conversation acceptance is the completion boundary. This first commits
      // final assistant messages to the event log, then marks the turn complete.
      await (deps.saveTurnCheckpoint ?? saveTurnCheckpoint)({
        mode: "completed",
        conversationId: input.conversationId,
        turnId,
        sliceId: completionSliceId,
        messages: reply.piMessages,
        durationMs: reply.diagnostics.durationMs,
        usage: reply.diagnostics.usage,
        destination,
        // Durable record must match live routing: conversation log only.
        publishExternally: false,
        source,
        actor: actor,
        surface,
      });
    }
  } catch (error) {
    const persistenceEventId = captureConversationOnlyBoundaryFailure({
      capture: deps.logException ?? logException,
      conversationId: input.conversationId,
      error,
      failureCode: "persistence_failed",
      runId: currentRunId,
      eventNamePrefix,
    });
    await lifecycle.fail({
      conversationId: input.conversationId,
      createdAtMs: now(),
      ...(persistenceEventId ? { eventId: persistenceEventId } : {}),
      failureCode: "persistence_failed",
      turnId,
    });
    throw error;
  }

  if (reply.diagnostics.outcome === "success") {
    await lifecycle.complete({
      conversationId: input.conversationId,
      createdAtMs: now(),
      outcome: assistantMessageDelivered ? "success" : "no_reply",
      turnId,
    });
  } else {
    await lifecycle.fail({
      conversationId: input.conversationId,
      createdAtMs: now(),
      ...(modelFailureEventId ? { eventId: modelFailureEventId } : {}),
      failureCode: "model_execution_failed",
      turnId,
    });
  }
  if (reply.diagnostics.outcome === "success") {
    try {
      await scheduleSessionCompletedPluginTasks(
        {
          conversationId: input.conversationId,
          sessionId: turnId,
        },
        {
          send: async (message) => {
            try {
              await processPluginTask(message);
            } catch (error) {
              logException(
                error,
                `${eventNamePrefix}.plugin.session_completion_task.failed`,
                {
                  conversationId: input.conversationId,
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
      logException(
        error,
        `${eventNamePrefix}.plugin.session_completion_task.failed`,
        {
          conversationId: input.conversationId,
          turnId,
        },
      );
    }
  }

  return {
    conversationId: input.conversationId,
    outcome: reply.diagnostics.outcome,
  };
}
