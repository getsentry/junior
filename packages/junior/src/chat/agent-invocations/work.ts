import type { StateAdapter } from "chat";
import { z } from "zod";
import type { ConversationStore } from "@/chat/conversations/store";
import { openConversationProjection } from "@/chat/conversations/projection";
import { botConfig } from "@/chat/config";
import { modelIdForProfile } from "@/chat/model-profile";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore } from "@/chat/db";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import {
  failAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  getConversationTurnBoundaryError,
  isTurnInputCommitLostError,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { getTerminalAssistantMessages } from "@/chat/pi/transcript";
import type { PiMessage } from "@/chat/pi/messages";
import type { SandboxRef } from "@/chat/sandbox/ref";
import {
  appendAndEnqueueInboundMessage,
  type InboundMessage,
} from "@/chat/task-execution/store";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  completeAgentInvocation,
  createAgentInvocation,
  getActiveAgentInvocationForConversation,
  getAgentInvocation,
  getAgentInvocationMessageId,
  getAgentInvocationTurnId,
  isTerminalAgentInvocation,
  markAgentInvocationAwaitingResume,
  markAgentInvocationMailboxAppended,
  markAgentInvocationRunning,
} from "./store";
import type { AgentInvocation, CreateAgentInvocationInput } from "./types";

const agentInvocationMailboxMetadataSchema = z
  .object({
    agentInvocationId: z.string().min(1),
    kind: z.literal("agent_invocation"),
  })
  .strict();

type EnqueueOptions = {
  conversationStore?: ConversationStore;
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
};

/** Build destinationless mailbox work that references one durable invocation. */
export function buildAgentInvocationInboundMessage(
  invocation: AgentInvocation,
  nowMs = Date.now(),
): InboundMessage {
  return {
    conversationId: invocation.childConversationId,
    createdAtMs: invocation.createdAtMs,
    delivery: "defer",
    inboundMessageId: getAgentInvocationMessageId(invocation.invocationId),
    input: {
      authorId: invocation.invocationId,
      text: "[agent invocation]",
      metadata: {
        agentInvocationId: invocation.invocationId,
        kind: "agent_invocation",
      },
    },
    receivedAtMs: nowMs,
    source: "internal",
  };
}

/** Append one invocation to its child mailbox and send the normal queue wake. */
export async function enqueueAgentInvocation(
  invocation: AgentInvocation,
  options: EnqueueOptions,
): Promise<void> {
  if (invocation.mailboxStatus === "appended") {
    return;
  }
  const nowMs = options.nowMs ?? Date.now();
  await appendAndEnqueueInboundMessage({
    message: buildAgentInvocationInboundMessage(invocation, nowMs),
    conversationStore: options.conversationStore,
    nowMs,
    queue: options.queue,
    state: options.state,
  });
  await markAgentInvocationMailboxAppended(invocation.invocationId, nowMs);
}

/** Create or replay an invocation, then durably schedule its child work. */
export async function createAndEnqueueAgentInvocation(
  input: CreateAgentInvocationInput,
  options: EnqueueOptions,
): Promise<AgentInvocation> {
  const invocation = await createAgentInvocation(input, options.nowMs);
  await enqueueAgentInvocation(invocation, options);
  return (await getAgentInvocation(invocation.invocationId)) ?? invocation;
}

/** Require one invocation metadata reference for one leased mailbox attempt. */
function invocationIdFromMessages(
  messages: readonly InboundMessage[],
): string | undefined {
  if (messages.length === 0) {
    return undefined;
  }
  const parsed = messages.map((message) =>
    agentInvocationMailboxMetadataSchema.safeParse(message.input.metadata),
  );
  if (parsed.every((result) => !result.success)) {
    return undefined;
  }
  if (parsed.some((result) => !result.success)) {
    throw new Error(
      "Conversation mailbox mixes agent invocation and other input",
    );
  }
  const invocationIds = new Set(
    parsed.map((result) => {
      if (!result.success) {
        throw new Error("Agent invocation mailbox metadata failed validation");
      }
      return result.data.agentInvocationId;
    }),
  );
  if (invocationIds.size !== 1) {
    throw new Error(
      "Conversation mailbox contains multiple agent invocations in one attempt",
    );
  }
  return invocationIds.values().next().value;
}

