import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConversationRunMetrics } from "@/chat/conversations/metrics";
import { publishTurnEnded } from "@/core/turn/ended";
import { stopTurns } from "@/core/turn/schedule";
import { createTurn, TURN_PRIORITY } from "@/core/turn/state";
import { juniorConversationMetrics, juniorTurnInbox } from "@/db/schema";
import {
  replyCutOff,
  setModelReplies,
  streamDisconnected,
} from "../fixtures/ai-emulator";
import { createAssistantMessage } from "../fixtures/model-stream";
import { createTurnHarness, type TurnHarness } from "../fixtures/turn-harness";

// The dashboard metrics of core Turns: the host's Turn-ended consumer
// writes one Run per Turn that ran, keyed by the Turn id.

// Longer than the longest model retry backoff, so every retry is due.
const AFTER_EVERY_BACKOFF_SECONDS = 60;

let harness: TurnHarness;

beforeEach(async () => {
  harness = await createTurnHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
});

function reply(text: string) {
  return createAssistantMessage({ type: "text", text });
}

function runMetrics(turnId: string) {
  return readConversationRunMetrics(harness.engineCtx.executor, {
    conversationId: harness.conversationId,
    runId: turnId,
  });
}

/** Every metric row of the Conversation. */
function metricRows() {
  return harness.engineCtx.executor
    .db()
    .select()
    .from(juniorConversationMetrics)
    .where(eq(juniorConversationMetrics.conversationId, harness.conversationId))
    .orderBy(juniorConversationMetrics.metric);
}

async function actorOf(turnId: string) {
  const [input] = await harness.engineCtx.executor
    .db()
    .select({ actorIdentityId: juniorTurnInbox.actorIdentityId })
    .from(juniorTurnInbox)
    .where(eq(juniorTurnInbox.turnId, turnId));
  return input?.actorIdentityId;
}

describe("Turn metrics", () => {
  it("records a Turn once with its person, counting the replies it dropped, however often it is announced", async () => {
    // Injected fault: the first reply's stream closes, so the Turn pays for a
    // reply that it drops, then retries.
    await setModelReplies([
      streamDisconnected("All done, and nothing is left."),
      reply("Three."),
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { turnId } = await harness.send({ text: "How many Turns?" });
    await harness.runStep();
    harness.queue.advanceTime(AFTER_EVERY_BACKOFF_SECONDS);
    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    const metrics = await runMetrics(turnId);
    expect(metrics).toEqual({
      durationMs: expect.any(Number),
      usage: expect.objectContaining({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        // Only the dropped reply has a cost: the emulator's replies are free.
        cost: { total: expect.any(Number) },
      }),
    });
    expect(metrics?.usage?.cost?.total).toBeGreaterThan(0);
    const rows = await metricRows();
    const actorIdentityId = await actorOf(turnId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual(
      rows.map(() =>
        expect.objectContaining({ runId: turnId, actorIdentityId }),
      ),
    );

    // A rerun of the Turn-ended message, as the delivery sweep sends.
    await publishTurnEnded(harness.engineCtx, {
      conversationId: harness.conversationId,
      turnId,
    });
    await harness.runUntilIdle();

    await expect(runMetrics(turnId)).resolves.toEqual(metrics);
    await expect(metricRows()).resolves.toEqual(rows);
  });

  it("records a failed Turn with the reply that it dropped", async () => {
    await setModelReplies([replyCutOff("Here is the first half")]);
    const { turnId } = await harness.send({ text: "How many Turns?" });

    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "failed",
    });
    const metrics = await runMetrics(turnId);
    expect(metrics?.durationMs).toEqual(expect.any(Number));
    expect(metrics?.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("records a Turn that another Turn superseded", async () => {
    await setModelReplies([reply("Three.")]);
    const { turnId } = await harness.send({ text: "How many Turns?" });
    // While the model writes the reply, an input joins the Turn and another
    // Turn supersedes it, so the Turn ends as superseded at its commit.
    const send = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (...args) => {
      await harness.send({ text: "And how many failed?" });
      await createTurn(harness.engineCtx, {
        conversationId: harness.conversationId,
        priority: TURN_PRIORITY.supersede,
      });
      return send(...args);
    });

    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "cancelled",
      endReason: "superseded",
    });
    const metrics = await runMetrics(turnId);
    expect(metrics?.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("records nothing for a Turn that was stopped before it ran", async () => {
    const { turnId } = await harness.send({ text: "How many Turns?" });
    await stopTurns(harness.engineCtx, harness.conversationId);
    await publishTurnEnded(harness.engineCtx, {
      conversationId: harness.conversationId,
      turnId,
    });

    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "cancelled",
      startedAt: null,
    });
    await expect(metricRows()).resolves.toEqual([]);
  });
});
