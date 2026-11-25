// One invocation of the Turn engine runs one step: claim the Turn, run the
// step on the stored history, then commit it and send the next step, or end
// the Turn. A write that loses its lease changes nothing, so the invocation
// stops and the new lease holder owns the Turn. While the step runs, the
// invocation checks its lease and aborts the step when the lease is lost.
// When the invocation throws, it queues the Turn again for the queue's retry.
// A model request that fails in a way that can work later queues the Turn
// again too, with a step message after a backoff. Both count toward
// `maxAttempts`: the queue retries without a limit, so a claim past it fails
// the Turn instead of running the step again. After every change it makes to
// the Turn, and on a message whose claim misses, it runs `reconcileTurn`, which
// sends the delivery message and the next step message that the stored
// state calls for.
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { logException, logWarn } from "@/chat/logging";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import type { EngineContext } from "@/core/engine-context";
import type { ModelClient, ModelSettings } from "@/core/model/client";
import {
  ModelRequestError,
  modelFailureAttributes,
  type ModelFailure,
} from "@/core/model/failure";
import { assemblePrompt } from "@/core/prompt/assemble";
import type { PromptLayout } from "@/core/prompt/layout";
import { setActiveSpanAttributes } from "@/core/telemetry";
import type { StepTools } from "@/core/tool";
import {
  findTurnInputs,
  findUnreadInputs,
  markInputsAttempted,
  type TurnInputRecord,
  type UnreadInput,
} from "@/core/turn/inbox";
import { publishTurnStep } from "@/core/turn/queue";
import { endFailedTurn, reconcileTurn } from "@/core/turn/schedule";
import {
  claimTurn,
  commitStep,
  holdsLease,
  releaseTurn,
  type ClaimedTurn,
  type TurnFailure,
  type TurnLease,
} from "@/core/turn/state";
import { runStep } from "@/core/turn/step";

// How often a running step checks that its lease still holds. A cancel or a
// takeover stops the step's model request and tools within this time.
const LEASE_CHECK_INTERVAL_MS = 1_000;

/** What the host gives `advanceTurn` to run a step. */
export type AdvanceTurnOptions = {
  client: ModelClient;
  /**
   * Gives the prompt layout of the claimed Turn, which says how core builds
   * the prompt of each model request: the system prompt, and the messages
   * after the history, with the unread inputs where its `inputs()` fragment
   * is. Only a model request calls it.
   */
  prompt: (turn: ClaimedTurn) => Promise<PromptLayout>;
  /** Gives the model settings of the claimed Turn, at each step. */
  modelSettings: (turn: ClaimedTurn) => Promise<ModelSettings>;
  /**
   * Gives the tools of one step of the claimed Turn, from the Turn and all of
   * its inputs. Core closes them when the step ends.
   */
  tools: (turn: ClaimedTurn, inputs: TurnInputRecord[]) => Promise<StepTools>;
  /**
   * Caps the tries of one step, both the retries of a failed invocation and
   * of a failed model request. A commit resets `attempts`, so the cap does
   * not limit the steps of a Turn.
   */
  maxAttempts: number;
};

/**
 * Runs the next step of a Turn. It does nothing when the Turn cannot be
 * claimed, for example after a duplicate message or when the Turn has ended.
 */