/** Resolve invocation execution from mailbox input or durable active state. */
export async function resolveAgentInvocationId(
  context: ConversationWorkerContext,
): Promise<string | undefined> {
  const mailboxInvocationId = invocationIdFromMessages(
    context.attempt.messages,
  );
  if (mailboxInvocationId) {
    return mailboxInvocationId;
  }
  if (context.attempt.messages.length > 0) {
    return undefined;
  }
  return (await getActiveAgentInvocationForConversation(context.conversationId))
    ?.invocationId;
}

/** Project the terminal invocation into the idempotent turn lifecycle. */
async function persistTerminalLifecycle(
  invocation: AgentInvocation,
): Promise<void> {
  const lifecycle = new ConversationTurnLifecycleService(
    getConversationEventStore(),
  );
  const common = {
    conversationId: invocation.childConversationId,
    createdAtMs:
      "terminalAtMs" in invocation
        ? invocation.terminalAtMs
        : invocation.updatedAtMs,
    turnId: getAgentInvocationTurnId(invocation.invocationId),
  };
  if (invocation.status === "completed") {
    await lifecycle.complete({
      ...common,
      outcome: invocation.result?.trim() ? "success" : "no_reply",
    });
  } else if (
    invocation.status === "blocked" ||
    invocation.status === "failed"
  ) {
    await lifecycle.fail({
      ...common,
      failureCode: "model_execution_failed",
    });
  }
}

/** Recover a terminal invocation from its authoritative completed session. */
async function projectTerminalSession(
  invocation: AgentInvocation,
): Promise<AgentInvocation | undefined> {
  const session = await getAgentTurnSessionRecord(
    invocation.childConversationId,
    getAgentInvocationTurnId(invocation.invocationId),
  );
  if (!session) {
    return undefined;
  }
  if (session.state === "paused" || session.state === "running") {
    return undefined;
  }
  const result = getTerminalAssistantMessages(session.piMessages)
    .map(getAssistantReplyText)
    .filter((text): text is string => text !== undefined)
    .join("\n\n");
  const failed = session.state !== "completed" || Boolean(session.errorMessage);
  return await completeAgentInvocation({
    invocationId: invocation.invocationId,
    ...(failed
      ? {
          errorMessage: session.errorMessage ?? "Agent invocation failed",
          status: "failed" as const,
        }
      : {
          result,
          status: "completed" as const,
        }),
  });
}

/**
 * Re-park a stranded running session at its latest durable safe boundary.
 *
 * Unrecoverable stranded sessions are failed immediately, matching agent
 * continue recovery. Empty resume wakes never become final delivery attempts,
 * so throwing here would requeue forever and leave named agents busy.
 */
async function recoverRunningSession(
  invocation: AgentInvocation,
): Promise<void> {
  const session = await getAgentTurnSessionRecord(
    invocation.childConversationId,
    getAgentInvocationTurnId(invocation.invocationId),
  );
  if (!session || session.state !== "running") {
    return;
  }
  const projection = await openConversationProjection({
    conversationId: invocation.childConversationId,
  });
  // Child invocation conversations are destinationless; routing lives on the
  // parent invocation record, not the turn-session projection.
  const parked = await saveTurnCheckpoint({
    mode: "paused",
    reason: "yield",
    conversationId: invocation.childConversationId,
    turnId: session.sessionId,
    sliceId: session.sliceId,
    errorMessage: "Recovered running agent invocation after worker loss",
    messages: session.piMessages,
    modelId: modelIdForProfile(botConfig, projection.modelProfile),
    // Execution actor and reasoning live on the parent invocation, not Redis.
    actor: invocation.actor,
    reasoningLevel: invocation.reasoningLevel,
    surface: session.surface,
  });
  if (!parked) {
    await failAgentTurnSessionRecord({
      conversationId: invocation.childConversationId,
      expectedVersion: session.version,
      sessionId: session.sessionId,
      errorMessage: `Running agent invocation had no resumable boundary for ${invocation.invocationId}`,
    });
    return;
  }
  await markAgentInvocationAwaitingResume(invocation.invocationId);
}

/** Classify authorization failures that terminally block background work. */
function blockingInvocationError(
  error: unknown,
): AuthorizationFlowDisabledError | PluginCredentialFailureError | undefined {
  const cause = getConversationTurnBoundaryError(error)?.cause ?? error;
  return cause instanceof AuthorizationFlowDisabledError ||
    cause instanceof PluginCredentialFailureError
    ? cause
    : undefined;
}

