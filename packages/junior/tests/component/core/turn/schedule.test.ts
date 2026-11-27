import { eq } from "drizzle-orm";
import * as z from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withConversationEventLock } from "@/conversation-events/lock";
import { getQueueProvider } from "@/chat/queue/provider";
import type { EngineContext } from "@/core/engine-context";
import { markInputsAttempted } from "@/core/turn/inbox";
import { TURN_ENDED_TOPIC, TURN_STEP_TOPIC } from "@/core/turn/topic";
import {
  endFailedTurn,
  reconcileTurn,
  scheduleInput,
} from "@/core/turn/schedule";
import {
  claimTurn,
  commitStep,
  failTurn,
  releaseTurn,
  stopTurns,
} from "@/core/turn/state";
import {
  juniorConversations,
  juniorIdentities,
  juniorTurnInbox,
  juniorTurns,
} from "@/db/schema";
import { turnGroupKey } from "@/turn-steps/group-key";
import {
  buildJuniorSqlConversation,
  createJuniorSqlFixture,
  hasJuniorPostgresTestDatabase,
  type LocalJuniorSqlFixture,
} from "../../../fixtures/sql";

const CONVERSATION_ID = "local:conversation-1";
const LOCAL_SOURCE = {
  kind: "local",
  visibility: "private",
  conversationId: CONVERSATION_ID,
} as const;
const WEB_SOURCE = {
  kind: "web",
  visibility: "private",
  conversationId: CONVERSATION_ID,
} as const;
const CONTINUE = { outcome: "continue" as const, messages: [] };

type ScheduledInput = Parameters<typeof scheduleInput>[1];

// Builds the group key the way the host does, so these cases cover Junior's
// rule: one Actor and one Source kind per Turn.
function keyed(input: Omit<ScheduledInput, "groupKey">): ScheduledInput {
  return {
    ...input,
    groupKey: turnGroupKey(input.actorIdentityId, input.source),
  };
}
const LEASE_MS = 60_000;

const stepMessageSchema = z.looseObject({ turnId: z.string() });

/** A step message that the queue took, and what a worker could see then. */
type Publish = { turnId: string; committed: boolean };

