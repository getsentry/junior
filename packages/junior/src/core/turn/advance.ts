// One invocation of the Turn engine runs one step: claim the Turn, run the
// step on the stored history, then commit it and send the next step, or end
// the Turn. A write that loses its lease changes nothing, so the invocation
// stops and the new lease holder owns the Turn.
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { setActiveSpanAttributes } from "@/core/telemetry";
import { publishTurnStep } from "@/core/turn/queue";
import {
  claimTurn,
  commitStep,
  failTurn,
  type ClaimedTurn,
} from "@/core/turn/state";
import { runStep, type StepInput } from "@/core/turn/step";
import type { JuniorSqlDatabase } from "@/db/db";

/** The parts of a step's input that do not come from the Turn's history. */
export type PreparedStep = Omit<StepInput, "messages" | "replay" | "signal">;

type AdvanceTurnOptions = {
  /** Builds the system prompt, tools and model for the claimed Turn. */
  prepare: (turn: ClaimedTurn) => Promise<PreparedStep>;
  /** Names the invocation that holds the lease. */
  owner: string;
  leaseMs: number;
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
  const events = await createSqlConversationEventStore(
    executor,
  ).loadCurrentHistory(claim.conversationId);
  setActiveSpanAttributes({
    "app.turn.step_seq": claim.stepSeq,
    "gen_ai.conversation.id": claim.conversationId,
  });
  const prepared = await options.prepare(claim);
  const result = await runStep({
    ...prepared,
    messages: projectConversationEvents(events).messages,
    // A later claim of the same step means an earlier attempt did not commit.
    replay: claim.attempts > 1,
    // Nothing aborts a step yet. The next change adds the cancel poll.
    signal: new AbortController().signal,
  });
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
