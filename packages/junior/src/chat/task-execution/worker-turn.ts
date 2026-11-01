/**
 * Run one Turn under the conversation lease. Root mailbox work and child agent
 * invocation work both use this lifecycle, so they ack, stop, retry, and fail
 * the same way. Each work owner supplies its own steps.
 */
import type { AgentRun } from "@/chat/agent/types";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  getConversationTurnBoundaryError,
  isTurnInputCommitLostError,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import {
  AgentRunError,
  executeTurn,
  type SavedTurnResult,
} from "@/chat/runtime/turn-execution";
import { isTurnExecutionLimitExceededError } from "@/chat/services/turn-limit";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";

/**
 * The Run of a prepared Turn. The lifecycle adds the stop signal, the input
 * acknowledgement, and the yield check.
 */
export interface PreparedWorkerTurn {
  run: AgentRun;
  saveResult(result: AgentRunResult): Promise<SavedTurnResult>;
}

/** The steps that one work owner supplies to `runWorkerTurn`. */
export interface WorkerTurnSteps {
  /**
   * Start the Turn and read its Run. Return `stopped` when a stop came first.
   * Return `finished` when the work already ended and only the ack is left.
   */
  prepare(): Promise<PreparedWorkerTurn | "finished" | "stopped">;
  /** Record a stopped Turn. The lifecycle acks after this step. */
  stop(): Promise<void>;
  /** Record a Run that paused at a boundary. */
  suspend?(): Promise<void>;
  /** Record a Run that waits for authorization, and say how the attempt ends. */
  awaitAuth(
    outcome: Extract<AgentRunOutcome, { status: "awaiting_auth" }>,
  ): Promise<"completed" | "paused">;
  /** Finish after `executeTurn` recorded the terminal Turn. An error retries. */
  complete(): Promise<void>;
  /** End the Turn on any attempt for an error that a retry cannot fix. Return true when handled. */
  block?(error: unknown): Promise<boolean>;
  /** Record the failure on the last attempt. */
  fail(error: unknown): Promise<void>;
}

function isInputCommitLost(error: unknown): boolean {
  const cause = getConversationTurnBoundaryError(error)?.cause ?? error;
  return isTurnInputCommitLostError(error) || isTurnInputCommitLostError(cause);
}

/**
 * Run one Turn: prepare it, run the agent, and end the attempt. A lost lease
 * returns `lost_lease`. A stop ends the Turn as stopped. Other errors retry,
 * except on the last attempt or for an execution limit, where the Turn fails.
 */
export async function runWorkerTurn(args: {
  agentRunner: AgentRunner;
  context: ConversationWorkerContext;
  /** True when no attempt input needs an ack, such as on a resume. */
  inputCommitted: boolean;
  steps: WorkerTurnSteps;
  stopSignal: AbortSignal | undefined;
}): Promise<ConversationWorkerResult> {
  const { context, steps, stopSignal } = args;
  let acknowledged = args.inputCommitted;
  const acknowledge = async (): Promise<void> => {
    if (acknowledged) {
      return;
    }
    try {
      await context.attempt.ack();
    } catch {
      throw new TurnInputCommitLostError(
        `Conversation work lease lost before mailbox acknowledgement for ${context.conversationId}`,
      );
    }
    acknowledged = true;
  };
  const end = async (
    status: "completed" | "paused" = "completed",
  ): Promise<ConversationWorkerResult> => {
    await acknowledge();
    return { status };
  };

  const advance = async (): Promise<
    ConversationWorkerResult | "completed" | "stopped"
  > => {
    const prepared = await steps.prepare();
    if (prepared === "stopped") {
      return "stopped";
    }
    if (prepared === "finished") {
      return await end();
    }
    const outcome = await executeTurn(
      args.agentRunner,
      {
        ...prepared.run,
        ...(stopSignal ? { signal: stopSignal } : undefined),
        durability: {
          ...prepared.run.durability,
          onInputCommitted: acknowledge,
          shouldYield: context.shouldYield,
        },
      },
      async (result) => {
        // A stop that aborted the Run ends the Turn as stopped. A Run that
        // finished before the stop keeps its result.
        if (result.diagnostics.outcome !== "success") {
          stopSignal?.throwIfAborted();
        }
        return await prepared.saveResult(result);
      },
    );
    if (outcome.status !== "completed" && stopSignal?.aborted) {
      return "stopped";
    }
    if (outcome.status === "suspended") {
      await steps.suspend?.();
      return { status: "yielded" };
    }
    if (outcome.status === "awaiting_auth") {
      return await end(await steps.awaitAuth(outcome));
    }
    return "completed";
  };

  let ended: ConversationWorkerResult | "completed" | "stopped";
  try {
    ended = await advance();
  } catch (error) {
    // A save error has no AgentRunError wrapper. It fails the same way.
    const failure = error instanceof AgentRunError ? error.cause : error;
    if (isInputCommitLost(failure)) {
      return { status: "lost_lease" };
    }
    if (stopSignal?.aborted) {
      ended = "stopped";
    } else if (await steps.block?.(failure)) {
      ended = await end();
    } else if (
      // A retry cannot pass an execution limit, and its Turn record would
      // hide the limit as a lost worker.
      !context.attempt.isFinalAttempt &&
      !isTurnExecutionLimitExceededError(failure)
    ) {
      throw failure;
    } else {
      await steps.fail(failure);
      ended = await end();
    }
  }
  if (typeof ended !== "string") {
    return ended;
  }
  // An error after the Turn ends, or while a stop is recorded, retries the
  // attempt. It must not run the stop or fail step. Those steps would end
  // finished work again and skip its report to the parent.
  try {
    await (ended === "completed" ? steps.complete() : steps.stop());
    return await end();
  } catch (error) {
    if (isInputCommitLost(error)) {
      return { status: "lost_lease" };
    }
    throw error;
  }
}
