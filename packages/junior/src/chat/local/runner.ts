/**
 * Local agent turn runtime.
 *
 * This module owns the Slack-free execution boundary for CLI-originated turns:
 * it persists local conversation state, invokes the shared agent runner with
 * a local destination, and only commits assistant delivery after the CLI sink
 * accepts each completed tool-free assistant message.
 */
import type { AgentRunResult } from "@/chat/services/turn-result";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { randomUUID } from "node:crypto";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { PiMessage } from "@/chat/pi/messages";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createLocalSource,
  localDestinationSchema,
  type LocalDestination,
} from "@sentry/junior-plugin-api";
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
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
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

const LOCAL_FAILURE_EVENT_NAMES: Record<ConversationTurnFailureCode, string> = {
  agent_run_failed: "local.agent_run.failed",
  delivery_failed: "local.reply.delivery.failed",
  model_execution_failed: "local.model.execution.failed",
  persistence_failed: "local.turn.persistence.failed",
};

export interface LocalAgentTurnInput {
  conversationId: string;
  message: string;
}

export interface LocalAgentReply {
  text: string;
}

export interface LocalToolInvocation {
  params: Record<string, unknown>;
  toolName: string;
}

export type LocalToolResult = ToolExecutionReport;

export interface LocalAgentTurnDeps {
  agentRunner: AgentRunner;
  /** Complete local OAuth callback lifecycle; omit to disable interactive auth. */
  authorization?: OAuthAuthorization & {
    cancel: () => void;
    wait: () => Promise<void>;
  };
  /** Post-delivery checkpoint write. */
  saveTurnCheckpoint?: typeof saveTurnCheckpoint;
  deliverReply: (reply: LocalAgentReply) => Promise<void>;
  sandboxEgressSignals?: SandboxEgressSignalTransport;
  /** Pre-agent durable Pi projection boundary. */
  loadPiMessages?: typeof loadLocalPiMessages;
  /** Injectable failure capture boundary for deterministic runtime integration tests. */
  logException?: typeof logException;
  /** Canonical lifecycle writer; defaults to the production SQL service. */
  turnLifecycle?: ConversationTurnLifecycle;
  now?: () => number;
  onStatus?: (status: string) => void | Promise<void>;
  onToolInvocation?: (invocation: LocalToolInvocation) => void | Promise<void>;
  onToolResult?: (result: LocalToolResult) => void | Promise<void>;
}

export interface LocalAgentTurnResult {
  conversationId: string;
  outcome: AgentRunResult["diagnostics"]["outcome"];
}

function localDestination(conversationId: string): LocalDestination {
  const parsed = localDestinationSchema.safeParse({
    platform: "local",
    conversationId,
  });
  if (!parsed.success) {
    throw new Error("Invalid local conversation id");
  }
  return parsed.data;
}

function localTurnId(): string {
  return `local-turn-${randomUUID()}`;
}

function localRunId(): string {
  return `local-run-${randomUUID()}`;
}

function captureLocalBoundaryFailure(args: {
  capture: typeof logException;
  conversationId: string;
  error: unknown;
  failureCode: ConversationTurnFailureCode;
  runId?: string;
}): string | undefined {
  setTags({
    conversationId: args.conversationId,
    ...(args.runId ? { runId: args.runId } : {}),
  });
  const eventId = args.capture(
    args.error,
    LOCAL_FAILURE_EVENT_NAMES[args.failureCode],
    { "app.ai.failure_code": args.failureCode },
  );
  return eventId && SENTRY_EVENT_ID_PATTERN.test(eventId) ? eventId : undefined;
}

