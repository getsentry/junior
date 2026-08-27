import type { StateAdapter } from "chat";
import { z } from "zod";
import type { Location } from "@/chat/conversations/location";
import type { ConversationStore } from "@/chat/conversations/store";
import { openConversationProjection } from "@/chat/conversations/projection";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { AgentRunError, executeTurn } from "@/chat/runtime/turn-execution";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import {
  failTurnRecord,
  getTurnRecord,
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
import type { AgentRunResult } from "@/chat/services/turn-result";
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
    publishExternally: false,
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

/** Stop an invocation whose worker died, or project its terminal turn result. */
async function projectTerminalTurn(
  invocation: AgentInvocation,
): Promise<AgentInvocation | undefined> {
  let turn = await getTurnRecord(
    invocation.childConversationId,
    getAgentInvocationTurnId(invocation.invocationId),
  );
  if (!turn) {
    return undefined;
  }
  if (turn.state === "running") {
    turn = await failTurnRecord({
      conversationId: turn.conversationId,
      expectedVersion: turn.version,
      turnId: turn.turnId,
      errorMessage: "Agent invocation lost its worker before it could pause",
    });
    if (!turn) {
      return undefined;
    }
  }
  if (turn.state === "paused") {
    return undefined;
  }
  const result = getTerminalAssistantMessages(turn.piMessages)
    .map(getAssistantReplyText)
    .filter((text): text is string => text !== undefined)
    .join("\n\n");
  const failed = turn.state !== "completed" || Boolean(turn.errorMessage);
  return await completeAgentInvocation({
    invocationId: invocation.invocationId,
    ...(failed
      ? {
          errorMessage: turn.errorMessage ?? "Agent invocation failed",
          status: "failed" as const,
        }
      : {
          result,
          status: "completed" as const,
        }),
  });
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

/** Save one completed agent result on its child agent invocation. */
async function saveAgentInvocationResult(args: {
  invocation: AgentInvocation;
  result: AgentRunResult;
  sandboxRef?: SandboxRef;
  turnId: string;
}) {
  const failed = args.result.diagnostics.outcome !== "success";
  await persistThreadStateById(args.invocation.childConversationId, {
    sandboxRef: args.result.sandboxRef ?? args.sandboxRef,
  });
  if (args.result.piMessages?.length) {
    await saveTurnCheckpoint({
      mode: "completed",
      conversationId: args.invocation.childConversationId,
      turnId: args.turnId,
      durationMs: args.result.diagnostics.durationMs,
      usage: args.result.diagnostics.usage,
      destination: args.invocation.destination,
      destinationVisibility: args.invocation.destinationVisibility,
      ...(failed
        ? {
            errorMessage:
              args.result.diagnostics.errorMessage ?? "Agent invocation failed",
          }
        : undefined),
      messages: args.result.piMessages,
      actor: args.invocation.actor,
      source: args.invocation.source,
      surface: "internal",
    });
  }
  const terminal = await completeAgentInvocation({
    invocationId: args.invocation.invocationId,
    ...(failed
      ? {
          errorMessage:
            args.result.diagnostics.errorMessage ?? "Agent invocation failed",
          status: "failed" as const,
        }
      : {
          result: args.result.text,
          status: "completed" as const,
        }),
  });
  if (!terminal || !isTerminalAgentInvocation(terminal)) {
    throw new Error(
      `Agent invocation did not finish for ${args.invocation.invocationId}`,
    );
  }
  return terminal.status === "completed"
    ? {
        finishedAtMs: terminal.terminalAtMs,
        outcome: terminal.result.trim()
          ? ("success" as const)
          : ("no_reply" as const),
      }
    : {
        finishedAtMs: terminal.terminalAtMs,
        failureCode: "model_execution_failed" as const,
        outcome: "failed" as const,
      };
}

/** Build the invocation consumer that advances work through the shared runner. */
export function createAgentInvocationWorker(agentRunner: AgentRunner) {
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
    let sandboxRef: SandboxRef | undefined;
    let history: PiMessage[];
    let location: Location | undefined;
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
      const projected = await projectTerminalTurn(invocation);
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
      sandboxRef = getPersistedSandboxState(persisted);
      history = projection.messages;
      location = (
        await getConversationStore().get({
          conversationId: invocation.parentConversationId,
        })
      )?.location;
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
      outcome = await executeTurn(
        agentRunner,
        {
          conversationId: invocation.childConversationId,
          turnId,
          runId: invocation.invocationId,
          instruction: {
            text: invocation.input,
          },
          history,
          actor: invocation.actor,
          credentialContext: invocation.credentialContext,
          destination: invocation.destination,
          ...(location ? { location } : undefined),
          destinationVisibility: invocation.destinationVisibility,
          publishExternally: context.publishExternally,
          source: invocation.source,
          surface: "internal",
          // TODO(dcramer): Issues #881 and #883 track a path for child runs to
          // force interactive auth when a delegated tool requires credentials
          // the parent can request. Today background children hard-fail instead
          // of pausing for an OAuth link.
          disabledFeatures: ["handoff", "interactive-auth", "subagents"],
          reasoning: invocation.reasoningLevel,
          state: {
            sandboxRef,
          },
          durability: {
            onInputCommitted: acknowledge,
            shouldYield: context.shouldYield,
            onSandboxRefChanged: async (nextSandboxRef) => {
              sandboxRef = nextSandboxRef;
              await persistThreadStateById(invocation.childConversationId, {
                sandboxRef,
              });
            },
          },
        },
        async (result) =>
          await saveAgentInvocationResult({
            invocation,
            result,
            sandboxRef,
            turnId,
          }),
      );
    } catch (error) {
      if (!(error instanceof AgentRunError)) {
        throw error;
      }
      const runError = error.cause;
      if (isInvocationInputCommitLost(runError)) {
        return { status: "lost_lease" };
      }
      const blocking = blockingInvocationError(runError);
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
        throw runError;
      }
      const terminal = await completeAgentInvocation({
        invocationId: invocation.invocationId,
        errorMessage:
          runError instanceof Error
            ? runError.message
            : "Agent invocation failed",
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
