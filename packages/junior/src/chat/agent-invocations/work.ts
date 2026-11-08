import { isDeepStrictEqual } from "node:util";
import type { StateAdapter } from "chat";
import * as z from "zod";
import {
  buildSteeringPiMessage,
  instructionForInputs,
  withoutSavedSteeringMessages,
} from "@/chat/agent/prompt";
import type { AgentRun, AgentSteeringMessage } from "@/chat/agent/types";
import type { Location } from "@/chat/conversations/location";
import {
  agentInstructionProvenance,
  contextProvenance,
  sameActorIdentity,
} from "@/chat/conversations/provenance";
import type { ConversationStore } from "@/chat/conversations/store";
import { openConversationProjection } from "@/chat/conversations/projection";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { escapeClosingTags, renderTag } from "@/chat/input-tags";
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
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { getTerminalAssistantMessages } from "@/chat/pi/transcript";
import type { PiMessage } from "@/chat/pi/messages";
import type { SandboxRef } from "@/chat/sandbox/ref";
import { supersedeOpenPersonTurn } from "./thread-turn";
import {
  agentTypeInstructions,
  agentTypeStartsWithParentHistory,
} from "./agent-types";
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
import {
  completeAgentInvocation,
  getActiveAgentInvocationForConversation,
  getAgentInvocation,
  getLatestAgentInvocationForConversation,
  isTerminalAgentInvocation,
  ACTIVE_AGENT_INVOCATION_STATUSES,
  listAgentInvocationsForConversation,
  NON_TERMINAL_AGENT_INVOCATION_STATUSES,
  markAgentInvocationPaused,
  markAgentInvocationMailboxAppended,
  markAgentInvocationRunning,
  markAgentInvocationSteered,
  reportReplacedAgentInvocation,
} from "./store";
import type {
  AgentInvocation,
  CreateAgentInvocationInput,
  TerminalAgentInvocation,
} from "./types";
import { recordSubagentEnded, recordSubagentStarted } from "./markers";
import { stopChildAgentsOf } from "./stop";
import { resumeStoppedConversationTree } from "@/chat/conversations/session-stop";
import { readBlockedReport } from "./blocked-report";

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
  await recordSubagentStarted(invocation);
  // New work from a parent tool call ends the stop of the child and of the
  // child agents below it. A child's own Events and results do not.
  if (invocation.parentToolCallId !== undefined) {
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

/**
 * Text that the child agent model reads for one agent invocation. A parent
 * agent task or message becomes one `<parent-agent-task>`. Results of the
 * child's own child agents already have their own tag.
 */
export function agentInvocationInputText(
  invocation: Pick<AgentInvocation, "agentType" | "input" | "parentToolCallId">,
): string {
  if (!invocation.parentToolCallId) {
    return invocation.input;
  }
  const typeInstructions = agentTypeInstructions(invocation.agentType);
  return renderTag("parent-agent-task", {}, [
    ...(typeInstructions ? [escapeClosingTags(typeInstructions), ""] : []),
    escapeClosingTags(invocation.input),
  ]);
}

/**
 * A parent agent task or message is the child's instruction. Another input,
 * such as a result of the child's own child agent or an Event, is context.
 */
function agentInvocationProvenance(
  invocation: Pick<AgentInvocation, "parentToolCallId">,
) {
  return invocation.parentToolCallId
    ? agentInstructionProvenance
    : contextProvenance;
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
 * Give queued parent messages to the running agent invocation of a child as
 * steering messages. A message joins only with the Actor and credentials of
 * the running Turn. The first message that does not match stops the scan, so
 * it and every later message wait for the current work. Each message that
 * joins ends as `steered`, and the running agent invocation reports for it.
 */
function createAgentMessageSteeringDrain(
  context: ConversationWorkerContext,
  running: AgentInvocation,
) {
  const turnId = getAgentInvocationTurnId(running.invocationId);
  return async (
    accept: (messages: AgentSteeringMessage[]) => Promise<void>,
  ): Promise<AgentSteeringMessage[]> => {
    const accepted: AgentSteeringMessage[] = [];
    await context.attempt.drain(
      async (pending) => {
        const readIds: string[] = [];
        const joining: AgentInvocation[] = [];
        for (const message of pending) {
          const metadata = agentInvocationMailboxMetadataSchema.safeParse(
            message.input.metadata,
          );
          if (!metadata.success) {
            continue;
          }
          const candidate = await getAgentInvocation(
            metadata.data.agentInvocationId,
          );
          // Only a parent task or message steers. A grandchild result or a
          // watch event starts its own agent invocation.
          if (
            !candidate?.parentToolCallId ||
            candidate.invocationId === running.invocationId
          ) {
            continue;
          }
          if (isTerminalAgentInvocation(candidate)) {
            // An earlier drain marked this message but did not acknowledge it.
            if (candidate.parentMailboxStatus === "steered") {
              readIds.push(message.inboundMessageId);
            }
            continue;
          }
          if (
            !sameActorIdentity(candidate.actor, running.actor) ||
            !isDeepStrictEqual(
              candidate.credentialContext,
              running.credentialContext,
            )
          ) {
            break;
          }
          joining.push(candidate);
          readIds.push(message.inboundMessageId);
        }
        if (joining.length === 0) {
          return readIds;
        }
        // An earlier drain can save a message in the Turn and then fail
        // before it marks the agent invocation. Do not give it to the Turn
        // again.
        const saved =
          (await getTurnRecord(running.childConversationId, turnId))
            ?.piMessages ?? [];
        const messages = withoutSavedSteeringMessages(
          saved,
          joining.map(
            (candidate): AgentSteeringMessage => ({
              kind: "runtime",
              provenance: agentInvocationProvenance(candidate),
              text: agentInvocationInputText(candidate),
              timestampMs: candidate.createdAtMs,
            }),
          ),
          buildSteeringPiMessage,
        );
        // The Turn saves the messages before they are marked.
        if (messages.length > 0) {
          await accept(messages);
          accepted.push(...messages);
        }
        for (const candidate of joining) {
          const terminal = await markAgentInvocationSteered(
            candidate.invocationId,
          );
          if (terminal && isTerminalAgentInvocation(terminal)) {
            await recordSubagentEnded(terminal);
          }
        }
        return readIds;
      },
      { deferred: true },
    );
    return accepted;
  };
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
    case "completed":
      return {
        finishedAtMs,
        outcome: terminal.result.trim() ? "success" : "no_reply",
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
  options: { reportNow?: boolean; resumeLostWorker?: boolean } = {},
): Promise<AgentInvocation | undefined> {
  const { resumeLostWorker, ...completeOptions } = options;
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
  const result = getTerminalAssistantMessages(turn.piMessages)
    .map(getAssistantReplyText)
    .filter((text): text is string => text !== undefined)
    .join("\n\n");
  const failed = turn.state !== "completed" || Boolean(turn.errorMessage);
  // Read the report only from this Turn. A Turn record without a start index
  // cannot tell this Turn from earlier history of a named child.
  const blocked =
    turn.turnStartMessageIndex === undefined
      ? undefined
      : readBlockedReport(turn.piMessages.slice(turn.turnStartMessageIndex));
  return await completeAgentInvocation({
    ...completeOptions,
    invocationId: invocation.invocationId,
    ...(failed
      ? {
          errorMessage: turn.errorMessage ?? "Agent invocation failed",
          status: "failed" as const,
        }
      : blocked
        ? {
            errorMessage: blocked.missing,
            status: "blocked" as const,
          }
        : {
            result,
            status: "completed" as const,
          }),
  });
}

/**
 * End every running or paused agent invocation of a child before other work
 * opens a Turn there, so the child has one open Turn. A saved finished Turn
 * gives its result. Every other one fails with `errorMessage`, because the
 * newer work does not continue its task. Each reports on its own.
 */
export async function endActiveAgentInvocations(
  conversationId: string,
  options: {
    enqueueResult?: (invocation: TerminalAgentInvocation) => Promise<void>;
    errorMessage: string;
    exceptInvocationId?: string;
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
      (await projectTerminalTurn(active, { reportNow: true })) ??
      (await completeAgentInvocation({
        invocationId: active.invocationId,
        errorMessage: options.errorMessage,
        reportNow: true,
        status: "failed",
      }));
    if (terminal && isTerminalAgentInvocation(terminal)) {
      await persistTerminalLifecycle(terminal);
      await recordSubagentEnded(terminal);
      await options.enqueueResult?.(terminal);
    }
  }
}

/**
 * End every agent invocation of a child whose last attempt lost its worker and
 * whose input reached the child's mailbox. The worker ran no failure path, and
 * the stop drops the mailbox, so none of them can run. The heartbeat sends
 * each result.
 */
export async function endAgentInvocationsOfStoppedWork(
  conversationId: string,
  inboundMessageIds: readonly string[],
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
      (await projectTerminalTurn(invocation, { reportNow: true })) ??
      (await completeAgentInvocation({
        invocationId: invocation.invocationId,
        errorMessage: "This task stopped because its worker failed repeatedly.",
        reportNow: true,
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
  if (args.invocation.parentToolCallId) {
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
  const terminal = await completeAgentInvocation({
    invocationId: args.invocation.invocationId,
    ...(failed
      ? {
          errorMessage:
            args.result.diagnostics.errorMessage ?? "Agent invocation failed",
          status: "failed" as const,
        }
      : args.result.blocked
        ? {
            errorMessage: args.result.blocked.missing,
            status: "blocked" as const,
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
  return agentInvocationTurnEnd(terminal);
}

/**
 * Build the invocation consumer that advances work through the shared runner.
 * `enqueueResult` sends each terminal result to the parent mailbox. Omit it
 * only where the parent has no mailbox, such as the local CLI.
 * `maxAgentDepth` is the number of child agent levels that can start their
 * own child agents. The default, 0, lets only the root start child agents.
 */
export function createAgentInvocationWorker(
  agentRunner: AgentRunner,
  options: {
    enqueueResult?: (invocation: TerminalAgentInvocation) => Promise<void>;
    maxAgentDepth?: number;
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
    // Report the result before ack so a failed parent append retries this work.
    const report = async (terminal: TerminalAgentInvocation): Promise<void> => {
      await recordSubagentEnded(terminal);
      await options.enqueueResult?.(terminal);
    };
    const finish = async (
      terminal: AgentInvocation | undefined,
    ): Promise<void> => {
      if (!terminal || !isTerminalAgentInvocation(terminal)) {
        return;
      }
      // A `steered` agent invocation never started a Turn.
      if (terminal.parentMailboxStatus !== "steered") {
        await persistTerminalLifecycle(terminal);
      }
      await report(terminal);
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
        await completeAgentInvocation({
          invocationId,
          errorMessage: "Agent invocation was stopped",
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
        resumeLostWorker: true,
      });
      if (projected && isTerminalAgentInvocation(projected)) {
        await finish(projected);
        await acknowledge();
        return { status: "completed" };
      }
      // A child has one open Turn. End every other open agent invocation and
      // a person's open Turn in a Thread first.
      await endActiveAgentInvocations(invocation.childConversationId, {
        enqueueResult: options.enqueueResult,
        errorMessage:
          "This task was not resumed. Newer work for this child agent started, so this task ended without a result.",
        exceptInvocationId: invocation.invocationId,
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
      const terminal = await completeAgentInvocation({
        invocationId: invocation.invocationId,
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
          state: {
            sandboxRef,
          },
          durability: {
            drainSteeringMessages: createAgentMessageSteeringDrain(
              context,
              invocation,
            ),
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
            invocation,
            result,
            sandboxRef,
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
        const terminal = await completeAgentInvocation({
          invocationId: invocation.invocationId,
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
      const terminal = await completeAgentInvocation({
        invocationId: invocation.invocationId,
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
      const terminal = await completeAgentInvocation({
        invocationId: invocation.invocationId,
        errorMessage: `Agent invocation requires ${outcome.providerDisplayName} authorization`,
        status: "blocked",
      });
      await finish(terminal);
      await acknowledge();
      return { status: "completed" };
    }

    // executeTurn already recorded the terminal Turn; only report the result.
    let terminal = await getAgentInvocation(invocation.invocationId);
    // A stop that comes after the save still stops the child agents of this
    // child. Then they cannot report for a `replaced` result, so this result
    // reports now.
    if (stopSignal?.aborted) {
      if (
        terminal &&
        isTerminalAgentInvocation(terminal) &&
        terminal.parentMailboxStatus === "replaced"
      ) {
        terminal = await reportReplacedAgentInvocation(terminal.invocationId);
      }
      await stopChildAgentsOf(context.conversationId);
    }
    if (terminal && isTerminalAgentInvocation(terminal)) {
      await report(terminal);
    }
    await acknowledge();
    return { status: "completed" };
  };
}
