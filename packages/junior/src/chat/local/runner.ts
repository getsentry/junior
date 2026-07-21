/**
 * Local agent turn runtime.
 *
 * This module owns the Slack-free execution boundary for CLI-originated turns:
 * it persists local conversation state, invokes the shared agent runner with
 * a local destination, and only commits assistant delivery after the CLI sink
 * accepts each completed assistant message.
 */
import type { AgentRunResult } from "@/chat/services/turn-result";
import { randomUUID } from "node:crypto";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { PiMessage } from "@/chat/pi/messages";
import {
  createLocalSource,
  localDestinationSchema,
  type LocalDestination,
} from "@sentry/junior-plugin-api";
import { logException } from "@/chat/logging";
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
import { completeDeliveredTurn } from "@/chat/services/turn-session-record";
import {
  buildConversationContext,
  markConversationMessage,
  normalizeConversationText,
  recordDeliveredAssistantMessage,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import { loadProjection } from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import {
  ConversationTurnLifecycleService,
  type ConversationTurnLifecycle,
} from "@/chat/conversations/turn-lifecycle";
import type { ConversationTurnFailureCode } from "@/chat/conversations/history";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { persistWithRetry } from "@/chat/services/persist-retry";

const SENTRY_EVENT_ID_PATTERN = /^[a-f0-9]{32}$/i;

const LOCAL_FAILURE_EVENT_NAMES: Record<ConversationTurnFailureCode, string> = {
  agent_run_failed: "local_agent_run_failed",
  delivery_failed: "local_reply_delivery_failed",
  model_execution_failed: "local_model_execution_failed",
  persistence_failed: "local_turn_persistence_failed",
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
  /** Post-delivery Pi/session persistence boundary. */
  completeDeliveredTurn?: typeof completeDeliveredTurn;
  deliverReply: (reply: LocalAgentReply) => Promise<void>;
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

function captureLocalBoundaryFailure(args: {
  capture: typeof logException;
  conversationId: string;
  error: unknown;
  failureCode: ConversationTurnFailureCode;
  turnId: string;
}): string | undefined {
  const eventId = args.capture(
    args.error,
    LOCAL_FAILURE_EVENT_NAMES[args.failureCode],
    { conversationId: args.conversationId, runId: args.turnId },
    { "app.ai.failure_code": args.failureCode },
    "Local agent turn failed at its owning runtime boundary",
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
  const persisted = await getPersistedThreadState(input.conversationId);
  const conversation = coerceThreadConversationState(persisted);
  await hydrateConversationMessages({
    conversation,
    conversationId: input.conversationId,
  });
  let artifacts = coerceThreadArtifactsState(persisted);
  let { sandboxId, sandboxDependencyProfileHash } =
    getPersistedSandboxState(persisted);
  const initialArtifacts = artifacts;
  const initialSandboxId = sandboxId;
  const initialSandboxDependencyProfileHash = sandboxDependencyProfileHash;

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
    updateConversationStats,
  });

  let reply: AgentRunResult | undefined;
  let completedState: ReturnType<typeof buildDeliveredTurnStatePatch>;
  let failureCode: ConversationTurnFailureCode = "persistence_failed";
  let modelFailureEventId: string | undefined;
  let modelFailureCaptureAttempted = false;
  const localActor = {
    fullName: "Local CLI",
    platform: "local" as const,
    userId: "local-cli",
    userName: "local",
  };
  let assistantMessageDelivered = false;
  /** Print and record one completed assistant message in local conversation order. */
  const deliverAssistantMessage = async (message: {
    text: string;
  }): Promise<void> => {
    if (!message.text.trim()) {
      return;
    }
    failureCode = "delivery_failed";
    await deps.deliverReply({ text: message.text });
    assistantMessageDelivered = true;
    recordDeliveredAssistantMessage({
      conversation,
      sessionId: turnId,
      text: message.text,
      userMessageId,
    });
    try {
      await persistWithRetry(() =>
        persistConversationMessages({
          conversation,
          conversationId: input.conversationId,
        }),
      );
    } catch (error) {
      logException(
        new Error("Accepted assistant message persistence failed"),
        "local_assistant_message_post_delivery_persist_failed",
        { conversationId: input.conversationId },
        { "error.type": error instanceof Error ? error.name : typeof error },
        "Failed to persist an accepted local assistant message",
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
    const outcome = await deps.agentRunner.run({
      conversationId: input.conversationId,
      turnId,
      runId: turnId,
      input: {
        messageText: text,
        conversationContext: buildConversationContext(conversation, {
          excludeMessageId: userMessageId,
        }),
        piMessages,
      },
      routing: {
        credentialContext: {
          actor: { platform: "system", name: "local-cli" },
        },
        destination,
        source,
        actor: localActor,
        surface: "internal",
      },
      policy: {
        authorizationFlowMode: "disabled",
      },
      state: {
        artifactState: artifacts,
        sandbox: {
          sandboxId,
          sandboxDependencyProfileHash,
        },
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
      delivery: {
        onAssistantMessage: deliverAssistantMessage,
      },
      durability: {
        onArtifactStateUpdated: async (nextArtifacts) => {
          artifacts = nextArtifacts;
          await persistThreadStateById(input.conversationId, {
            artifacts,
            conversation,
            sandboxId,
            sandboxDependencyProfileHash,
          });
        },
        onSandboxAcquired: async (sandbox) => {
          sandboxId = sandbox.sandboxId;
          sandboxDependencyProfileHash = sandbox.sandboxDependencyProfileHash;
          await persistThreadStateById(input.conversationId, {
            artifacts,
            conversation,
            sandboxId,
            sandboxDependencyProfileHash,
          });
        },
      },
    });
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
      context: { conversationId: input.conversationId },
    });
    reply = finalized.reply;
    modelFailureEventId = finalized.eventId;

    if (reply.diagnostics.outcome !== "success") {
      await deliverAssistantMessage({ text: reply.text });
    }

    completedState = buildDeliveredTurnStatePatch({
      artifacts,
      conversation,
      reply,
      sessionId: turnId,
      userMessageId,
    });
  } catch (error) {
    const failureEventId =
      modelFailureCaptureAttempted && failureCode === "agent_run_failed"
        ? modelFailureEventId
        : captureLocalBoundaryFailure({
            capture: deps.logException ?? logException,
            conversationId: input.conversationId,
            error,
            failureCode,
            turnId,
          });
    try {
      markTurnFailed({
        conversation,
        nowMs: now(),
        sessionId: turnId,
        userMessageId,
        markConversationMessage,
        updateConversationStats,
      });
      await persistThreadStateById(input.conversationId, {
        artifacts: initialArtifacts,
        conversation,
        sandboxId: initialSandboxId ?? "",
        sandboxDependencyProfileHash: initialSandboxDependencyProfileHash ?? "",
      });
    } catch (persistenceError) {
      const persistenceEventId = captureLocalBoundaryFailure({
        capture: deps.logException ?? logException,
        conversationId: input.conversationId,
        error: persistenceError,
        failureCode: "persistence_failed",
        turnId,
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

  try {
    await persistThreadStateById(input.conversationId, {
      artifacts: completedState.artifacts ?? artifacts,
      conversation: completedState.conversation,
      sandboxId: reply.sandboxId ?? sandboxId,
      sandboxDependencyProfileHash:
        reply.sandboxDependencyProfileHash ?? sandboxDependencyProfileHash,
    });
    if (reply.piMessages?.length) {
      // Destination acceptance is the completion boundary: this first commits
      // the final assistant messages to the event log and marks the session
      // record completed only after the CLI sink accepted the reply.
      await (deps.completeDeliveredTurn ?? completeDeliveredTurn)({
        conversationId: input.conversationId,
        sessionId: turnId,
        sliceId: 1,
        messages: reply.piMessages,
        modelId: reply.diagnostics.modelId,
        durationMs: reply.diagnostics.durationMs,
        usage: reply.diagnostics.usage,
        reasoningLevel: reply.diagnostics.reasoningLevel,
        destination,
        source,
        actor: localActor,
        surface: "internal",
        logContext: {},
      });
    }
  } catch (error) {
    const persistenceEventId = captureLocalBoundaryFailure({
      capture: deps.logException ?? logException,
      conversationId: input.conversationId,
      error,
      failureCode: "persistence_failed",
      turnId,
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
                "local_plugin_session_completed_task_failed",
                {},
                {
                  conversationId: input.conversationId,
                  pluginName: message.plugin,
                  taskName: message.name,
                  turnId,
                },
                "Local plugin session.completed task failed after reply delivery",
              );
            }
          },
        },
      );
    } catch (error) {
      logException(
        error,
        "local_plugin_session_completed_task_failed",
        {},
        {
          conversationId: input.conversationId,
          turnId,
        },
        "Local plugin session.completed task failed after reply delivery",
      );
    }
  }

  return {
    conversationId: input.conversationId,
    outcome: reply.diagnostics.outcome,
  };
}
