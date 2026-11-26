import type { AgentRun } from "@/chat/agent/types";
import { parentResultActor } from "@/chat/child-agents/parent-result";
import type {
  CompleteConversationTurnInput,
  ConversationTurnLifecycle,
  FailConversationTurnInput,
} from "@/chat/conversations/turn-lifecycle";
import { getTurnLifecycle } from "@/chat/conversations/turn-lifecycle";

import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { AgentRunResult } from "@/chat/services/turn-result";

/** How a Turn ends after its result is saved. */
export type SavedTurnResult =
  | {
      answer?: CompleteConversationTurnInput["answer"];
      finishedAtMs?: number;
      outcome: CompleteConversationTurnInput["outcome"];
    }
  | {
      eventId?: string;
      finishedAtMs?: number;
      failureCode: FailConversationTurnInput["failureCode"];
      failureReason?: FailConversationTurnInput["failureReason"];
      failureText?: FailConversationTurnInput["failureText"];
      outcome: "failed";
    };

type TurnExecutionOutcome =
  | Exclude<AgentRunOutcome, { status: "completed" }>
  | { status: "completed" };

/** An error thrown while the agent advances a Run. */
export class AgentRunError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Agent Run failed", {
      cause,
    });
    this.name = "AgentRunError";
  }
}

/**
 * Run the agent and finish the Turn after the caller saves its result.
 *
 * A paused Run, or a Run waiting for authorization, leaves the Turn open. A
 * save error also leaves the Turn open so the worker can retry or recover it.
 * `lifecycle` records the end and sends its agent update.
 */
export async function executeTurn(
  agentRunner: AgentRunner,
  run: AgentRun,
  saveResult: (result: AgentRunResult) => Promise<SavedTurnResult>,
  lifecycle: ConversationTurnLifecycle = getTurnLifecycle(),
): Promise<TurnExecutionOutcome> {
  let outcome: AgentRunOutcome;
  try {
    outcome = await agentRunner.run(run);
  } catch (error) {
    throw new AgentRunError(error);
  }
  if (outcome.status !== "completed") {
    return outcome;
  }

  const saved = await saveResult(outcome.result);
  await finishTurn(lifecycle, run, saved);
  return { status: "completed" };
}

// Record the terminal lifecycle event of a Turn from its saved result. The
// update of a child's Turn reaches its starter as the Turn's Actor.
async function finishTurn(
  lifecycle: ConversationTurnLifecycle,
  run: AgentRun,
  saved: SavedTurnResult,
): Promise<void> {
  const common = {
    conversationId: run.conversationId,
    createdAtMs: saved.finishedAtMs ?? Date.now(),
    ...(run.actor
      ? { reportAs: parentResultActor(run.actor, run.source.kind) }
      : undefined),
    turnId: run.turnId,
  };
  if (saved.outcome === "failed") {
    await lifecycle.fail({
      ...common,
      ...(saved.eventId ? { eventId: saved.eventId } : undefined),
      failureCode: saved.failureCode,
      ...(saved.failureReason
        ? { failureReason: saved.failureReason }
        : undefined),
      ...(saved.failureText ? { failureText: saved.failureText } : undefined),
    });
  } else {
    await lifecycle.complete({
      ...common,
      ...(saved.answer ? { answer: saved.answer } : undefined),
      outcome: saved.outcome,
    });
  }
}

/** Run the agent and finish a Turn after its caller saves the result. */
export type ExecuteTurn = (
  run: AgentRun,
  saveResult: (result: AgentRunResult) => Promise<SavedTurnResult>,
) => Promise<TurnExecutionOutcome>;