// The observer reads on its own connection, so it sees only committed rows,
// as a worker that takes the message does. Postgres fixtures share one
// database per test worker; PGlite fixtures do not.
describe.skipIf(!hasJuniorPostgresTestDatabase())("scheduleInput", () => {
  let fixture: LocalJuniorSqlFixture;
  let engineCtx: EngineContext;
  let observer: LocalJuniorSqlFixture;
  let publishes: Publish[];
  // The Turns whose end message was sent, in send order.
  let ended: string[];

  beforeEach(async () => {
    fixture = await createJuniorSqlFixture();
    engineCtx = {
      executor: fixture.sql,
      queue: getQueueProvider(),
      owner: "worker-a",
      leaseMs: LEASE_MS,
    };
    observer = await createJuniorSqlFixture();
    await fixture.sql
      .db()
      .insert(juniorIdentities)
      .values(
        ["actor", "other"].map((name) => ({
          createdAt: new Date(),
          id: `identity:${name}`,
          kind: "user" as const,
          provider: "local",
          providerSubjectId: name,
          providerTenantId: "",
          updatedAt: new Date(),
        })),
      );
    await fixture.sql
      .db()
      .insert(juniorConversations)
      .values(buildJuniorSqlConversation({ conversationId: CONVERSATION_ID }));
    publishes = [];
    ended = [];
    // The queue is the external edge, so the test takes its sends.
    vi.spyOn(getQueueProvider(), "send").mockImplementation(
      async (topic, payload) => {
        if (topic === TURN_STEP_TOPIC) {
          const { turnId } = stepMessageSchema.parse(payload);
          publishes.push({ turnId, committed: await isCommitted(turnId) });
        } else if (topic === TURN_ENDED_TOPIC) {
          ended.push(stepMessageSchema.parse(payload).turnId);
        }
        return {};
      },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await observer.close();
    await fixture.close();
  });

  async function isCommitted(turnId: string): Promise<boolean> {
    const [turns, inputs] = await Promise.all([
      observer.sql
        .db()
        .select({ id: juniorTurns.id })
        .from(juniorTurns)
        .where(eq(juniorTurns.id, turnId)),
      observer.sql
        .db()
        .select({ id: juniorTurnInbox.id })
        .from(juniorTurnInbox)
        .where(eq(juniorTurnInbox.turnId, turnId)),
    ]);
    return turns.length === 1 && inputs.length > 0;
  }

  function input(idempotencyKey: string): Omit<ScheduledInput, "groupKey"> {
    return {
      conversationId: CONVERSATION_ID,
      actorIdentityId: "identity:actor",
      payload: { text: `Message ${idempotencyKey}` },
      idempotencyKey,
      sentAt: new Date("2026-11-21T08:00:00.000Z"),
      source: LOCAL_SOURCE,
      destination: null,
      delivery: "interrupt",
    };
  }

  function schedule(idempotencyKey: string) {
    return scheduleInput(engineCtx, keyed(input(idempotencyKey)));
  }

  async function claim(turnId: string) {
    return (await claimTurn(engineCtx, turnId))!;
  }

  async function readTurns() {
    return fixture.sql
      .db()
      .select({
        id: juniorTurns.id,
        state: juniorTurns.state,
        priority: juniorTurns.priority,
      })
      .from(juniorTurns);
  }

  async function readEnd(turnId: string) {
    const [turn] = await fixture.sql
      .db()
      .select({
        state: juniorTurns.state,
        endReason: juniorTurns.endReason,
        priority: juniorTurns.priority,
      })
      .from(juniorTurns)
      .where(eq(juniorTurns.id, turnId));
    return turn;
  }

  function interruptFrom(actorIdentityId: string, idempotencyKey: string) {
    return scheduleInput(
      engineCtx,
      keyed({
        ...input(idempotencyKey),
        actorIdentityId,
      }),
    );
  }

  async function readInputs() {
    return fixture.sql
      .db()
      .select({
        turnId: juniorTurnInbox.turnId,
        idempotencyKey: juniorTurnInbox.idempotencyKey,
      })
      .from(juniorTurnInbox)
      .orderBy(juniorTurnInbox.createdAt);
  }

  it("starts a Turn with the first input and publishes it after the commit", async () => {
    const scheduled = await schedule("event-1");

    expect(scheduled).toEqual({
      turnId: expect.any(String),
      created: true,
      duplicate: false,
    });
    await expect(readTurns()).resolves.toEqual([
      {
        id: scheduled.turnId,
        state: "queued",
        priority: 1,
      },
    ]);
    await expect(readInputs()).resolves.toEqual([
      { turnId: scheduled.turnId, idempotencyKey: "event-1" },
    ]);
    await expect(
      fixture.sql
        .db()
        .select({ source: juniorTurnInbox.source })
        .from(juniorTurnInbox),
    ).resolves.toEqual([{ source: LOCAL_SOURCE }]);
    expect(publishes).toEqual([{ turnId: scheduled.turnId, committed: true }]);
  });

  it("adds a second input to the open Turn without a publish", async () => {
    const first = await schedule("event-1");

    await expect(schedule("event-2")).resolves.toEqual({
      turnId: first.turnId,
      created: false,
      duplicate: false,
    });
    await expect(readTurns()).resolves.toHaveLength(1);
    await expect(readInputs()).resolves.toEqual([
      { turnId: first.turnId, idempotencyKey: "event-1" },
      { turnId: first.turnId, idempotencyKey: "event-2" },
    ]);
    expect(publishes).toHaveLength(1);
  });

  it("holds a new Turn for its start delay, so an input in that time joins it", async () => {
    const first = await scheduleInput(engineCtx, {
      ...keyed(input("event-1")),
      startDelayMs: 30_000,
    });
    const second = await scheduleInput(engineCtx, {
      ...keyed(input("event-2")),
      startDelayMs: 30_000,
    });

    expect(second).toMatchObject({ turnId: first.turnId, created: false });
    expect(vi.mocked(getQueueProvider().send).mock.calls).toEqual([
      [
        TURN_STEP_TOPIC,
        expect.anything(),
        expect.objectContaining({ delaySeconds: 30 }),
      ],
    ]);
  });

  it("joins an interrupt from the same Actor and Source to the started Turn", async () => {
    const first = await schedule("event-1");
    await claim(first.turnId);

    await expect(schedule("event-2")).resolves.toEqual({
      turnId: first.turnId,
      created: false,
      duplicate: false,
    });
    expect(publishes).toHaveLength(1);
  });

  it("puts a deferred input in a new Turn while the Turn runs, and joins the next one to it", async () => {
    const first = await schedule("event-1");
    await claim(first.turnId);
    publishes = [];

    const deferred = await scheduleInput(
      engineCtx,
      keyed({
        ...input("event-2"),
        delivery: "defer",
      }),
    );
    await expect(
      scheduleInput(
        engineCtx,
        keyed({ ...input("event-3"), delivery: "defer" }),
      ),
    ).resolves.toEqual({
      turnId: deferred.turnId,
      created: false,
      duplicate: false,
    });

    expect(deferred).toEqual({
      turnId: expect.any(String),
      created: true,
      duplicate: false,
    });
    expect(deferred.turnId).not.toBe(first.turnId);
    expect(publishes).toEqual([]);
  });

  it("queues an input from another Actor or Source in its own Turn, so A1 B1 A2 makes A2 wait", async () => {
    const a1 = await schedule("event-1");
    const b1 = await scheduleInput(
      engineCtx,
      keyed({
        ...input("event-2"),
        actorIdentityId: "identity:other",
      }),
    );
    const a2 = await schedule("event-3");
    const web = await scheduleInput(
      engineCtx,
      keyed({
        ...input("event-4"),
        source: WEB_SOURCE,
      }),
    );

    expect(new Set([a1, b1, a2, web].map((turn) => turn.turnId)).size).toBe(4);
    expect(publishes).toEqual([{ turnId: a1.turnId, committed: true }]);
  });

  it("keeps inputs with different group keys in separate Turns, even from one Actor and Source", async () => {
    const first = await schedule("event-1");

    const other = await scheduleInput(engineCtx, {
      ...input("event-2"),
      groupKey: "host:other-group",
    });

    expect(other).toEqual({
      turnId: expect.any(String),
      created: true,
      duplicate: false,
    });
    expect(other.turnId).not.toBe(first.turnId);
  });

  it("claims only the next Turn, and publishes the next one when a Turn ends", async () => {
    const first = await schedule("event-1");
    const second = await scheduleInput(
      engineCtx,
      keyed({
        ...input("event-2"),
        actorIdentityId: "identity:other",
      }),
    );

    await expect(claimTurn(engineCtx, second.turnId)).resolves.toBeUndefined();
    const running = await claim(first.turnId);
    await expect(claimTurn(engineCtx, second.turnId)).resolves.toBeUndefined();

    await failTurn(engineCtx, running, "overloaded", {
      failureCode: "model_execution_failed",
    });
    publishes = [];
    await reconcileTurn(engineCtx, first.turnId);

    expect(publishes).toEqual([{ turnId: second.turnId, committed: true }]);
    await expect(claimTurn(engineCtx, second.turnId)).resolves.toMatchObject({
      turnId: second.turnId,
    });
  });

  it("supersedes a running Turn for an interrupt from another Actor, and ends it when its step commits", async () => {
    const alice = await schedule("event-1");
    const running = await claim(alice.turnId);
    publishes = [];

    const deferred = await scheduleInput(
      engineCtx,
      keyed({
        ...input("event-2"),
        actorIdentityId: "identity:other",
        delivery: "defer",
      }),
    );
    const bob = await interruptFrom("identity:other", "event-3");

    expect(publishes).toEqual([{ turnId: bob.turnId, committed: true }]);
    await expect(readEnd(bob.turnId)).resolves.toMatchObject({ priority: 0 });
    await expect(claimTurn(engineCtx, bob.turnId)).resolves.toBeUndefined();
    await expect(commitStep(engineCtx, running, CONTINUE, [])).resolves.toBe(
      "superseded",
    );
    await expect(readEnd(alice.turnId)).resolves.toMatchObject({
      state: "cancelled",
      endReason: "superseded",
    });
    await expect(readEnd(deferred.turnId)).resolves.toMatchObject({
      state: "queued",
    });
    await expect(claimTurn(engineCtx, bob.turnId)).resolves.toMatchObject({
      turnId: bob.turnId,
    });
  });

  it("ends a superseded Turn at once when it waits between steps, and says it ended", async () => {
    const alice = await schedule("event-1");
    await commitStep(engineCtx, await claim(alice.turnId), CONTINUE, []);
    publishes = [];

    const bob = await interruptFrom("identity:other", "event-2");

    await expect(readEnd(alice.turnId)).resolves.toMatchObject({
      state: "cancelled",
      endReason: "superseded",
    });
    expect(ended).toEqual([alice.turnId]);
    expect(publishes).toEqual([{ turnId: bob.turnId, committed: true }]);
    await expect(claimTurn(engineCtx, bob.turnId)).resolves.toMatchObject({
      turnId: bob.turnId,
    });
  });

  it("ends a superseded Turn whose step fails", async () => {
    const alice = await schedule("event-1");
    const running = await claim(alice.turnId);
    await interruptFrom("identity:other", "event-2");

    await expect(releaseTurn(engineCtx, running)).resolves.toBe("cancelled");

    await expect(readEnd(alice.turnId)).resolves.toMatchObject({
      state: "cancelled",
      endReason: "superseded",
    });
  });

  it("sends later inputs past a superseded Turn", async () => {
    const alice = await schedule("event-1");
    await claim(alice.turnId);
    const bob = await interruptFrom("identity:other", "event-2");

    const bobAgain = await interruptFrom("identity:other", "event-3");
    const aliceAgain = await interruptFrom("identity:actor", "event-4");

    expect([alice.turnId, bob.turnId]).not.toContain(aliceAgain.turnId);
    expect(bobAgain.turnId).toBe(bob.turnId);
  });

  it("lets a superseding Turn be superseded in turn", async () => {
    const alice = await schedule("event-1");
    const runningAlice = await claim(alice.turnId);
    const bob = await interruptFrom("identity:other", "event-2");
    await commitStep(engineCtx, runningAlice, CONTINUE, []);
    const runningBob = await claim(bob.turnId);

    const aliceAgain = await interruptFrom("identity:actor", "event-3");

    await expect(readEnd(bob.turnId)).resolves.toMatchObject({ priority: 1 });
    await expect(commitStep(engineCtx, runningBob, CONTINUE, [])).resolves.toBe(
      "superseded",
    );
    await expect(
      claimTurn(engineCtx, aliceAgain.turnId),
    ).resolves.toMatchObject({ turnId: aliceAgain.turnId });
  });

  it("waits for the Conversation lock before it claims a Turn", async () => {
    const turn = await schedule("event-1");
    let claimed: Awaited<ReturnType<typeof claimTurn>> | "pending" = "pending";
    let claiming: Promise<void> | undefined;

    // The observer holds the lock the way scheduleInput does while it places
    // an input, so the claim cannot start the Turn in between.
    await observer.sql.transaction(() =>
      withConversationEventLock(observer.sql, CONVERSATION_ID, async () => {
        claiming = claimTurn(engineCtx, turn.turnId).then((result) => {
          claimed = result;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(claimed).toBe("pending");
      }),
    );
    await claiming;

    expect(claimed).toMatchObject({ turnId: turn.turnId });
  });

  it("refuses an input row whose group key differs from its Turn's other inputs", async () => {
    const local = await schedule("event-1");
    await scheduleInput(
      engineCtx,
      keyed({ ...input("event-2"), source: WEB_SOURCE }),
    );

    await expect(
      fixture.sql
        .db()
        .update(juniorTurnInbox)
        .set({ turnId: local.turnId })
        .where(eq(juniorTurnInbox.idempotencyKey, "event-2")),
    ).rejects.toMatchObject({
      cause: { constraint: "junior_turn_inbox_one_group" },
    });
  });

  it("writes nothing for a duplicate input, and publishes its Turn again only while it is queued", async () => {
    const first = await schedule("event-1");
    const duplicate = {
      turnId: first.turnId,
      created: false,
      duplicate: true,
    };

    await expect(schedule("event-1")).resolves.toEqual(duplicate);
    expect(publishes).toHaveLength(2);

    await claimTurn(engineCtx, first.turnId);
    await expect(schedule("event-1")).resolves.toEqual(duplicate);

    await stopTurns(engineCtx, CONVERSATION_ID);
    await expect(schedule("event-1")).resolves.toEqual(duplicate);

    expect(publishes).toHaveLength(2);
    await expect(readTurns()).resolves.toHaveLength(1);
    await expect(readInputs()).resolves.toHaveLength(1);
  });

  it("keeps the Turn and its input when the publish fails, and the retry publishes it", async () => {
    // Injected fault: the queue rejects the send after the commit.
    vi.mocked(getQueueProvider().send).mockRejectedValueOnce(
      new Error("Queue unavailable"),
    );

    await expect(schedule("event-1")).rejects.toThrow("Queue unavailable");
    const [turn] = await readTurns();
    expect(turn).toMatchObject({ state: "queued" });
    await expect(readInputs()).resolves.toEqual([
      { turnId: turn!.id, idempotencyKey: "event-1" },
    ]);

    // The source retries the same input.
    await expect(schedule("event-1")).resolves.toEqual({
      turnId: turn!.id,
      created: false,
      duplicate: true,
    });
    expect(publishes).toEqual([{ turnId: turn!.id, committed: true }]);
  });

  it("moves a failed Turn's unclaimed inputs to a new Turn in the fail commit, and reconcileTurn publishes it", async () => {
    const failed = await schedule("event-1");
    const claimed = await claim(failed.turnId);
    await schedule("event-2");
    const fail = () =>
      endFailedTurn(engineCtx, claimed, "overloaded", {
        failureCode: "model_execution_failed",
      });

    await expect(fail()).resolves.toBe(true);

    const next = (await readTurns()).find((turn) => turn.id !== failed.turnId);
    expect(next).toEqual({
      id: expect.any(String),
      state: "queued",
      priority: 1,
    });
    const moved = [
      { turnId: next!.id, idempotencyKey: "event-1" },
      { turnId: next!.id, idempotencyKey: "event-2" },
    ];
    await expect(readInputs()).resolves.toEqual(moved);
    publishes = [];

    await reconcileTurn(engineCtx, failed.turnId);
    expect(publishes).toEqual([{ turnId: next!.id, committed: true }]);

    // The lease is gone, so a second fail changes nothing.
    await expect(fail()).resolves.toBe(false);
    await expect(readTurns()).resolves.toHaveLength(2);
    await expect(readInputs()).resolves.toEqual(moved);
  });

  it("moves a failed Turn's unclaimed inputs to the open Turn when one exists", async () => {
    const failed = await schedule("event-1");
    const claimed = await claim(failed.turnId);
    await schedule("event-2");
    const open = await scheduleInput(
      engineCtx,
      keyed({
        ...input("event-3"),
        delivery: "defer",
      }),
    );

    await endFailedTurn(engineCtx, claimed, "overloaded", {
      failureCode: "model_execution_failed",
    });

    await expect(readTurns()).resolves.toHaveLength(2);
    await expect(readInputs()).resolves.toEqual([
      { turnId: open.turnId, idempotencyKey: "event-1" },
      { turnId: open.turnId, idempotencyKey: "event-2" },
      { turnId: open.turnId, idempotencyKey: "event-3" },
    ]);
  });

  it("moves nothing for a completed Turn", async () => {
    const completed = await schedule("event-1");
    await fixture.sql
      .db()
      .update(juniorTurns)
      .set({ state: "completed", endedAt: new Date() })
      .where(eq(juniorTurns.id, completed.turnId));

    await reconcileTurn(engineCtx, completed.turnId);

    await expect(readInputs()).resolves.toEqual([
      { turnId: completed.turnId, idempotencyKey: "event-1" },
    ]);
    expect(publishes).toHaveLength(1);
  });

  it("says a cancelled Turn ended, and reconcileTurn leaves its inputs on it", async () => {
    const cancelled = await schedule("event-1");

    await stopTurns(engineCtx, CONVERSATION_ID);
    await reconcileTurn(engineCtx, cancelled.turnId);

    expect(publishes).toEqual([{ turnId: cancelled.turnId, committed: true }]);
    expect(ended).toEqual([cancelled.turnId, cancelled.turnId]);
    await expect(readTurns()).resolves.toHaveLength(1);
    await expect(readInputs()).resolves.toEqual([
      { turnId: cancelled.turnId, idempotencyKey: "event-1" },
    ]);
  });

  it("stops the running Turn and the Turn queued behind it, so no Turn starts", async () => {
    const running = await schedule("event-1");
    await claim(running.turnId);
    const queued = await scheduleInput(
      engineCtx,
      keyed({
        ...input("event-2"),
        actorIdentityId: "identity:other",
        delivery: "defer",
      }),
    );
    publishes = [];

    const stopped = await stopTurns(engineCtx, CONVERSATION_ID);
    await reconcileTurn(engineCtx, running.turnId);

    expect([...stopped].sort()).toEqual([running.turnId, queued.turnId].sort());
    await expect(readEnd(running.turnId)).resolves.toMatchObject({
      state: "cancelled",
    });
    await expect(readEnd(queued.turnId)).resolves.toMatchObject({
      state: "cancelled",
    });
    expect([...ended].sort()).toEqual(
      [running.turnId, queued.turnId, running.turnId].sort(),
    );
    // reconcileTurn found no Turn to start.
    expect(publishes).toEqual([]);
  });

  it("keeps the first attempt time of an input", async () => {
    await schedule("event-1");
    const [input] = await fixture.sql
      .db()
      .select({ id: juniorTurnInbox.id })
      .from(juniorTurnInbox);
    const readAttemptedAt = async () =>
      (
        await fixture.sql
          .db()
          .select({ attemptedAt: juniorTurnInbox.attemptedAt })
          .from(juniorTurnInbox)
      )[0]!.attemptedAt;

    await markInputsAttempted(engineCtx, [input!.id]);
    const first = await readAttemptedAt();
    // A later attempt has a later now().
    await new Promise((resolve) => setTimeout(resolve, 10));
    await markInputsAttempted(engineCtx, [input!.id]);

    expect(first).toBeInstanceOf(Date);
    await expect(readAttemptedAt()).resolves.toEqual(first);
  });
});
