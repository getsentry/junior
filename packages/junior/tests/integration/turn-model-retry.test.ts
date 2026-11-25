import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findUnreadInputs } from "@/core/turn/inbox";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import {
  modelCalls,
  modelOverloaded,
  modelRateLimited,
  modelRejected,
  setModelReplies,
  streamDisconnected,
} from "../fixtures/ai-emulator";
import { createAssistantMessage } from "../fixtures/model-stream";
import {
  MAX_ATTEMPTS,
  messageTurnId,
  storedReply,
  userText,
} from "../fixtures/turn-engine";
import { createTurnHarness, type TurnHarness } from "../fixtures/turn-harness";

let harness: TurnHarness;

/** The delays, in seconds, of the step messages that wait for one Turn. */
function stepDelays(forTurnId: string) {
  return harness.queue
    .pending(TURN_STEP_TOPIC)
    .filter((message) => messageTurnId(message.payload) === forTurnId)
    .map((message) => message.delaySeconds ?? 0);
}

/**
 * Pins the jitter of model retries to `fraction` of its range, so a test
 * knows each wait. 0 gives the wait without jitter.
 */
function pinRetryJitter(fraction: number) {
  vi.spyOn(Math, "random").mockReturnValue(fraction);
}

/** The step messages that wait for a delivery, for one Turn. */
function pendingSteps(forTurnId: string) {
  return harness.queue
    .pending(TURN_STEP_TOPIC)
    .filter((message) => messageTurnId(message.payload) === forTurnId).length;
}

// A failed model request on the real path: an input goes through
// scheduleInput, the host's Turn step consumer runs each step from the
// queue, and the AI emulator injects the failure. A failure that can work
// later queues the Turn again after a backoff; any other one fails it.
describe("advanceTurn after a failed model request", () => {
  beforeEach(async () => {
    harness = await createTurnHarness();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.close();
  });

  it("fails the Turn with a model error that no retry fixes, and writes no history", async () => {
    // Injected fault: the model provider rejects the request.
    await setModelReplies([modelRejected()]);
    const { turnId } = await harness.send({ text: "How many Turns?" });

    await harness.runStep();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "failed",
      endReason: "Invalid request",
      failureCode: "model_execution_failed",
      failureReason: "invalid_request",
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(harness.history()).resolves.toEqual([]);
    expect(pendingSteps(turnId)).toBe(0);
  });

  it("runs the step again after a backoff when the model stream closes mid-reply, and writes the reply once", async () => {
    // Injected fault: the stream closes after the first chunk.
    const reply = createAssistantMessage({ type: "text", text: "Three." });
    await setModelReplies([
      streamDisconnected("All done, and nothing is left."),
      reply,
    ]);
    pinRetryJitter(0);
    const { turnId } = await harness.send({ text: "How many Turns?" });

    await harness.runStep();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "queued",
      attempts: 1,
      stepSeq: 0,
      leaseOwner: null,
    });
    await expect(harness.history()).resolves.toEqual([]);
    expect(stepDelays(turnId)).toEqual([2]);

    harness.queue.advanceTime(2);
    await harness.runStep();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    await expect(modelCalls()).resolves.toEqual([
      expect.objectContaining({ fault: "disconnect" }),
      expect.objectContaining({ fault: "none" }),
    ]);
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      storedReply(reply),
    ]);
  });

  it("backs off longer after each overloaded try, and fails the Turn when its tries run out", async () => {
    // Injected fault: the model provider stays overloaded.
    await setModelReplies(
      Array.from({ length: MAX_ATTEMPTS }, modelOverloaded),
    );
    pinRetryJitter(0);
    const { turnId } = await harness.send({
      text: "How many Turns?",
    });

    const delays: number[] = [];
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await harness.runStep();
      const [delay] = stepDelays(turnId);
      delays.push(delay!);
      harness.queue.advanceTime(delay!);
    }
    await harness.runStep();

    expect(delays).toEqual([2, 4, 8]);
    await expect(modelCalls()).resolves.toHaveLength(MAX_ATTEMPTS);
    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "failed",
      failureCode: "model_execution_failed",
      failureReason: "capacity",
      attempts: MAX_ATTEMPTS,
    });
    await expect(harness.history()).resolves.toEqual([]);
    await expect(findUnreadInputs(harness.engineCtx, turnId)).resolves.toEqual(
      [],
    );
    await expect(harness.events()).resolves.toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          type: "message",
          meta: { replied: false, skippedReason: "failed" },
        }),
      }),
    ]);
    expect(pendingSteps(turnId)).toBe(0);
  });

  it("waits the Retry-After of a rate limit, up to a minute", async () => {
    // Injected fault: the model provider rate limits two requests.
    const reply = createAssistantMessage({ type: "text", text: "Three." });
    await setModelReplies([modelRateLimited(30), modelRateLimited(600), reply]);
    pinRetryJitter(0);
    const { turnId } = await harness.send({ text: "How many Turns?" });

    await harness.runStep();
    expect(stepDelays(turnId)).toEqual([30]);
    harness.queue.advanceTime(30);
    await harness.runStep();
    expect(stepDelays(turnId)).toEqual([60]);
    harness.queue.advanceTime(60);
    await harness.runStep();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
  });

  it("adds up to half of a retry's wait as jitter, also past the one-minute cap", async () => {
    // Injected fault: the model provider is overloaded, then rate limits.
    await setModelReplies([modelOverloaded(), modelRateLimited(600)]);
    pinRetryJitter(0.999);
    const { turnId } = await harness.send({ text: "How many Turns?" });

    await harness.runStep();
    expect(stepDelays(turnId)).toEqual([3]);
    harness.queue.advanceTime(3);
    await harness.runStep();

    expect(stepDelays(turnId)).toEqual([90]);
  });

  it("drops the input when the model step fails, and no Turn answers it", async () => {
    // Injected fault: the model provider rejects the request.
    await setModelReplies([modelRejected()]);
    const { turnId } = await harness.send({
      text: "How many Turns?",
    });

    await harness.runStep();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "failed",
    });
    await expect(harness.history()).resolves.toEqual([]);
    await expect(findUnreadInputs(harness.engineCtx, turnId)).resolves.toEqual(
      [],
    );
    await expect(harness.events()).resolves.toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          type: "message",
          meta: { replied: false, skippedReason: "failed" },
        }),
      }),
    ]);
  });
});