export async function advanceTurn(
  {
    executor,
    queue,
    owner,
    leaseMs,
  }: Pick<EngineContext, "executor" | "queue" | "owner" | "leaseMs">,
  message: { turnId: string },
  options: AdvanceTurnOptions,
): Promise<void> {
  const claim = await claimTurn({ executor, owner, leaseMs }, message.turnId);
  if (!claim) {
    // A crash after a commit can lose what follows it. It is safe to repeat.
    await reconcileTurn({ executor, queue }, message.turnId);
    return;
  }
  try {
    // Inside the try, so a failed write here also releases the lease. After
    // the Turn ends, the release matches nothing, so an error in
    // reconcileTurn only makes the queue retry, and that retry runs it again.
    // An attempt takes the inputs that are unread when it claims the Turn. A
    // failed Turn drops them, and moves only inputs that came after its last
    // claim.
    const unread = await findUnreadInputs({ executor }, claim.turnId);
    await markInputsAttempted(
      { executor },
      unread.map((input) => input.inputId),
    );
    if (claim.attempts > options.maxAttempts) {
      if (
        await endFailedTurn({ executor }, claim, "attempts_exhausted", {
          failureCode: "agent_run_failed",
        })
      ) {
        await reconcileTurn({ executor, queue }, claim.turnId);
      }
      return;
    }
    await runClaimedStep({ executor, queue }, claim, unread, options);
  } catch (error) {
    // The queue retries the message. With a live lease, the retry would claim
    // nothing and the Turn would stay running.
    try {
      await releaseTurn({ executor }, claim);
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
  { executor, queue }: Pick<EngineContext, "executor" | "queue">,
  claim: ClaimedTurn,
  unread: UnreadInput[],
  {
    client,
    prompt,
    modelSettings,
    tools,
    maxAttempts,
  }: Pick<
    AdvanceTurnOptions,
    "client" | "prompt" | "modelSettings" | "tools" | "maxAttempts"
  >,
): Promise<void> {
  const events = await createSqlConversationEventStore(
    executor,
  ).loadCurrentHistory(claim.conversationId);
  setActiveSpanAttributes({
    "app.turn.step_seq": claim.stepSeq,
    "gen_ai.conversation.id": claim.conversationId,
  });
  const history = projectConversationEvents(events).messages;
  const stepTools = await tools(
    claim,
    await findTurnInputs({ executor }, claim.turnId),
  );
  const step = await whileLeased({ executor }, claim, (signal) =>
    runStep({
      history,
      // Only a model request picks and builds the prompt and reads the model
      // settings. A tool batch must follow its tool calls, so the inputs wait
      // for the model request after the batch.
      request: async () => ({
        ...(await assemblePrompt(
          await prompt(claim),
          { turn: claim, history, inputs: unread },
          { signal },
        )),
        model: await modelSettings(claim),
      }),
      tools: stepTools.definitions,
      beforeCalls: stepTools.beforeCalls,
      client,
      session: claim.conversationId,
      // A later claim of the same step means an earlier attempt did not
      // commit.
      replay: claim.attempts > 1,
      // Tool calls pending at a Turn's first step belong to an earlier Turn.
      skipDanglingToolCalls: claim.stepSeq === 0,
      signal,
    }),
  ).finally(() => stepTools.close());
  if (!step) {
    return;
  }
  const { result, newMessages } = step;
  switch (result.outcome) {
    case "continue":
    case "completed": {
      if (await commitStep({ executor }, claim, result, newMessages)) {
        await reconcileTurn({ executor, queue }, claim.turnId);
      }
      return;
    }
    case "failed": {
      const delayMs = modelRetryDelayMs(
        result.failure,
        claim.attempts,
        maxAttempts,
      );
      if (delayMs !== undefined) {
        // A crash between the release and the publish leaves the Turn queued
        // with no message, and the sweep sends it again. A superseded Turn
        // ends at the release; its delayed message then misses the claim and
        // sends the next Turn's step.
        if (await releaseTurn({ executor }, claim)) {
          await publishTurnStep({ queue }, claim.turnId, { delayMs });
          logWarn("agent.turn.provider.retrying", {
            ...modelFailureAttributes(result.failure),
            "app.ai.provider_error.retry_attempt": claim.attempts,
            "app.turn.id": claim.turnId,
          });
        }
        return;
      }
      // The capture comes before the commit. A crash between the two runs
      // the step again, so a failure that repeats is captured twice.
      const failure = captureModelFailure(result.failure);
      if (
        await endFailedTurn(
          { executor },
          claim,
          result.failure.message,
          failure,
        )
      ) {
        await reconcileTurn({ executor, queue }, claim.turnId);
      }
      return;
    }
    default: {
      const unhandled: never = result;
      throw new Error(`Unhandled step result: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Main's provider backoff: 2 s, 4 s, 8 s, before jitter. With jitter, the
// longest wait is 90 s, well inside the sweep's stale window.
const MODEL_RETRY_BASE_DELAY_MS = 2_000;
const MODEL_RETRY_MAX_DELAY_MS = 60_000;

/**
 * The wait before the step runs again after a failed model request, or
 * undefined when the failure ends the Turn: it cannot work later, or the
 * step has used its last try.
 */
function modelRetryDelayMs(
  failure: ModelFailure,
  attempts: number,
  maxAttempts: number,
): number | undefined {
  if (!failure.retryable || attempts >= maxAttempts) {
    return undefined;
  }
  const backoffMs = MODEL_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1);
  const delayMs = Math.min(
    MODEL_RETRY_MAX_DELAY_MS,
    Math.max(backoffMs, failure.retryAfterMs ?? 0),
  );
  // Turns that fail together in a provider outage would all come back at the
  // same moment. Jitter spreads them, and only adds, so a retry never comes
  // before the provider's Retry-After. It applies after the cap, or every
  // capped retry would land at once.
  return delayMs * (1 + Math.random() / 2);
}

/**
 * Reports a failed model request to Sentry under main's event name, and
 * returns the failure details that `endFailedTurn` stores.
 */
function captureModelFailure(failure: ModelFailure): TurnFailure {
  const eventId = logException(
    new ModelRequestError(failure),
    "agent.turn.provider_error",
    {
      ...modelFailureAttributes(failure),
      "app.ai.failure_reason": failure.kind,
    },
  );
  if (!eventId) {
    throw new Error("Sentry did not return an event ID for a model failure");
  }
  return {
    failureCode: "model_execution_failed",
    failureReason: failure.kind,
    eventId,
  };
}

/**
 * Runs `run`, the step and the prompt it builds, and aborts its signal when a
 * check finds that the lease is lost. Undefined when it stopped for that
 * reason: the new lease holder or the cancel owns the Turn, so this
 * invocation writes nothing.
 */
async function whileLeased<T>(
  { executor }: Pick<EngineContext, "executor">,
  lease: TurnLease,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const abort = new AbortController();
  let checking = false;
  let failureLogged = false;
  const check = async () => {
    if (checking || abort.signal.aborted) {
      return;
    }
    checking = true;
    try {
      if (!(await holdsLease({ executor }, lease))) {
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
    return await run(abort.signal);
  } catch (error) {
    // runStep and assemblePrompt throw the abort reason when their signal
    // aborts. Another error after an abort may be a bug, but the lease is
    // lost, so it is only logged.
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