/** Load durable local Pi history from the conversation-event projection. */
async function loadLocalPiMessages(args: {
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

/** Run one local CLI message through Junior's shared agent-run boundary. */
export async function runLocalAgentTurn(
  input: LocalAgentTurnInput,
  deps: LocalAgentTurnDeps,
): Promise<LocalAgentTurnResult> {
  return withLogContext(
    {
      conversationId: input.conversationId,
      destinationName: input.conversationId,
      messageConversationId: input.conversationId,
      platform: "local",
      userId: "local-cli",
      userName: "local",
    },
    () => runLocalAgentTurnInContext(input, deps),
  );
}

async function runLocalAgentTurnInContext(
  input: LocalAgentTurnInput,
  deps: LocalAgentTurnDeps,
): Promise<LocalAgentTurnResult> {
  const text = input.message.trim();
  if (!text) {
    throw new Error("Local agent message must not be empty");
  }
  if (!deps.deliverReply) {
    throw new Error("Local reply delivery is required");
  }
  const destination = localDestination(input.conversationId);
  const source = createLocalSource(destination.conversationId);
  const lifecycle =
    deps.turnLifecycle ??
    new ConversationTurnLifecycleService(getConversationEventStore());

  const now = deps.now ?? (() => Date.now());
  await getConversationStore().recordActivity({
    conversationId: input.conversationId,
    destination,
    nowMs: now(),
    source: "local",
  });
  const persisted = await getPersistedThreadState(input.conversationId);
  const conversation = coerceThreadConversationState(persisted);
  await hydrateConversationMessages({
    conversation,
    conversationId: input.conversationId,
  });
  let artifacts = coerceThreadArtifactsState(persisted);
  let sandboxRef = getPersistedSandboxState(persisted);
  const initialArtifacts = artifacts;
  const initialSandboxRef = sandboxRef;

  const turnId = localTurnId();
  const userMessageId = `${turnId}:user`;
  const startedAtMs = now();
  upsertConversationMessage(conversation, {
    id: userMessageId,
    role: "user",
    text: normalizeConversationText(text),
    createdAtMs: startedAtMs,
    author: {
      fullName: "Local CLI",
      userId: "local-cli",
      userName: "local",
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
    surface: "internal",
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
  const localActor = {
    fullName: "Local CLI",
    platform: "local" as const,
    userId: "local-cli",
    userName: "local",
  };
  let assistantMessageDelivered = false;
  /** Print and record one completed assistant message in local conversation order. */
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
    await deps.deliverReply({ text });
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
        "local.assistant.message_post_delivery_persist.failed",
        { "error.type": error instanceof Error ? error.name : typeof error },
      );
    }
    failureCode = "agent_run_failed";
  };
  try {
    await persistThreadStateById(input.conversationId, { conversation });
    const piMessages = await (deps.loadPiMessages ?? loadLocalPiMessages)({
      conversationId: input.conversationId,
    });
    failureCode = "agent_run_failed";
    const runAgent = async (messages: PiMessage[] | undefined) => {
      currentRunId = localRunId();
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
          actor: localActor,
          credentialContext: credentialContextForActor(localActor),
          destination,
          source,
          surface: "internal",
        },
        authorization,
        policy: {
          ...(deps.authorization
            ? {}
            : { disabledFeatures: ["interactive-auth"] as const }),
          sandboxEgressSignals: deps.sandboxEgressSignals,
        },
        state: {
          artifactState: artifacts,
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
          onArtifactStateUpdated: async (nextArtifacts) => {
            artifacts = nextArtifacts;
            await persistThreadStateById(input.conversationId, {
              artifacts,
              conversation,
              sandboxRef,
            });
          },
          onSandboxRefChanged: async (nextSandboxRef) => {
            sandboxRef = nextSandboxRef;
            await persistThreadStateById(input.conversationId, {
              artifacts,
              conversation,
              sandboxRef,
            });
          },
          recordPendingAuth: async (pendingAuth) => {
            conversation.processing.pendingAuth = pendingAuth;
            await persistThreadStateById(input.conversationId, {
              artifacts,
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
          "Local OAuth requires an active callback server and authorization delivery.",
        );
      }
      completeAuthPauseTurn({ conversation, sessionId: turnId });
      await persistThreadStateById(input.conversationId, {
        artifacts,
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
        await (deps.loadPiMessages ?? loadLocalPiMessages)({
          conversationId: input.conversationId,
        }),
      );
    }
    if (outcome.status !== "completed") {
      throw new Error(`Local agent run ended with ${outcome.status}`);
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
      artifacts,
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
        : captureLocalBoundaryFailure({
            capture: deps.logException ?? logException,
            conversationId: input.conversationId,
            error,
            failureCode,
            runId: currentRunId,
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
        artifacts: initialArtifacts,
        conversation,
        sandboxRef: initialSandboxRef ?? null,
      });
    } catch (persistenceError) {
      const persistenceEventId = captureLocalBoundaryFailure({
        capture: deps.logException ?? logException,
        conversationId: input.conversationId,
        error: persistenceError,
        failureCode: "persistence_failed",
        runId: currentRunId,
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
        "Local turn failure state could not be persisted",
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
      artifacts: completedState.artifacts ?? artifacts,
      conversation: completedState.conversation,
      sandboxRef: reply.sandboxRef ?? sandboxRef,
    });
    if (reply.piMessages?.length) {
      // Destination acceptance is the completion boundary: this first commits
      // the final assistant messages to the event log and marks the session
      // record completed only after the CLI sink accepted the reply.
      await (deps.saveTurnCheckpoint ?? saveTurnCheckpoint)({
        mode: "completed",
        conversationId: input.conversationId,
        turnId,
        sliceId: completionSliceId,
        messages: reply.piMessages,
        modelId: reply.diagnostics.modelId,
        durationMs: reply.diagnostics.durationMs,
        usage: reply.diagnostics.usage,
        reasoningLevel: reply.diagnostics.reasoningLevel,
        destination,
        source,
        actor: localActor,
        surface: "internal",
      });
    }
  } catch (error) {
    const persistenceEventId = captureLocalBoundaryFailure({
      capture: deps.logException ?? logException,
      conversationId: input.conversationId,
      error,
      failureCode: "persistence_failed",
      runId: currentRunId,
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
                "local.plugin.session_completion_task.failed",
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
      logException(error, "local.plugin.session_completion_task.failed", {
        conversationId: input.conversationId,
        turnId,
      });
    }
  }

  return {
    conversationId: input.conversationId,
    outcome: reply.diagnostics.outcome,
  };
}
