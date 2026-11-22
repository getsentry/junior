// One invocation of the Turn engine runs one step: claim the Turn, run the
// step on the stored history, then commit it and send the next step, or end
// the Turn. A write that loses its lease changes nothing, so the invocation
// stops and the new lease holder owns the Turn. While the step runs, the
// invocation checks its lease and aborts the step when the lease is lost.
// When the invocation throws, it queues the Turn again for the queue's retry.
// The queue retries without a limit, so a claim past `maxAttempts` fails the
// Turn instead of running the step again. After each step commit it sends
// the Turn's delivery message, and after each end commit it runs the Turn's
// end work. A message whose claim misses does both again.
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { logException } from "@/chat/logging";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { stepCommitted } from "@/core/delivery/deliver";
import type { ModelClient } from "@/core/model/client";
import { setActiveSpanAttributes } from "@/core/telemetry";
import {
  findUnreadInputs,
  markInputsAttempted,
  type InputMessage,
  type UnreadInput,
} from "@/core/turn/inbox";
import { publishTurnStep } from "@/core/turn/queue";
import { turnEnded } from "@/core/turn/schedule";
import {
  claimTurn,
  commitStep,
  failTurn,
  holdsLease,
  releaseTurn,
  type ClaimedTurn,
  type TurnLease,
} from "@/core/turn/state";
import {
  hasPendingToolCalls,
  runStep,
  type StepInput,
  type StepResult,
} from "@/core/turn/step";
import type { JuniorSqlDatabase } from "@/db/db";

// How often a running step checks that its lease still holds. A cancel or a
// takeover stops the step's model request and tools within this time.
const LEASE_CHECK_INTERVAL_MS = 1_000;

/** The parts of a step's input that do not come from the Turn's history. */
export type PreparedStep = Omit<
  StepInput,
  | "client"
  | "messages"
  | "replay"
  | "session"
  | "signal"
  | "skipDanglingToolCalls"
>;

type AdvanceTurnOptions = {
  client: ModelClient;
  /**
   * Builds the system prompt, tools and model settings for the claimed Turn,
   * and turns each unread input into a user message with its provenance,
   * such as instruction authority for the Actor who sent it. It must return
   * every input it gets, once, in the order the step reads them. It gets no
   * inputs when the step runs tool calls.
   */
  prepare: (
    turn: ClaimedTurn,
    inputs: UnreadInput[],
  ) => Promise<PreparedStep & { inputs: InputMessage[] }>;
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
    // The Turn may have ended without its end work or its delivery message,
    // for example in a crash after the end commit. Both are safe to repeat.
    await stepCommitted(executor, message.turnId);
    await turnEnded(executor, message.turnId);
    return;
  }
  try {
    // Inside the try, so a failed write here also releases the lease. After
    // the Turn ends, the release matches nothing, so an error in the end
    // work only makes the queue retry, and that retry runs it again.
    // An attempt takes the inputs that are unread when it claims the Turn. A
    // failed Turn drops them, and moves only inputs that came after its last
    // claim.
    const unread = await findUnreadInputs(executor, claim.turnId);
    await markInputsAttempted(
      executor,
      unread.map((input) => input.inputId),
    );
    if (claim.attempts > options.maxAttempts) {
      if (await failTurn(executor, claim, "attempts_exhausted")) {
        await turnEnded(executor, claim.turnId);
      }
      return;
    }
    await runClaimedStep(executor, claim, unread, options);
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
  unread: UnreadInput[],
  { client, prepare }: Pick<AdvanceTurnOptions, "client" | "prepare">,
): Promise<void> {
  const events = await createSqlConversationEventStore(
    executor,
  ).loadCurrentHistory(claim.conversationId);
  setActiveSpanAttributes({
    "app.turn.step_seq": claim.stepSeq,
    "gen_ai.conversation.id": claim.conversationId,
  });
  const history = projectConversationEvents(events).messages;
  // A tool batch must follow its tool calls, so only a model request reads
  // inputs. The inputs wait for the model request after the batch.
  const stepInputs = hasPendingToolCalls(history) ? [] : unread;
  const { inputs, ...prepared } = await prepare(claim, stepInputs);
  checkPreparedInputs(stepInputs, inputs);
  const result = await runStepWhileLeased(executor, claim, {
    ...prepared,
    client,
    session: claim.conversationId,
    messages: [...history, ...inputs.map((input) => input.message)],
    // A later claim of the same step means an earlier attempt did not commit.
    replay: claim.attempts > 1,
    // Tool calls pending at a Turn's first step belong to an earlier Turn.
    skipDanglingToolCalls: claim.stepSeq === 0,
  });
  if (!result) {
    return;
  }
  switch (result.outcome) {
    case "continue":
    case "completed": {
      const next = await commitStep(executor, claim, result, inputs);
      if (next) {
        await stepCommitted(executor, claim.turnId);
      }
      if (next === "continue") {
        await publishTurnStep(claim.turnId);
      } else if (next === "completed") {
        await turnEnded(executor, claim.turnId);
      }
      return;
    }
    case "failed":
      if (await failTurn(executor, claim, result.error)) {
        await turnEnded(executor, claim.turnId);
      }
      return;
    default: {
      const unhandled: never = result;
      throw new Error(`Unhandled step result: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Throws unless `prepare` returned each unread input exactly once. */
function checkPreparedInputs(
  unread: UnreadInput[],
  prepared: InputMessage[],
): void {
  const expected = new Set(unread.map((input) => input.inputId));
  const returned = prepared.map((input) => input.inputId);
  if (
    returned.length !== expected.size ||
    new Set(returned).size !== returned.length ||
    returned.some((inputId) => !expected.has(inputId))
  ) {
    throw new Error(
      `prepare must return each unread input once: expected [${[...expected].join(", ")}], got [${returned.join(", ")}]`,
    );
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
    // runStep throws the abort reason when its signal aborts. Another error
    // after an abort may be a bug, but the lease is lost, so it is only
    // logged.
    if (abort.signal.aborted) {
      if (error !== abort.signal.reason) {
        logException(error, "turn.step.error_after_abort", {
          "app.turn.id": lease.turnId,
        });
      }
      return undefined;
    }
    throw error;
  } finally {
    clearInterval(timer);
  }
}
