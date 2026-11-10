import type { StateAdapter } from "chat";
import { instructionForInputs } from "@/chat/agent/prompt";
import type { AgentRun } from "@/chat/agent/types";
import type { Location } from "@/chat/conversations/location";
import type { ConversationStore } from "@/chat/conversations/store";
import { openConversationProjection } from "@/chat/conversations/projection";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  AgentRunError,
  executeTurn,
  finishTurn,
  type SavedTurnResult,
} from "@/chat/runtime/turn-execution";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import {
  abandonTurnRecord,
  failTurnRecord,
  getTurnRecord,
  lostWorkerBeforeFirstSave,
  pauseLostWorkerTurn,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import {
  getConversationTurnBoundaryError,
  isTurnInputCommitLostError,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { getTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { botConfig } from "@/chat/config";
import {
  recordFinishedTurnForAutomatedLimit,
  resetAutomatedTurnLimit,
} from "@/chat/services/automated-turn-limit";
import { maybePostAutomatedTurnLimitNotice } from "@/chat/slack/automated-turn-limit-notice";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import { isTurnExecutionLimitExceededError } from "@/chat/services/turn-limit";
import type { PiMessage } from "@/chat/pi/messages";
import type { SandboxRef } from "@/chat/sandbox/ref";
import { supersedeOpenPersonTurn } from "./thread-turn";
import { agentTypeStartsWithParentHistory } from "./agent-types";
import { loadForkHistory } from "./fork-history";
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
import { createAgentInvocation } from "./create";
import { getAgentInvocationMessageId, getAgentInvocationTurnId } from "./ids";
import { finishAgentInvocation, type SendAgentResult } from "./finish";
import {
  getActiveAgentInvocationForConversation,
  getAgentInvocation,
  getLatestAgentInvocationForConversation,
  isParentTask,
  isTerminalAgentInvocation,
  ACTIVE_AGENT_INVOCATION_STATUSES,
  listAgentInvocationsForConversation,
  NON_TERMINAL_AGENT_INVOCATION_STATUSES,
  markAgentInvocationPaused,
  markAgentInvocationMailboxAppended,
  markAgentInvocationRunning,
} from "./store";
import type {
  AgentInvocation,
  CreateAgentInvocationInput,
  TerminalAgentInvocation,
} from "./types";
import { recordSubagentEnded, recordSubagentStarted } from "./markers";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { getTerminalAssistantMessages } from "@/chat/pi/transcript";
import { stopChildAgentsOf } from "./stop";
import { resumeStoppedConversationTree } from "@/chat/conversations/session-stop";
import {
  CHILD_REPORT_REMINDER,
  childTurnOutcome,
  hasReportForLatestTask,
  latestTaskId,
  reportTexts,
  turnMessages,
} from "./report";
import { sendReportToParent, type EnqueueAgentMessage } from "./send-report";
import {
  agentInvocationInputText,
  agentInvocationMailboxMetadataSchema,
  agentInvocationProvenance,
  createAgentMessageSteeringDrain,
} from "./steering";

type EnqueueOptions = {
  conversationStore?: ConversationStore;
  /** Event fields of input that came from Events, for its transcript row. */
  eventMeta?: Parameters<typeof recordSubagentStarted>[1];
  nowMs?: number;
  queue: ConversationWorkQueue;
  state?: StateAdapter;
};

/** Map a durable invocation's model settings and depth to the child Run policy. */
export function agentInvocationRunPolicy(
  invocation: AgentInvocation,
  canSpawn: boolean,
): Pick<AgentRun, "disabledFeatures" | "reasoning"> {
  return {
    disabledFeatures: canSpawn
      ? ["interactive-auth"]
      : ["interactive-auth", "subagents"],
    ...(invocation.reasoningLevel
      ? { reasoning: invocation.reasoningLevel }
      : undefined),
  };
}

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
      // A parent agent wrote the task, not a person.
      authorIdentityId: SYSTEM_IDENTITY_ID,
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
  // A stop can end an agent invocation before its mailbox append.
  if (
    invocation.mailboxStatus === "appended" ||
    isTerminalAgentInvocation(invocation)
  ) {
    return;
  }
  await recordSubagentStarted(invocation, options.eventMeta);
  // New work from a parent tool call ends the stop of the child and of the
  // child agents below it. A child's own Events and results do not.
  if (isParentTask(invocation)) {
    await resumeStoppedConversationTree(
      invocation.childConversationId,
      invocation.createdAtMs,
    );
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
  const active = await getActiveAgentInvocationForConversation(
    context.conversationId,
  );
  if (active) {
    return active.invocationId;
  }
  // A child Conversation never runs on a root worker. A wake after its last
  // agent invocation ended, such as a late stop request, goes to that agent
  // invocation, which only repeats its idempotent finish. A paused Turn of an
  // ended agent invocation can have an event Source, and a root worker would
  // try to resume it.
  const latest = await getLatestAgentInvocationForConversation(
    context.conversationId,
  );
  return latest?.invocationId;
}

/**
 * How a terminal agent invocation ends its child Turn. The live save and the
 * recovery paths both use this, so a status cannot end the Turn two ways.
 */
function agentInvocationTurnEnd(
  terminal: TerminalAgentInvocation,
): SavedTurnResult {
  const finishedAtMs = terminal.terminalAtMs;
  switch (terminal.status) {
    // A Run replies only when it sends a report. The result of a parent
    // task with none is a note, not a reply.
    case "completed":
      return {
        finishedAtMs,
        outcome:
          reportTexts(terminal.reportLog).length > 0 ? "success" : "no_reply",
      };
    case "stopped":
      return { finishedAtMs, outcome: "cancelled" };
    // A blocked child reported what it needs. That is a result, not a failure.
    case "blocked":
      return { finishedAtMs, outcome: "blocked" };
    case "failed":
      return {
        failureCode: "model_execution_failed",
        finishedAtMs,
        outcome: "failed",
      };
  }
}

/** Project the terminal invocation into the idempotent turn lifecycle. */
async function persistTerminalLifecycle(
  terminal: TerminalAgentInvocation,
): Promise<void> {
  const turnId = getAgentInvocationTurnId(terminal.invocationId);
  if (terminal.status !== "completed") {
    // A child that ends between slices has a paused Turn record. Nothing may
    // resume it.
    await abandonTurnRecord({
      conversationId: terminal.childConversationId,
      errorMessage:
        terminal.status === "stopped"
          ? "Turn cancelled"
          : terminal.errorMessage,
      turnId,
    });
  }
  await finishTurn(
    terminal.childConversationId,
    turnId,
    agentInvocationTurnEnd(terminal),
  );
}

/**
 * Stop an invocation whose worker died, or project its terminal turn result.
 * With `resumeLostWorker`, a Turn whose worker died resumes once from its last
 * save, as a root Turn does. A second loss stops it.
 */
async function projectTerminalTurn(
  invocation: AgentInvocation,
  options: {
    enqueueMessage?: EnqueueAgentMessage;
    resumeLostWorker?: boolean;
    sendResult?: SendAgentResult;
  } = {},
): Promise<AgentInvocation | undefined> {
  const { resumeLostWorker } = options;
  let turn = await getTurnRecord(
    invocation.childConversationId,
    getAgentInvocationTurnId(invocation.invocationId),
  );
  if (!turn) {
    return undefined;
  }
  if (
    resumeLostWorker &&
    turn.state === "running" &&
    (await pauseLostWorkerTurn(turn))
  ) {
    return undefined;
  }
  if (
    turn.state === "running" ||
    // The resumed run lost its worker again before its first save.
    (resumeLostWorker &&
      turn.state === "paused" &&
      lostWorkerBeforeFirstSave(turn))
  ) {
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
  const failed = turn.state !== "completed" || Boolean(turn.errorMessage);
  return await completeChildTurn({
    enqueueMessage: options.enqueueMessage,
    invocation,
    outcome: childTurnOutcome({
      errorMessage: failed
        ? (turn.errorMessage ?? "Agent invocation failed")
        : undefined,
      turnMessages: turnMessages(turn.piMessages, turn.turnStartMessageIndex),
    }),
    sendResult: options.sendResult,
    turnId: turn.turnId,
    ...(turn.turnLimitWrappedUp
      ? { turnLimitStopText: savedFinalResponse(turn.piMessages) }
      : undefined),
  });
}

/**
 * Save how one child Turn ended. A `noReply` note is the closing report of a
 * parent task. After a turn-limit stop, the Run's final response is sent as
 * a report, as `messageAgent` would send it. A normal end and a recovered
 * Turn both come here, so neither drops it.
 */
async function completeChildTurn(args: {
  enqueueMessage?: EnqueueAgentMessage;
  invocation: AgentInvocation;
  outcome: ReturnType<typeof childTurnOutcome>;
  sendResult?: SendAgentResult;
  turnId: string;
  turnLimitStopText?: string;
}): Promise<AgentInvocation | undefined> {
  const { invocation, outcome } = args;
  if (args.turnLimitStopText) {
    await sendReportToParent({
      enqueueMessage: args.enqueueMessage,
      invocation,
      key: `${args.turnId}:turn-limit`,
      text: args.turnLimitStopText,
    });
  }
  return await finishAgentInvocation(
    outcome.status === "completed"
      ? {
          closingReport: outcome.noReply?.note,
          invocationId: invocation.invocationId,
          noReply: Boolean(outcome.noReply),
          sendResult: args.sendResult,
          status: "completed",
        }
      : {
          ...outcome,
          invocationId: invocation.invocationId,
          sendResult: args.sendResult,
        },
  );
}

/** The final response of a saved Turn, joined like a root reply. */
function savedFinalResponse(piMessages: readonly unknown[]): string {
  return getTerminalAssistantMessages(piMessages)
    .map(getAssistantReplyText)
    .filter((text): text is string => text !== undefined)
    .join("\n\n");
}

/**
 * End every running or paused agent invocation of a child before other work
 * opens a Turn there, so the child has one open Turn. A saved finished Turn
 * gives its result. Every other parent task fails with `errorMessage`,
 * because the newer work does not continue it. The child's own work fails
 * too, and names its dropped input, so the parent knows that it never
 * finished. Each reports on its own.
 */
export async function endActiveAgentInvocations(
  conversationId: string,
  options: {
    enqueueMessage?: EnqueueAgentMessage;
    errorMessage: string;
    exceptInvocationId?: string;
    sendResult?: SendAgentResult;
  },
): Promise<void> {
  for (const active of await listAgentInvocationsForConversation(
    conversationId,
    ACTIVE_AGENT_INVOCATION_STATUSES,
  )) {
    if (active.invocationId === options.exceptInvocationId) {
      continue;
    }
    const terminal =
      (await projectTerminalTurn(active, {
        enqueueMessage: options.enqueueMessage,
        sendResult: options.sendResult,
      })) ??
      (await finishAgentInvocation({
        invocationId: active.invocationId,
        errorMessage: isParentTask(active)
          ? options.errorMessage
          : `Newer work stopped this before it finished: ${active.inputLabel ?? "its input"}`,
        sendResult: options.sendResult,
        status: "failed",
      }));
    if (terminal && isTerminalAgentInvocation(terminal)) {
      await persistTerminalLifecycle(terminal);
      await recordSubagentEnded(terminal);
    }
  }
}

/**
 * End every agent invocation of a child whose last attempt lost its worker and
 * whose input reached the child's mailbox. The worker ran no failure path, and
 * the stop drops the mailbox, so none of them can run. Each owed result is
 * sent here.
 */
export async function endAgentInvocationsOfStoppedWork(
  conversationId: string,
  inboundMessageIds: readonly string[],
  options: { sendResult?: SendAgentResult } = {},
): Promise<void> {
  for (const invocation of await listAgentInvocationsForConversation(
    conversationId,
    NON_TERMINAL_AGENT_INVOCATION_STATUSES,
  )) {
    // Its append runs after the stop and starts new work for the child.
    if (
      !inboundMessageIds.includes(
        getAgentInvocationMessageId(invocation.invocationId),
      )
    ) {
      continue;
    }
    const terminal =
      (await projectTerminalTurn(invocation, options)) ??
      (await finishAgentInvocation({
        invocationId: invocation.invocationId,
        errorMessage: "This task stopped because its worker failed repeatedly.",
        sendResult: options.sendResult,
        status: "failed",
      }));
    if (terminal && isTerminalAgentInvocation(terminal)) {
      await persistTerminalLifecycle(terminal);
    }
  }
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
  enqueueMessage?: EnqueueAgentMessage;
  invocation: AgentInvocation;
  result: AgentRunResult;
  sandboxRef?: SandboxRef;
  sendResult?: SendAgentResult;
  turnId: string;
}) {
  // A child replies with `messageAgent`, so a Run that sent a report needs
  // no final response. A provider error still fails it.
  const { outcome: runOutcome } = args.result.diagnostics;
  const failed =
    runOutcome !== "success" &&
    (runOutcome === "provider_error" ||
      reportTexts(
        (await getAgentInvocation(args.invocation.invocationId))?.reportLog,
      ).length === 0);
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
  // As on a root, a watch event Turn counts toward the automated-turn limit,
  // and a task or message from the parent resets it like a user message.
  if (isParentTask(args.invocation)) {
    await resetAutomatedTurnLimit({
      conversationId: args.invocation.childConversationId,
    });
  } else if (args.invocation.source.kind !== "agent_invocation") {
    const maxTurns = botConfig.maxConsecutiveAutomatedTurns;
    // A child posts no notice, so this clears its claim.
    await maybePostAutomatedTurnLimitNotice({
      conversationId: args.invocation.childConversationId,
      maxTurns,
      update: await recordFinishedTurnForAutomatedLimit({
        conversationId: args.invocation.childConversationId,
        maxTurns,
        source: args.invocation.source,
      }),
    });
  }
  const turn = await getTurnRecord(
    args.invocation.childConversationId,
    args.turnId,
  );
  const outcome = childTurnOutcome({
    errorMessage: failed
      ? (args.result.diagnostics.errorMessage ?? "Agent invocation failed")
      : undefined,
    turnMessages: turnMessages(
      args.result.piMessages ?? [],
      turn?.turnStartMessageIndex,
    ),
  });
  // Without a turn-limit stop, the final response is not sent to the parent.
  const terminal = await completeChildTurn({
    enqueueMessage: args.enqueueMessage,
    invocation: args.invocation,
    outcome,
    sendResult: args.sendResult,
    turnId: args.turnId,
    ...(turn?.turnLimitWrappedUp
      ? { turnLimitStopText: args.result.text }
      : undefined),
  });
  if (!terminal || !isTerminalAgentInvocation(terminal)) {
    throw new Error(
      `Agent invocation did not finish for ${args.invocation.invocationId}`,
    );
  }
  return agentInvocationTurnEnd(terminal);
}

/**
 * Build the invocation consumer that advances work through the shared runner.
 * `sendResult` sends each owed result to the parent mailbox, and
 * `enqueueMessage` sends a message from the child's own work. Omit them only
 * where the parent has no mailbox, such as the local CLI.
 * `maxAgentDepth` is the number of child agent levels that can start their
 * own child agents. The default, 0, lets only the root start child agents.
 */
export function createAgentInvocationWorker(
  agentRunner: AgentRunner,
  options: {
    enqueueMessage?: EnqueueAgentMessage;
    maxAgentDepth?: number;
    sendResult?: SendAgentResult;
  } = {},
) {
  // Every child has depth 1 or more, so with 0 no child can spawn. With more,
  // a child past the limit still sees spawnAgent, and the spawn-time check in
  // spawn.ts refuses it. Depth is not stored or read per Run.
  const canSpawn = (options.maxAgentDepth ?? 0) > 0;
  return async (
    context: ConversationWorkerContext,
    invocationId: string,
  ): Promise<ConversationWorkerResult> => {
    let invocation = await getAgentInvocation(invocationId);
    if (!invocation) {
      throw new Error(`Agent invocation is missing for ${invocationId}`);
    }
    const { sendResult } = options;
    // `finishAgentInvocation` sent any owed result before this runs, and
    // before the ack, so a failed parent append retries this work.
    const finish = async (
      terminal: AgentInvocation | undefined,
    ): Promise<void> => {
      if (!terminal || !isTerminalAgentInvocation(terminal)) {
        return;
      }
      // A steered task never started a Turn, so it has no Turn record.
      if (
        terminal.status !== "completed" ||
        (await getTurnRecord(terminal.childConversationId, turnId))
      ) {
        await persistTerminalLifecycle(terminal);
      }
      await recordSubagentEnded(terminal);
    };

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

    // Read the signal before any early return, so the worker clears a stop
    // request that this wake handles.
    const stopSignal = context.stopSignal?.();
    // `stopChildAgent` already marked its work `stopped`. Any other stop is
    // recorded here and reported to the parent.
    // The stop also stops the child agents of this child, so no result of
    // theirs starts this child again.
    const finishStopped = async (): Promise<ConversationWorkerResult> => {
      await finish(
        await finishAgentInvocation({
          invocationId,
          errorMessage: "Agent invocation was stopped",
          sendResult,
          status: "stopped",
        }),
      );
      await stopChildAgentsOf(context.conversationId);
      await acknowledge();
      return { status: "completed" };
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
        await finish(invocation);
        await acknowledge();
        return { status: "completed" };
      }
      // This worker holds the lease, so a running Turn lost its worker.
      const projected = await projectTerminalTurn(invocation, {
        enqueueMessage: options.enqueueMessage,
        resumeLostWorker: true,
        sendResult,
      });
      if (projected && isTerminalAgentInvocation(projected)) {
        await finish(projected);
        await acknowledge();
        return { status: "completed" };
      }
      // A child has one open Turn. End every other open agent invocation and
      // a person's open Turn in a Thread first.
      await endActiveAgentInvocations(invocation.childConversationId, {
        enqueueMessage: options.enqueueMessage,
        errorMessage:
          "This task was not resumed. Newer work for this child agent started, so this task ended without a result.",
        exceptInvocationId: invocation.invocationId,
        sendResult,
      });
      await supersedeOpenPersonTurn(invocation.childConversationId);
      invocation =
        (await markAgentInvocationRunning(invocation.invocationId)) ??
        invocation;
      // A stop can land between the read above and this write.
      if (isTerminalAgentInvocation(invocation)) {
        await finish(invocation);
        await acknowledge();
        return { status: "completed" };
      }
      await lifecycle.start({
        conversationId: invocation.childConversationId,
        createdAtMs: invocation.createdAtMs,
        inputMessageIds: [getAgentInvocationMessageId(invocation.invocationId)],
        surface: "internal",
        turnId,
      });
      const [persisted, projection, child] = await Promise.all([
        getPersistedThreadState(invocation.childConversationId),
        openConversationProjection({
          conversationId: invocation.childConversationId,
        }),
        getConversationStore().get({
          conversationId: invocation.childConversationId,
        }),
      ]);
      sandboxRef = getPersistedSandboxState(persisted);
      // Some types start with the parent's history. Later agent invocations
      // read it from the child's own Conversation.
      history =
        agentTypeStartsWithParentHistory(invocation.agentType) &&
        projection.messages.length === 0
          ? await loadForkHistory(invocation)
          : projection.messages;
      location = child?.location;
    } catch (error) {
      if (isInvocationInputCommitLost(error)) {
        return { status: "lost_lease" };
      }
      if (!context.attempt.isFinalAttempt) {
        throw error;
      }
      const terminal = await finishAgentInvocation({
        invocationId: invocation.invocationId,
        sendResult,
        errorMessage:
          error instanceof Error ? error.message : "Agent invocation failed",
        status: "failed",
      });
      await finish(terminal);
      await acknowledge();
      return { status: "completed" };
    }

    let outcome;
    try {
      outcome = await executeTurn(
        agentRunner,
        {
          conversationId: invocation.childConversationId,
          agentInvocationId: invocation.invocationId,
          parentConversationId: invocation.parentConversationId,
          turnId,
          runId: invocation.invocationId,
          // A child has no person input: every input is a runtime tag.
          instruction: {
            ...instructionForInputs([
              { kind: "runtime", text: agentInvocationInputText(invocation) },
            ]),
            provenance: agentInvocationProvenance(invocation),
          },
          history,
          actor: invocation.actor,
          credentialContext: invocation.credentialContext,
          destination: invocation.destination,
          source: invocation.source,
          ...(location ? { location } : undefined),
          surface: "internal",
          // A Turn that starts late in the worker's request must pause before
          // the host ends the request, not run on until the host kills it.
          deadlineAtMs: getTurnRequestDeadline()?.deadlineAtMs,
          ...(stopSignal ? { signal: stopSignal } : undefined),
          // TODO(dcramer): Issues #881 and #883 track a path for child runs to
          // force interactive auth when a delegated tool requires credentials
          // the parent can request. Today background children hard-fail instead
          // of pausing for an OAuth link.
          ...agentInvocationRunPolicy(invocation, canSpawn),
          replyGate: {
            read: async () => {
              const log = (await getAgentInvocation(invocationId))?.reportLog;
              return {
                replied: hasReportForLatestTask(log),
                taskId: latestTaskId(log),
              };
            },
            reminder: CHILD_REPORT_REMINDER,
          },
          state: {
            sandboxRef,
          },
          durability: {
            // Only a parent task reports for messages that steer it. The
            // child's own work sends no result, so they wait for it.
            ...(isParentTask(invocation)
              ? {
                  drainSteeringMessages: createAgentMessageSteeringDrain(
                    context,
                    invocation,
                  ),
                }
              : undefined),
            onInputCommitted: acknowledge,
            shouldYield: context.shouldYield,
            checkIn: context.checkIn,
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
            enqueueMessage: options.enqueueMessage,
            invocation,
            result,
            sandboxRef,
            sendResult,
            turnId,
          }),
      );
    } catch (error) {
      // A save error has no AgentRunError wrapper. On the final attempt it
      // must also fail the agent invocation, or the child stays open.
      const runError = error instanceof AgentRunError ? error.cause : error;
      if (isInvocationInputCommitLost(runError)) {
        return { status: "lost_lease" };
      }
      if (stopSignal?.aborted) {
        return await finishStopped();
      }
      const blocking = blockingInvocationError(runError);
      if (blocking) {
        const terminal = await finishAgentInvocation({
          invocationId: invocation.invocationId,
          sendResult,
          errorMessage: blocking.message,
          status: "blocked",
        });
        await finish(terminal);
        await acknowledge();
        return { status: "completed" };
      }
      // A retry cannot pass an execution limit, and its Turn record would
      // hide the limit as a lost worker.
      if (
        !context.attempt.isFinalAttempt &&
        !isTurnExecutionLimitExceededError(runError)
      ) {
        throw runError;
      }
      const terminal = await finishAgentInvocation({
        invocationId: invocation.invocationId,
        sendResult,
        errorMessage:
          runError instanceof Error
            ? runError.message
            : "Agent invocation failed",
        status: "failed",
      });
      await finish(terminal);
      await acknowledge();
      return { status: "completed" };
    }

    if (outcome.status !== "completed" && stopSignal?.aborted) {
      return await finishStopped();
    }
    if (outcome.status === "suspended") {
      await markAgentInvocationPaused(invocation.invocationId);
      return { status: "yielded" };
    }
    if (outcome.status === "awaiting_auth") {
      const terminal = await finishAgentInvocation({
        invocationId: invocation.invocationId,
        sendResult,
        errorMessage: `Agent invocation requires ${outcome.providerDisplayName} authorization`,
        status: "blocked",
      });
      await finish(terminal);
      await acknowledge();
      return { status: "completed" };
    }

    // executeTurn already recorded the terminal Turn; only report the result.
    const terminal = await getAgentInvocation(invocation.invocationId);
    // A stop that comes after the save still stops the child agents of this
    // child.
    if (stopSignal?.aborted) {
      await stopChildAgentsOf(context.conversationId);
    }
    if (terminal && isTerminalAgentInvocation(terminal)) {
      await recordSubagentEnded(terminal);
    }
    await acknowledge();
    return { status: "completed" };
  };
}
