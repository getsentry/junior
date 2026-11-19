// One invocation of the Turn engine runs one step: claim the Turn, run the
// step on the stored history, then commit it and send the next step, or end
// the Turn. A write that loses its lease changes nothing, so the invocation
// stops and the new lease holder owns the Turn. While the step runs, the
// invocation checks its lease and aborts the step when the lease is lost.
// When the invocation throws, it queues the Turn again for the queue's retry.
// The queue retries without a limit, so a claim past `maxAttempts` fails the
// Turn instead of running the step again.
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { logException } from "@/chat/logging";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { setActiveSpanAttributes } from "@/core/telemetry";
import { publishTurnStep } from "@/core/turn/queue";
import {
  claimTurn,
  commitStep,
  failTurn,
  holdsLease,
  releaseTurn,
  type ClaimedTurn,
  type TurnLease,
} from "@/core/turn/state";
import { runStep, type StepInput, type StepResult } from "@/core/turn/step";
import type { JuniorSqlDatabase } from "@/db/db";

// How often a running step checks that its lease still holds. A cancel or a
// takeover stops the step's model request and tools within this time.
const LEASE_CHECK_INTERVAL_MS = 1_000;

/** The parts of a step's input that do not come from the Turn's history. */
export type PreparedStep = Omit<StepInput, "messages" | "replay" | "signal">;

type AdvanceTurnOptions = {
  /** Builds the system prompt, tools and model for the claimed Turn. */
  prepare: (turn: ClaimedTurn) => Promise<PreparedStep>;
  /** Names the invocation that holds the lease. */
  owner: string;
  leaseMs: number;
  /**
   * Caps the tries of one step. A commit resets `attempts`, so the cap does
   * not limit the steps of a Turn.
   */
  maxAttempts: number;
};

/**
 * Runs the next step of a Turn. It does nothing when the Turn cannot be
 * claimed, for example after a duplicate message or when the Turn has ended.
 */
export async function advanceTurn(
  executor: JuniorSqlDatabase,
  message: { turnId: string },
  options: AdvanceTurnOptions,
): Promise<void> {
  const claim = await claimTurn(executor, {
    turnId: message.turnId,
    owner: options.owner,
    leaseMs: options.leaseMs,
  });
  if (!claim) {
    return;
  }
  if (claim.attempts > options.maxAttempts) {
    await failTurn(executor, claim, "attempts_exhausted");
    return;
  }
  try {
    await runClaimedStep(executor, claim, options.prepare);
  } catch (error) {
    // The queue retries the message. With a live lease, the retry would claim
    // nothing and the Turn would stay running.
    try {
      await releaseTurn(executor, claim);
    } catch (releaseError) {
      // The first error caused the failure, so it reaches the caller. The
      // lease expires, and then a retry can claim the Turn.
      logException(releaseError, "turn.release.failed", {
        "app.turn.id": claim.turnId,
      });
    }
    throw error;
  }
}

async function runClaimedStep(
  executor: JuniorSqlDatabase,
  claim: ClaimedTurn,
  prepare: AdvanceTurnOptions["prepare"],
): Promise<void> {
  const events = await createSqlConversationEventStore(
    executor,
  ).loadCurrentHistory(claim.conversationId);
  setActiveSpanAttributes({
    "app.turn.step_seq": claim.stepSeq,
    "gen_ai.conversation.id": claim.conversationId,
  });
  const prepared = await prepare(claim);
  const result = await runStepWhileLeased(executor, claim, {
    ...prepared,
    messages: projectConversationEvents(events).messages,
    // A later claim of the same step means an earlier attempt did not commit.
    replay: claim.attempts > 1,
  });
  if (!result) {
    return;
  }
  switch (result.outcome) {
    case "continue":
      if (await commitStep(executor, claim, result)) {
        await publishTurnStep(claim.turnId);
      }
      return;
    case "completed":
      await commitStep(executor, claim, result);
      return;
    case "failed":
      await failTurn(executor, claim, result.error);
      return;
    default: {
      const unhandled: never = result;
      throw new Error(`Unhandled step result: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Runs the step, and aborts it when a check finds that the lease is lost.
 * Undefined when the step stopped for that reason: the new lease holder or
 * the cancel owns the Turn, so this invocation writes nothing.
 */
async function runStepWhileLeased(
  executor: JuniorSqlDatabase,
  lease: TurnLease,
  input: Omit<StepInput, "signal">,
): Promise<StepResult | undefined> {
  const abort = new AbortController();
  let checking = false;
  let failureLogged = false;
  const check = async () => {
    if (checking || abort.signal.aborted) {
      return;
    }
    checking = true;
    try {
      if (!(await holdsLease(executor, lease))) {
        abort.abort(new Error("The Turn was cancelled or taken over"));
      }
    } catch (error) {
      // A failed check proves nothing about the lease, so the step goes on.
      // The commit fence still discards it if the lease is lost.
      if (!failureLogged) {
        failureLogged = true;
        logException(error, "turn.lease_check.failed", {
          "app.turn.id": lease.turnId,
        });
      }
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), LEASE_CHECK_INTERVAL_MS);
  timer.unref?.();
  try {
    return await runStep({ ...input, signal: abort.signal });
  } catch (error) {
    // runStep throws when its signal aborts.
    if (abort.signal.aborted) {
      return undefined;
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
}
