/**
 * Local agent turn runtime.
 *
 * This module owns the Slack-free execution boundary for CLI-originated turns:
 * it persists local conversation state, invokes the shared agent runner with
 * a local destination, and only commits assistant delivery after the CLI sink
 * accepts the final output.
 */
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
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
import type { ToolExecutionReport } from "@/chat/tools/agent-tools";
import { THREAD_STATE_TTL_MS } from "chat";
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
import { finalizeFailedTurnReply } from "@/chat/services/turn-failure-response";
import { completeDeliveredTurn } from "@/chat/services/turn-session-record";
import {
  buildConversationContext,
  markConversationMessage,
  normalizeConversationText,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { commitMessages, loadProjection } from "@/chat/state/session-log";

const DELIVERED_STATE_PERSIST_ATTEMPTS = 3;

export interface LocalAgentTurnInput {
  conversationId: string;
  message: string;
}

export interface LocalAgentReply {
  files?: AgentRunResult["files"];
  text: string;
}

export interface LocalToolInvocation {
  params: Record<string, unknown>;
  toolName: string;
}

export type LocalToolResult = ToolExecutionReport;

export interface LocalAgentTurnDeps {
  agentRunner: AgentRunner;
  deliverReply: (reply: LocalAgentReply) => Promise<void>;
  now?: () => number;
  onStatus?: (status: string) => void | Promise<void>;
  onTextDelta?: (deltaText: string) => void | Promise<void>;
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

function localTurnId(sequence: number): string {
  return `local-turn-${sequence}`;
}

function localReply(reply: AgentRunResult): LocalAgentReply {
  return {
    ...(reply.files ? { files: reply.files } : {}),
    text: reply.text,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextUserMessageSequence(
  conversation: ReturnType<typeof coerceThreadConversationState>,
): number {
  return (
    conversation.messages.filter((message) => message.role === "user").length +
    1
  );
}

function preparedLocalPiMessages(
  messages: ReturnType<typeof coerceThreadConversationState>["piMessages"],
) {
  return stripRuntimeTurnContext(trimTrailingAssistantMessages(messages));
}

/** Load the newest local Pi state, falling back from stale projection data. */
async function loadLocalPiMessages(args: {
  conversationId: string;
  fallback: ReturnType<typeof coerceThreadConversationState>["piMessages"];
}) {
  const projection = await loadProjection({
    conversationId: args.conversationId,
  });
  if (args.fallback.length >= projection.length && args.fallback.length > 0) {
    return preparedLocalPiMessages(args.fallback);
  }
  if (projection.length > 0) {
    return preparedLocalPiMessages(projection);
  }

  return undefined;
}

/** Persist the post-delivery completion state, retrying transient state writes. */
async function persistDeliveredLocalTurnState(
  conversationId: string,
  patch: Parameters<typeof persistThreadStateById>[1],
): Promise<void> {
  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= DELIVERED_STATE_PERSIST_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await persistThreadStateById(conversationId, patch);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < DELIVERED_STATE_PERSIST_ATTEMPTS) {
        await sleep(attempt * 100);
      }
    }
  }
  throw lastError;
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

  const now = deps.now ?? (() => Date.now());
  const persisted = await getPersistedThreadState(input.conversationId);
  const conversation = coerceThreadConversationState(persisted);
  let artifacts = coerceThreadArtifactsState(persisted);
  let { sandboxId, sandboxDependencyProfileHash } =
    getPersistedSandboxState(persisted);
  const initialArtifacts = artifacts;
  const initialSandboxId = sandboxId;
  const initialSandboxDependencyProfileHash = sandboxDependencyProfileHash;

  const sequence = nextUserMessageSequence(conversation);
  const turnId = localTurnId(sequence);
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
  startActiveTurn({
    conversation,
    nextTurnId: turnId,
    updateConversationStats,
  });
  await persistThreadStateById(input.conversationId, { conversation });

  let reply: AgentRunResult | undefined;
  let completedState: ReturnType<typeof buildDeliveredTurnStatePatch>;
  let piMessagesBeforeRun:
    | Awaited<ReturnType<typeof loadLocalPiMessages>>
    | undefined;
  try {
    const piMessages = await loadLocalPiMessages({
      conversationId: input.conversationId,
      fallback: conversation.piMessages,
    });
    piMessagesBeforeRun = piMessages;
    const outcome = await deps.agentRunner.run({
      input: {
        messageText: text,
        conversationContext: buildConversationContext(conversation, {
          excludeMessageId: userMessageId,
        }),
        piMessages,
      },
      routing: {
        credentialContext: {
          actor: { type: "system", id: "local-cli" },
        },
        destination,
        source,
        requester: {
          fullName: "Local CLI",
          platform: "local",
          userId: "local-cli",
          userName: "local",
        },
        surface: "internal",
        correlation: {
          conversationId: input.conversationId,
          turnId,
          runId: turnId,
        },
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
        onTextDelta: deps.onTextDelta,
        onToolInvocation: async (invocation) => {
          await deps.onToolInvocation?.(invocation);
        },
        onToolResult: async (result) => {
          await deps.onToolResult?.(result);
        },
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
    reply = finalizeFailedTurnReply({
      reply,
      logException,
      context: { conversationId: input.conversationId },
    });

    completedState = buildDeliveredTurnStatePatch({
      artifacts,
      conversation,
      reply,
      sessionId: turnId,
      userMessageId,
    });
    await deps.deliverReply(localReply(reply));
  } catch (error) {
    if (reply) {
      await commitMessages({
        conversationId: input.conversationId,
        messages: piMessagesBeforeRun ?? [],
        ttlMs: THREAD_STATE_TTL_MS,
      });
    }
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
    throw error;
  }

  await persistDeliveredLocalTurnState(input.conversationId, {
    artifacts: completedState.artifacts ?? artifacts,
    conversation: reply.piMessages
      ? {
          ...completedState.conversation,
          piMessages: reply.piMessages,
        }
      : completedState.conversation,
    sandboxId: reply.sandboxId ?? sandboxId,
    sandboxDependencyProfileHash:
      reply.sandboxDependencyProfileHash ?? sandboxDependencyProfileHash,
  });
  if (reply.piMessages?.length) {
    // Destination acceptance is the completion boundary: this first commits
    // the final assistant messages to the session log and marks the session
    // record completed only after the CLI sink accepted the reply. Failures
    // are logged inside and never fail the delivered turn.
    await completeDeliveredTurn({
      conversationId: input.conversationId,
      sessionId: turnId,
      sliceId: 1,
      messages: reply.piMessages,
      durationMs: reply.diagnostics.durationMs,
      usage: reply.diagnostics.usage,
      destination,
      source,
      surface: "internal",
      logContext: { modelId: reply.diagnostics.modelId },
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
