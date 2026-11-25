import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueProvider } from "@/chat/queue/provider";
import { claimTurn, createTurn, TURN_PRIORITY } from "@/core/turn/state";
import { sweepTurns } from "@/core/turn/sweep";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import { juniorTurns } from "@/db/schema";
import { setModelReplies } from "../fixtures/ai-emulator";
import { createAssistantMessage } from "../fixtures/model-stream";
import { messageTurnId } from "../fixtures/turn-engine";
import { createTurnHarness, type TurnHarness } from "../fixtures/turn-harness";

// The sweep is the last resort for a Turn whose queue message was lost. Each
// test loses a message the way a crash does, then lets time pass in the
// database, because the sweep only takes Turns that stayed stalled.
describe("Turn sweep", () => {
  let harness: TurnHarness;

  beforeEach(async () => {
    harness = await createTurnHarness();
    await setModelReplies([
      createAssistantMessage({ type: "text", text: "Three." }),
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.close();
  });

  const db = () => harness.engineCtx.executor.db();

  async function onlyTurn() {
    const [turn] = await db()
      .select()
      .from(juniorTurns)
      .where(eq(juniorTurns.conversationId, harness.conversationId));
    return turn!;
  }

  /** Moves a Turn's times back, as if it had waited that long. */
  async function age(turnId: string, minutes: number) {
    const ago = sql`now() - make_interval(mins => ${minutes})`;
    await db()
      .update(juniorTurns)
      .set({
        updatedAt: ago,
        leaseExpiresAt: sql`case when ${juniorTurns.state} = 'running' then ${ago} end`,
      })
      .where(eq(juniorTurns.id, turnId));
  }

  /**
   * Runs the sweep and returns the Turns it sent a step message for, of
   * `turnIds`. The database is shared, so the sweep also finds other tests'
   * stalled Turns. Only the messages of `turnIds` reach this test's queue.
   */
  async function sweep(turnIds: string[]): Promise<string[]> {
    const sent: string[] = [];
    const queue: QueueProvider = {
      messagingSystem: harness.queue.messagingSystem,
      createCallback: (consumer) => harness.queue.createCallback(consumer),
      send: async (topic, payload, options) => {
        const turnId = messageTurnId(payload);
        if (topic !== TURN_STEP_TOPIC || !turnId || !turnIds.includes(turnId)) {
          return {};
        }
        sent.push(turnId);
        return harness.queue.send(topic, payload, options);
      },
    };
    await sweepTurns({ executor: harness.engineCtx.executor, queue });
    return sent;
  }

  /** Leaves the Turn running under a live lease, with no message left for it. */
  async function claimWithoutMessage() {
    const { turnId } = await harness.send({ text: "How many Turns?" });
    await claimTurn(harness.engineCtx, turnId);
    // The step message arrives while the lease holds, so it claims nothing.
    await harness.runStep();
    expect(harness.queue.pending(TURN_STEP_TOPIC)).toEqual([]);
    return turnId;
  }

  it("runs a queued Turn whose step message was lost, once it stayed stalled", async () => {
    // Injected fault: the process dies after scheduleInput commits, before
    // it publishes the step message.
    vi.spyOn(harness.engineCtx.queue, "send").mockRejectedValueOnce(
      new Error("The queue is unreachable"),
    );
    await expect(harness.send({ text: "How many Turns?" })).rejects.toThrow(
      "The queue is unreachable",
    );
    const turn = await onlyTurn();

    await expect(sweep([turn.id])).resolves.toEqual([]);

    await age(turn.id, 10);
    await expect(sweep([turn.id])).resolves.toEqual([turn.id]);
    await harness.runUntilIdle();

    await expect(harness.turn(turn.id)).resolves.toMatchObject({
      state: "completed",
    });
    expect(harness.sends()).toEqual([
      { text: "Three.", destination: harness.destination },
    ]);
  });

  it("takes over a running Turn whose worker died and whose redelivery was lost", async () => {
    const turnId = await claimWithoutMessage();
    await age(turnId, 10);

    await expect(sweep([turnId])).resolves.toEqual([turnId]);
    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    expect(harness.sends()).toEqual([
      { text: "Three.", destination: harness.destination },
    ]);
  });

  it("sends nothing for a queued Turn that waits behind a running one", async () => {
    const runningId = await claimWithoutMessage();
    const running = await harness.turn(runningId);
    const { turnId: waitingId } = await createTurn(harness.engineCtx, {
      conversationId: harness.conversationId,
      actorIdentityId: running.actorIdentityId,
      priority: TURN_PRIORITY.normal,
    });
    await age(waitingId, 10);

    await expect(sweep([runningId, waitingId])).resolves.toEqual([]);
  });
});
