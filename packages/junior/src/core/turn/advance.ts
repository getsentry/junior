// One invocation of the Turn engine runs one step: claim the Turn, run the
// step on the stored history, then commit it and send the next step, or end
// the Turn. A write that loses its lease changes nothing, so the invocation
// stops and the new lease holder owns the Turn. While the step runs, the
// invocation checks its lease and aborts the step when the lease is lost.
// When the invocation throws, it queues the Turn again for the queue's retry.
// The queue retries without a limit, so a claim past `maxAttempts` fails the
// Turn instead of running the step again. After every change it makes to the
// Turn, and on a message whose claim misses, it runs `reconcileTurn`, which
// sends the delivery message and the next step message that the stored
// state calls for.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { logException } from "@/chat/logging";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import {
  createAssistantProviderError,
  getProviderErrorAttributes,
} from "@/chat/services/provider-error";
import { requireTurnFailureEventId } from "@/chat/services/turn-failure-response";
import type { EngineContext } from "@/core/engine-context";
import type { ModelClient, ModelSettings } from "@/core/model/client";
import { assemblePrompt } from "@/core/prompt/assemble";
import type { PromptLayout } from "@/core/prompt/layout";
import { setActiveSpanAttributes } from "@/core/telemetry";
import type { ToolDefinition } from "@/core/tool";
import {
  findUnreadInputs,
  markInputsAttempted,
  type UnreadInput,
} from "@/core/turn/inbox";
import { reconcileTurn } from "@/core/turn/schedule";
import {
  claimTurn,
  commitStep,
  failTurn,
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

type AdvanceTurnOptions = {
  client: ModelClient;
  /**
   * How core builds the prompt of each model request: the system prompt,
   * and the messages after the history, with the unread inputs where its
   * `inputs()` fragment is.
   */
  prompt: PromptLayout;
  /** Gives the model settings of the claimed Turn, at each step. */
  modelSettings: (turn: ClaimedTurn) => Promise<ModelSettings>;
  /** The tools of the Turn's steps. */
  tools: ToolDefinition[];
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
        await failTurn({ executor }, claim, "attempts_exhausted", {
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
  }: Pick<AdvanceTurnOptions, "client" | "prompt" | "modelSettings" | "tools">,
): Promise<void> {
  const events = await createSqlConversationEventStore(
    executor,
  ).loadCurrentHistory(claim.conversationId);
  setActiveSpanAttributes({
    "app.turn.step_seq": claim.stepSeq,
    "gen_ai.conversation.id": claim.conversationId,
  });
  const history = projectConversationEvents(events).messages;
  const step = await whileLeased({ executor }, claim, (signal) =>
    runStep({
      history,
      // Only a model request builds the prompt and reads the model settings.
      // A tool batch must follow its tool calls, so the inputs wait for the
      // model request after the batch.
      request: async () => ({
        ...(await assemblePrompt(
          prompt,
          { turn: claim, history, inputs: unread },
          { signal },
        )),
        model: await modelSettings(claim),
      }),
      tools,
      client,
      session: claim.conversationId,
      // A later claim of the same step means an earlier attempt did not
      // commit.
      replay: claim.attempts > 1,
      // Tool calls pending at a Turn's first step belong to an earlier Turn.
      skipDanglingToolCalls: claim.stepSeq === 0,
      signal,
    }),
  );
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
      // The capture comes before the commit. A crash between the two runs
      // the step again, so a failure that repeats is captured twice.
      const failure = captureModelFailure(result.reply);
      if (await failTurn({ executor }, claim, result.error, failure)) {
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

/**
 * Reports a failed model request to Sentry the way main reports a provider
 * error, and returns the failure details that `failTurn` stores.
 */
function captureModelFailure(reply: AssistantMessage): TurnFailure {
  const providerError = createAssistantProviderError(reply);
  const eventName = "agent.turn.provider_error";
  const eventId = requireTurnFailureEventId(
    logException(providerError, eventName, {
      ...getProviderErrorAttributes(providerError),
      "app.ai.failure_reason": providerError.kind,
    }),
    eventName,
  );
  return {
    failureCode: "model_execution_failed",
    failureReason: providerError.kind,
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
