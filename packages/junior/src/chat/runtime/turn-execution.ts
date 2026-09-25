import type { AgentRun } from "@/chat/agent/types";
import type {
  CompleteConversationTurnInput,
  FailConversationTurnInput,
} from "@/chat/conversations/turn-lifecycle";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore } from "@/chat/db";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import {
  runAgentWithTimeout,
  type AgentRunner,
} from "@/chat/runtime/agent-runner";
import type { AgentRunResult } from "@/chat/services/turn-result";

type SavedTurnResult =
  | {
      finishedAtMs?: number;
      outcome: CompleteConversationTurnInput["outcome"];
    }
  | {
      eventId?: string;
      finishedAtMs?: number;
      failureCode: FailConversationTurnInput["failureCode"];
      failureReason?: FailConversationTurnInput["failureReason"];
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
 * A timeout aborts the Run before this function reports the failure.
 */
export async function executeTurn(
  agentRunner: AgentRunner,
  run: AgentRun,
  saveResult: (result: AgentRunResult) => Promise<SavedTurnResult>,
  timeoutMs?: number,
): Promise<TurnExecutionOutcome> {
  let outcome: AgentRunOutcome;
  try {
    outcome = await runAgentWithTimeout(agentRunner, run, timeoutMs);
  } catch (error) {
    throw new AgentRunError(error);
  }
  if (outcome.status !== "completed") {
    return outcome;
  }

  const saved = await saveResult(outcome.result);
  const lifecycle = new ConversationTurnLifecycleService(
    getConversationEventStore(),
  );
  const common = {
    conversationId: run.conversationId,
    createdAtMs: saved.finishedAtMs ?? Date.now(),
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
    });
  } else {
    await lifecycle.complete({
      ...common,
      outcome: saved.outcome,
    });
  }

  return { status: "completed" };
}

/** Run the agent and finish a Turn after its caller saves the result. */
export type ExecuteTurn = (
  run: AgentRun,
  saveResult: (result: AgentRunResult) => Promise<SavedTurnResult>,
  timeoutMs?: number,
) => Promise<TurnExecutionOutcome>;