function isInvocationInputCommitLost(error: unknown): boolean {
  const cause = getConversationTurnBoundaryError(error)?.cause ?? error;
  return isTurnInputCommitLostError(cause);
}

/** Build the invocation consumer that advances work through the shared runner. */
export function createAgentInvocationWorker(options: {
  agentRunner: AgentRunner;
}) {
  return async (
    context: ConversationWorkerContext,
    invocationId: string,
  ): Promise<ConversationWorkerResult> => {
    let invocation = await getAgentInvocation(invocationId);
    if (!invocation) {
      throw new Error(`Agent invocation is missing for ${invocationId}`);
    }

    let acknowledged = context.attempt.messages.length === 0;
    const acknowledge = async (): Promise<void> => {
      if (acknowledged) {
        return;
      }
      try {
        await context.attempt.ack();
      } catch {
        throw new TurnInputCommitLostError(
          `Conversation work lease lost before invocation inbox ack for ${context.conversationId}`,
        );
      }
      acknowledged = true;
    };

    const turnId = getAgentInvocationTurnId(invocation.invocationId);
    const lifecycle = new ConversationTurnLifecycleService(
      getConversationEventStore(),
    );
    let artifacts: ThreadArtifactsState;
    let sandboxRef: SandboxRef | undefined;
    let history: PiMessage[];
    try {
      if (invocation.childConversationId !== context.conversationId) {
        throw new Error(
          `Agent invocation ${invocationId} belongs to ${invocation.childConversationId}, not ${context.conversationId}`,
        );
      }
      if (context.destination) {
        throw new Error(
          `Agent invocation conversation ${context.conversationId} must not own a provider destination`,
        );
      }
      if (isTerminalAgentInvocation(invocation)) {
        await persistTerminalLifecycle(invocation);
        await acknowledge();
        return { status: "completed" };
      }
      // Recover stranded running sessions before terminal projection so an
      // unrecoverable child can fail its session and complete through the
      // same immutable result path as a normal completed/failed session.
      await recoverRunningSession(invocation);
      const projected = await projectTerminalSession(invocation);
      if (projected && isTerminalAgentInvocation(projected)) {
        await persistTerminalLifecycle(projected);
        await acknowledge();
        return { status: "completed" };
      }
      invocation =
        (await markAgentInvocationRunning(invocation.invocationId)) ??
        invocation;
      await lifecycle.start({
        conversationId: invocation.childConversationId,
        createdAtMs: invocation.createdAtMs,
        inputMessageIds: [getAgentInvocationMessageId(invocation.invocationId)],
        surface: "internal",
        turnId,
      });
      const [persisted, projection] = await Promise.all([
        getPersistedThreadState(invocation.childConversationId),
        openConversationProjection({
          conversationId: invocation.childConversationId,
        }),
      ]);
      artifacts = coerceThreadArtifactsState(persisted);
      sandboxRef = getPersistedSandboxState(persisted);
      history = projection.messages;
    } catch (error) {
      if (isInvocationInputCommitLost(error)) {
        return { status: "lost_lease" };
      }
      if (!context.attempt.isFinalAttempt) {
        throw error;
      }
      const terminal = await completeAgentInvocation({
        invocationId: invocation.invocationId,
        errorMessage:
          error instanceof Error ? error.message : "Agent invocation failed",
        status: "failed",
      });
      if (terminal) {
        await persistTerminalLifecycle(terminal);
      }
      await acknowledge();
      return { status: "completed" };
    }

    let outcome;
    try {
      outcome = await options.agentRunner.run({
        conversationId: invocation.childConversationId,
        turnId,
        runId: invocation.invocationId,
        input: {
          messageText: invocation.input,
          piMessages: history,
        },
        routing: {
          actor: invocation.actor,
          credentialContext: invocation.credentialContext,
          destination: invocation.destination,
          destinationVisibility: invocation.destinationVisibility,
          source: invocation.source,
          surface: "internal",
        },
        policy: {
          // TODO(#881, #883): Child runs may still need a path to force
          // interactive auth when a delegated tool requires credentials the
          // parent already has authority to request. Today background children
          // hard-fail instead of pausing for an OAuth link.
          disabledFeatures: ["handoff", "interactive-auth", "subagents"],
          reasoningLevel: invocation.reasoningLevel,
        },
        state: {
          artifactState: artifacts,
          sandboxRef,
        },
        durability: {
          onInputCommitted: acknowledge,
          shouldYield: context.shouldYield,
          onArtifactStateUpdated: async (nextArtifacts) => {
            artifacts = nextArtifacts;
            await persistThreadStateById(invocation.childConversationId, {
              artifacts,
              sandboxRef,
            });
          },
          onSandboxRefChanged: async (nextSandboxRef) => {
            sandboxRef = nextSandboxRef;
            await persistThreadStateById(invocation.childConversationId, {
              artifacts,
              sandboxRef,
            });
          },
        },
      });
    } catch (error) {
      if (isInvocationInputCommitLost(error)) {
        return { status: "lost_lease" };
      }
      const blocking = blockingInvocationError(error);
      if (blocking) {
        const terminal = await completeAgentInvocation({
          invocationId: invocation.invocationId,
          errorMessage: blocking.message,
          status: "blocked",
        });
        if (terminal) {
          await persistTerminalLifecycle(terminal);
        }
        await acknowledge();
        return { status: "completed" };
      }
      if (!context.attempt.isFinalAttempt) {
        throw error;
      }
      const terminal = await completeAgentInvocation({
        invocationId: invocation.invocationId,
        errorMessage:
          error instanceof Error ? error.message : "Agent invocation failed",
        status: "failed",
      });
      if (terminal) {
        await persistTerminalLifecycle(terminal);
      }
      await acknowledge();
      return { status: "completed" };
    }

    if (outcome.status === "suspended") {
      await markAgentInvocationAwaitingResume(invocation.invocationId);
      return { status: "yielded" };
    }
    if (outcome.status === "awaiting_auth") {
      const terminal = await completeAgentInvocation({
        invocationId: invocation.invocationId,
        errorMessage: `Agent invocation requires ${outcome.providerDisplayName} authorization`,
        status: "blocked",
      });
      if (terminal) {
        await persistTerminalLifecycle(terminal);
      }
      await acknowledge();
      return { status: "completed" };
    }

    const result = outcome.result;
    const failed = result.diagnostics.outcome !== "success";
    await persistThreadStateById(invocation.childConversationId, {
      artifacts: result.artifactStatePatch
        ? { ...artifacts, ...result.artifactStatePatch }
        : artifacts,
      sandboxRef: result.sandboxRef ?? sandboxRef,
    });
    if (result.piMessages?.length) {
      await saveTurnCheckpoint({
        mode: "completed",
        conversationId: invocation.childConversationId,
        turnId,
        durationMs: result.diagnostics.durationMs,
        usage: result.diagnostics.usage,
        destination: invocation.destination,
        destinationVisibility: invocation.destinationVisibility,
        ...(failed
          ? {
              errorMessage:
                result.diagnostics.errorMessage ?? "Agent invocation failed",
            }
          : {}),
        messages: result.piMessages,
        modelId: result.diagnostics.modelId,
        actor: invocation.actor,
        reasoningLevel: result.diagnostics.reasoningLevel,
        source: invocation.source,
        surface: "internal",
      });
    }
    const terminal = await completeAgentInvocation({
      invocationId: invocation.invocationId,
      ...(failed
        ? {
            errorMessage:
              result.diagnostics.errorMessage ?? "Agent invocation failed",
            status: "failed" as const,
          }
        : {
            result: result.text,
            status: "completed" as const,
          }),
    });
    if (!terminal) {
      throw new Error(
        `Agent invocation disappeared during completion for ${invocation.invocationId}`,
      );
    }
    await persistTerminalLifecycle(terminal);
    await acknowledge();
    return { status: "completed" };
  };
}

/** Route invocation-backed work before falling through to existing consumers. */
export function routeAgentInvocationWork(options: {
  fallbackWorker: (
    context: ConversationWorkerContext,
  ) => Promise<ConversationWorkerResult>;
  invocationWorker: (
    context: ConversationWorkerContext,
    invocationId: string,
  ) => Promise<ConversationWorkerResult>;
}) {
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const invocationId = await resolveAgentInvocationId(context);
    return invocationId
      ? await options.invocationWorker(context, invocationId)
      : await options.fallbackWorker(context);
  };
}
